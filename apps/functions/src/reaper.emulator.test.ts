import { randomUUID } from 'node:crypto';
import { paths } from '@dodo/core';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import type { Auth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import type { Storage } from 'firebase-admin/storage';
import { afterAll, describe, expect, it } from 'vitest';
import { finish, reapStaleRuns } from './run-control.js';
import { costGateFor, LEASE_MS } from './runtime.js';

const enabled = !!process.env.FIRESTORE_EMULATOR_HOST;
const app = enabled ? initializeApp({ projectId: 'demo-dodo' }, 'reaper-test') : undefined;
const db = app ? getFirestore(app) : undefined;

const storage = {
  bucket: () => ({
    file: () => ({ save: async () => {}, download: async () => [Buffer.from('[]')] }),
  }),
} as unknown as Storage;
const auth = { deleteUser: async () => {} } as unknown as Auth;

/** The scheduled sweep ends runs whose worker stopped heartbeating, and only those. */
describe.skipIf(!enabled)('reapStaleRuns', () => {
  afterAll(async () => {
    if (app) await deleteApp(app);
  });

  async function seed(leaseExpiresAt: number, patch: Record<string, unknown> = {}) {
    const d = db as NonNullable<typeof db>;
    const taskId = `t-${randomUUID()}`;
    const runId = `r-${randomUUID()}`;
    await d.doc(paths.task(taskId)).set({
      title: 'Reap me',
      status: 'in_progress',
      ai: { enabled: true, device: 'remote' },
      activeRunId: runId,
      createdAt: 1,
      updatedAt: 1,
    });
    await d.doc(paths.run(runId)).set({
      taskId,
      device: 'remote',
      model: 'gemini-3.8-flash',
      state: 'running',
      trigger: 'new',
      generation: 1,
      interrupt: false,
      compact: false,
      attempts: 1,
      sessionPath: paths.sessionBlob(runId),
      spent: 0,
      steps: 1,
      lease: { expiresAt: leaseExpiresAt },
      createdAt: 1,
      updatedAt: 1,
      ...patch,
    });
    return { taskId, runId };
  }

  it('ends a run whose lease expired and releases its task; leaves a live run alone', async () => {
    const d = db as NonNullable<typeof db>;
    const now = Date.now();
    const dead = await seed(now - 3 * LEASE_MS);
    const live = await seed(now + LEASE_MS);

    const reaped = await reapStaleRuns({
      db: d,
      auth,
      storage,
      costGate: costGateFor(d),
      now: () => now,
    });
    expect(reaped).toContain(dead.runId);
    expect(reaped).not.toContain(live.runId);

    const deadRun = (await d.doc(paths.run(dead.runId)).get()).data();
    expect(deadRun?.state).not.toBe('running');
    const deadTask = (await d.doc(paths.task(dead.taskId)).get()).data();
    expect(deadTask?.activeRunId).toBeUndefined();

    const liveRun = (await d.doc(paths.run(live.runId)).get()).data();
    expect(liveRun?.state).toBe('running');
  });

  it('leaves a run queued for an offline Mac waiting', async () => {
    const d = db as NonNullable<typeof db>;
    const now = Date.now();
    const queued = await seed(now - 3 * LEASE_MS, { state: 'queued', device: 'mac:studio' });
    const reaped = await reapStaleRuns({
      db: d,
      auth,
      storage,
      costGate: costGateFor(d),
      now: () => now,
    });
    expect(reaped).not.toContain(queued.runId);
    expect((await d.doc(paths.run(queued.runId)).get()).get('state')).toBe('queued');
  });

  it('ends a run once: a second finish (the reaper after the worker) changes nothing', async () => {
    const d = db as NonNullable<typeof db>;
    const now = Date.now();
    const { taskId, runId } = await seed(now + LEASE_MS);
    const deps = { db: d, auth, storage, costGate: costGateFor(d), now: () => now };
    const run = { id: runId, ...(await d.doc(paths.run(runId)).get()).data() } as Parameters<
      typeof finish
    >[1];
    await finish(deps, run, { reason: 'finished', outcome: 'review', session: [] });
    await finish(deps, run, { reason: 'lease_lost', error: 'late reaper', session: [] });
    const after = (await d.doc(paths.run(runId)).get()).data();
    expect(after?.state).toBe('succeeded');
    expect(after?.endReason).toBe('finished');
    const task = (await d.doc(paths.task(taskId)).get()).data();
    expect(task?.status).toBe('review');
    const failures = await d
      .collection(paths.messages(taskId))
      .where('author', '==', 'system')
      .get();
    expect(failures.size).toBe(0);
  });
});
