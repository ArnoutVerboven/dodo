import { randomUUID } from 'node:crypto';
import { monthKey } from '@dodo/budget';
import { paths, type Run, type Standby } from '@dodo/core';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import type { Auth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DispatcherDeps, dispatch } from './dispatcher.js';
import {
  cancelStandbys,
  ensureStandby,
  prepareRun,
  STANDBY_WAIT_MS,
  type StandbyDeps,
  standbyReserve,
  sweepStandbys,
  TAKEOVER_GRACE_MS,
} from './standby.js';

const enabled = !!process.env.FIRESTORE_EMULATOR_HOST;
const app = enabled ? initializeApp({ projectId: 'demo-dodo' }, 'standby-test') : undefined;
const db = app ? getFirestore(app) : undefined;

/**
 * A standby worker waits in its container for the next remote run. What must hold: the run is
 * handed to it and no new container starts; only one waits at a time; the month's cap stops new
 * ones; an expired or never-started standby is cleaned up and its run gets a fresh container.
 */
describe.skipIf(!enabled)('standby workers', () => {
  const d = () => db as NonNullable<typeof db>;
  const T0 = Date.UTC(2026, 10, 28, 12, 0, 0);
  let clock = T0;
  const now = () => clock;
  const auth = {
    createCustomToken: vi.fn(async (uid: string) => `token-for-${uid}`),
  } as unknown as Auth;

  function deps(over: Partial<StandbyDeps> = {}) {
    const startStandby = vi.fn(
      async () => `projects/p/locations/l/jobs/j/executions/e-${randomUUID()}`,
    );
    const cancel = vi.fn(async () => {});
    return {
      deps: { db: d(), auth, executor: { startStandby, cancel }, now, ...over } as StandbyDeps,
      startStandby,
      cancel,
    };
  }

  function dispatchDeps(start = vi.fn(async () => 'fresh-execution')): DispatcherDeps {
    return {
      db: d(),
      auth,
      costGate: { available: async () => 1_000_000 } as unknown as DispatcherDeps['costGate'],
      executor: { start },
      now,
    };
  }

  async function queuedRun(device = 'gcp') {
    const taskId = `t-${randomUUID()}`;
    const runId = `r-${randomUUID()}`;
    await d()
      .doc(paths.task(taskId))
      .set({
        title: 'x',
        status: 'in_progress',
        ai: { enabled: true },
        activeRunId: runId,
        createdAt: clock,
        updatedAt: clock,
      });
    await d().doc(paths.run(runId)).set({
      taskId,
      device,
      model: 'gemini-3.8-flash',
      state: 'queued',
      trigger: 'new',
      generation: 0,
      interrupt: false,
      compact: false,
      attempts: 0,
      spent: 0,
      steps: 0,
      createdAt: clock,
      updatedAt: clock,
    });
    return { taskId, runId };
  }

  const standby = async (id: string) =>
    ({ id, ...(await d().doc(paths.standby(id)).get()).data() }) as Standby;
  const run = async (id: string) => (await d().doc(paths.run(id)).get()).data() as Run;
  const spent = async () =>
    ((
      await d()
        .doc(paths.standbyUsage(monthKey(T0)))
        .get()
    ).get('spent') as number) ?? 0;

  async function clear() {
    for (const c of [paths.standbys(), 'standbyUsage']) {
      const all = await d().collection(c).get();
      await Promise.all(all.docs.map((x) => x.ref.delete()));
    }
  }
  beforeEach(async () => {
    clock = T0;
    await clear();
  });
  afterAll(async () => {
    if (db) await clear();
    if (app) await deleteApp(app);
  });

  it('hands the next remote run to the waiting standby: no new container starts', async () => {
    const { deps: s, startStandby } = deps();
    const started = await ensureStandby(s);
    expect(started.state).toBe('started');
    const id = (started as { id: string }).id;
    expect(startStandby).toHaveBeenCalledOnce();
    // Its environment: who it is, until when it waits, and Cloud Run's own hard stop.
    const [env, timeoutS] = startStandby.mock.calls[0] as unknown as [
      Record<string, string>,
      number,
    ];
    expect(env).toMatchObject({
      DODO_STANDBY_ID: id,
      DODO_STANDBY_TOKEN: `token-for-standby:${id}`,
      DODO_STANDBY_UNTIL: String(T0 + STANDBY_WAIT_MS),
    });
    expect(timeoutS).toBe(STANDBY_WAIT_MS / 1000 + 3600 + 60);
    expect(await spent()).toBe(standbyReserve());

    clock = T0 + 120_000; // two minutes of writing
    const { runId } = await queuedRun();
    const start = vi.fn(async () => 'fresh-execution');
    expect(await dispatch(dispatchDeps(start), runId)).toBe('started');

    expect(start).not.toHaveBeenCalled();
    const r = await run(runId);
    expect(r).toMatchObject({ state: 'claimed', standbyId: id, generation: 1 });
    expect(r.execution).toBe((await standby(id)).execution);
    const sb = await standby(id);
    expect(sb).toMatchObject({ state: 'assigned', runId, assignedAt: clock });
    expect(sb.runToken).toBe(`token-for-run:${runId}`);
    expect(sb.timeoutSeconds).toBeGreaterThanOrEqual(60);
    // Charged only for the two minutes it waited: the other eight go back to the month.
    expect(await spent()).toBe(standbyReserve() - Math.floor(standbyReserve() * 0.8));
  });

  it('runs one standby at a time: a second request reuses the waiting one', async () => {
    const { deps: s, startStandby } = deps();
    const a = await ensureStandby(s);
    clock = T0 + 60_000;
    const b = await ensureStandby(s);
    expect(b).toEqual({ state: 'reused', id: (a as { id: string }).id });
    expect(startStandby).toHaveBeenCalledOnce();
    // Nearly out of time: a fresh one starts instead.
    clock = T0 + STANDBY_WAIT_MS - 60_000;
    expect((await ensureStandby(s)).state).toBe('started');
    expect(startStandby).toHaveBeenCalledTimes(2);
  });

  it('stops at the monthly cap: no standby starts, and runs start the usual way', async () => {
    const { deps: s, startStandby } = deps({ capMicro: standbyReserve() * 2 });
    expect((await ensureStandby(s)).state).toBe('started');
    await cancelStandbys({ ...s, now: () => T0 + STANDBY_WAIT_MS }); // waited it all out
    expect((await ensureStandby(s)).state).toBe('started');
    await cancelStandbys({ ...s, now: () => T0 + STANDBY_WAIT_MS });
    expect(await ensureStandby(s)).toEqual({ state: 'over_budget' });
    expect(startStandby).toHaveBeenCalledTimes(2);
    expect(await spent()).toBeLessThanOrEqual(standbyReserve() * 2);

    const { runId } = await queuedRun();
    const start = vi.fn(async () => 'fresh-execution');
    await dispatch(dispatchDeps(start), runId);
    expect(start).toHaveBeenCalledOnce();
    expect((await run(runId)).standbyId).toBeUndefined();
  });

  it('starts nothing while the kill switch has halted spending', async () => {
    await d().doc(paths.settings()).set({ halted: true }, { merge: true });
    try {
      const { deps: s, startStandby } = deps();
      expect(await ensureStandby(s)).toEqual({ state: 'halted' });
      expect(startStandby).not.toHaveBeenCalled();
    } finally {
      await d().doc(paths.settings()).set({ halted: false }, { merge: true });
    }
  });

  it('cancelling (the form closed) stops it, cancels the execution and refunds the rest', async () => {
    const { deps: s, cancel } = deps();
    const { id } = (await ensureStandby(s)) as { id: string };
    clock = T0 + 60_000;
    expect(await cancelStandbys(s)).toBe(1);
    expect((await standby(id)).state).toBe('cancelled');
    expect(cancel).toHaveBeenCalledWith((await standby(id)).execution);
    expect(await spent()).toBe(standbyReserve() - Math.floor(standbyReserve() * 0.9));
    // A cancelled standby takes no run.
    const { runId } = await queuedRun();
    const start = vi.fn(async () => 'fresh-execution');
    await dispatch(dispatchDeps(start), runId);
    expect(start).toHaveBeenCalledOnce();
  });

  it('does not hand a run to a standby about to exit, or one that never came up', async () => {
    const { deps: s } = deps();
    await ensureStandby(s);
    clock = T0 + STANDBY_WAIT_MS - 10_000; // 10 s left
    const { runId } = await queuedRun();
    const start = vi.fn(async () => 'fresh-execution');
    await dispatch(dispatchDeps(start), runId);
    expect(start).toHaveBeenCalledOnce();

    await clear();
    clock = T0;
    await ensureStandby(s);
    clock = T0 + 5 * 60_000; // never said it listens, five minutes on: it did not start
    const second = await queuedRun();
    const start2 = vi.fn(async () => 'fresh-execution');
    await dispatch(dispatchDeps(start2), second.runId);
    expect(start2).toHaveBeenCalledOnce();
  });

  it('sweeps: an expired standby is marked and cancelled; a run it never took starts afresh', async () => {
    const { deps: s, cancel } = deps();
    const a = (await ensureStandby(s)) as { id: string };
    const { runId } = await queuedRun();
    clock = T0 + 30_000;
    await dispatch(dispatchDeps(), runId);
    expect((await standby(a.id)).state).toBe('assigned');

    // A second standby that nobody used, past its time.
    clock = T0 + STANDBY_WAIT_MS - 100_000;
    const b = (await ensureStandby(s)) as { id: string };
    clock = T0 + 2 * STANDBY_WAIT_MS;
    const start = vi.fn(async () => 'fresh-execution');
    const swept = await sweepStandbys({
      ...s,
      redispatch: (id) => dispatch({ ...dispatchDeps(start), useStandby: false }, id),
    });
    expect(swept.expired).toEqual([b.id]);
    expect(swept.requeued).toEqual([runId]);
    expect((await standby(b.id)).state).toBe('expired');
    expect((await standby(a.id)).state).toBe('expired');
    expect((await standby(a.id)).runToken).toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(2);
    // The run got a new container and a new generation (the old token is dead).
    expect(start).toHaveBeenCalledOnce();
    expect(await run(runId)).toMatchObject({
      state: 'claimed',
      execution: 'fresh-execution',
      generation: 2,
    });
    expect((await run(runId)).standbyId).toBeUndefined();
  });

  it('leaves a run its standby started alone', async () => {
    const { deps: s } = deps();
    const a = (await ensureStandby(s)) as { id: string };
    const { runId } = await queuedRun();
    await dispatch(dispatchDeps(), runId);
    await d()
      .doc(paths.run(runId))
      .update({ state: 'running', lease: { owner: `run:${runId}`, expiresAt: clock + 60_000 } });
    clock += TAKEOVER_GRACE_MS + 1;
    const redispatch = vi.fn(async () => {});
    const swept = await sweepStandbys({ ...s, redispatch });
    expect(swept.requeued).toEqual([]);
    expect(redispatch).not.toHaveBeenCalled();
    expect((await standby(a.id)).state).toBe('expired');
    expect((await run(runId)).state).toBe('running');
  });

  it('prepare: remote starts a standby, a live run needs nothing, a Mac on the local model warms up', async () => {
    const { deps: s, startStandby } = deps();
    expect((await prepareRun(s, { draft: { ai: { device: 'gcp' } } })).state).toBe('started');
    expect(startStandby).toHaveBeenCalledOnce();

    // A task whose run still holds for the answer: the answer reaches that run directly.
    const { taskId, runId } = await queuedRun();
    await d().doc(paths.run(runId)).update({ state: 'running' });
    expect(await prepareRun(s, { taskId })).toEqual({ state: 'live' });

    const deviceId = `mac-${randomUUID()}`;
    await d().doc(paths.device(deviceId)).set({
      name: 'Mac',
      state: 'approved',
      lastSeen: clock,
      folders: [],
      createdAt: 1,
      updatedAt: 1,
    });
    try {
      const r = await prepareRun(s, {
        draft: { ai: { device: `mac:${deviceId}`, model: 'local' } },
      });
      expect(r).toEqual({ state: 'warming', deviceId });
      expect((await d().doc(paths.device(deviceId)).get()).get('warmUpAt')).toBe(clock);
      // A Mac run on a cloud model needs nothing prepared.
      expect(await prepareRun(s, { draft: { ai: { device: `mac:${deviceId}` } } })).toEqual({
        state: 'mac',
      });
    } finally {
      await d().doc(paths.device(deviceId)).delete();
    }
    expect(startStandby).toHaveBeenCalledOnce();
  });
});
