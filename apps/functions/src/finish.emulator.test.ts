import { randomUUID } from 'node:crypto';
import { type FinishRequest, paths, type Run } from '@dodo/core';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import type { Auth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import type { Storage } from 'firebase-admin/storage';
import { afterAll, describe, expect, it } from 'vitest';
import { finish, type Notify } from './run-control.js';
import { costGateFor } from './runtime.js';

const enabled = !!process.env.FIRESTORE_EMULATOR_HOST;
const app = enabled ? initializeApp({ projectId: 'demo-dodo' }, 'finish-test') : undefined;
const db = app ? getFirestore(app) : undefined;

const storage = {
  bucket: () => ({
    file: () => ({ save: async () => {}, download: async () => [Buffer.from('[]')] }),
  }),
} as unknown as Storage;
const auth = { deleteUser: async () => {} } as unknown as Auth;

/**
 * Where a task goes when its run ends, for every way a run can end: status, status line,
 * the system message, the notification, and whether a new run picks the work up.
 */
describe.skipIf(!enabled)('finish', () => {
  afterAll(async () => {
    if (app) await deleteApp(app);
  });

  async function seed(device = 'gcp', browser?: 'auto') {
    const d = db as NonNullable<typeof db>;
    const taskId = `t-${randomUUID()}`;
    const runId = `r-${randomUUID()}`;
    await d.doc(paths.task(taskId)).set({
      title: 'Finish me',
      description: '',
      status: 'in_progress',
      ai: { enabled: true, device, ...(browser ? { browser } : {}) },
      activeRunId: runId,
      createdAt: 1,
      updatedAt: 1,
    });
    await d.doc(paths.run(runId)).set({
      taskId,
      device,
      model: 'gemini-3.8-flash',
      state: 'running',
      trigger: 'new',
      generation: 1,
      interrupt: false,
      compact: false,
      attempts: 1,
      sessionPath: paths.sessionBlob(runId),
      spent: 0,
      steps: 2,
      lease: { owner: `run:${runId}`, expiresAt: Date.now() + 3_600_000 },
      createdAt: 1,
      updatedAt: 1,
    });
    const run = { id: runId, ...(await d.doc(paths.run(runId)).get()).data() } as Run;
    return { taskId, runId, run };
  }

  async function end(req: Omit<FinishRequest, 'runId'>, browser?: 'auto', device = 'gcp') {
    const d = db as NonNullable<typeof db>;
    const { taskId, runId, run } = await seed(device, browser);
    const notices: Parameters<Notify>[0][] = [];
    await finish(
      {
        db: d,
        auth,
        storage,
        costGate: costGateFor(d),
        notify: async (n) => void notices.push(n),
      },
      run,
      req,
    );
    const task = (await d.doc(paths.task(taskId)).get()).data() ?? {};
    const runAfter = (await d.doc(paths.run(runId)).get()).data() ?? {};
    const system = (
      await d.collection(paths.messages(taskId)).where('author', '==', 'system').get()
    ).docs.map((m) => m.data());
    const others = (await d.collection(paths.runs()).where('taskId', '==', taskId).get()).docs
      .filter((r) => r.id !== runId)
      .map((r) => ({ id: r.id, ...r.data() }) as Run);
    return { task, run: runAfter, system, notices, next: others };
  }

  const cases: Array<{
    name: string;
    req: Omit<FinishRequest, 'runId'>;
    runState: Run['state'];
    status: string;
    kind: string | undefined;
    line?: RegExp;
    message?: RegExp;
  }> = [
    {
      name: 'finished, done',
      req: { reason: 'finished', outcome: 'done', session: [] },
      runState: 'succeeded',
      status: 'review',
      kind: 'done',
    },
    {
      name: 'finished, review',
      req: { reason: 'finished', outcome: 'review', session: [] },
      runState: 'succeeded',
      status: 'review',
      kind: 'review',
    },
    {
      name: 'finished, blocked',
      req: { reason: 'finished', outcome: 'blocked', session: [] },
      runState: 'succeeded',
      status: 'needs_input',
      kind: 'blocked',
    },
    {
      name: 'max steps',
      req: { reason: 'max_steps', session: [] },
      runState: 'succeeded',
      status: 'review',
      kind: 'review',
    },
    {
      name: 'error',
      req: { reason: 'error', error: 'boom', session: [] },
      runState: 'failed',
      status: 'needs_input',
      kind: 'failed',
      line: /Run stopped: boom/,
      message: /The run failed: boom/,
    },
    {
      name: 'interrupted',
      req: { reason: 'interrupted', session: [] },
      runState: 'interrupted',
      status: 'needs_input',
      kind: 'stopped',
      line: /^Stopped\./,
    },
    {
      name: 'halted',
      req: { reason: 'halted', session: [] },
      runState: 'interrupted',
      status: 'needs_input',
      kind: 'stopped',
      line: /halted/,
    },
    {
      name: "budget: the task's own",
      req: { reason: 'budget_exhausted', session: [] },
      runState: 'budget_exhausted',
      status: 'needs_input',
      kind: 'budget',
      line: /Top up/,
      message: /used its budget/,
    },
    {
      name: 'budget: the month',
      req: {
        reason: 'budget_exhausted',
        error: 'budget_exhausted(monthly): the monthly budget has €0.01 left',
        session: [],
      },
      runState: 'budget_exhausted',
      status: 'needs_input',
      kind: 'budget',
      line: /cap reached/,
      message: /Settings › Budget/,
    },
  ];

  for (const c of cases) {
    it(`${c.name}: the task, the message and the notice`, async () => {
      const out = await end(c.req);
      expect(out.run.state).toBe(c.runState);
      expect(out.run.endReason).toBe(c.req.reason);
      expect(out.task.activeRunId).toBeUndefined();
      expect(out.task.status).toBe(c.status);
      if (c.line) expect(out.task.statusLine?.text).toMatch(c.line);
      if (c.message) expect(out.system.map((m) => m.body).join('\n')).toMatch(c.message);
      expect(out.notices.map((n) => n.kind)).toEqual(c.kind ? [c.kind] : []);
      // None of these starts another run by itself.
      expect(out.next).toHaveLength(0);
    });
  }

  it('offers a top-up card sized to the refused call when the task budget runs out', async () => {
    const out = await end({
      reason: 'budget_exhausted',
      error: "budget_exhausted(task): the task's budget has €0.01 left and this call needs €0.73",
      session: [],
    });
    const card = out.system.find((m) => m.input);
    expect(card?.input?.kind).toBe('approval');
    expect(card?.input?.topUp).toBe(800_000);
  });

  it('needs_browser: no notice, and a new run with a browser picks the session up', async () => {
    const out = await end({ reason: 'needs_browser', session: [] }, 'auto');
    expect(out.run.state).toBe('succeeded');
    expect(out.notices).toHaveLength(0);
    expect(out.next).toHaveLength(1);
    expect(out.next[0]?.browser).toBe(true);
    expect(out.next[0]?.trigger).toBe('resume');
    expect(out.task.activeRunId).toBe(out.next[0]?.id);
  });

  async function pairMac(lastSeen = Date.now()) {
    const d = db as NonNullable<typeof db>;
    const deviceId = `mac-${randomUUID().slice(0, 8)}`;
    await d.doc(paths.device(deviceId)).set({
      name: `Studio ${deviceId}`,
      state: 'approved',
      lastSeen,
      folders: [],
      createdAt: 1,
      updatedAt: 1,
    });
    return deviceId;
  }

  const requestDevice = (reason: string) => [
    {
      role: 'model' as const,
      parts: [{ functionCall: { name: 'request_device', args: { reason } } }],
    },
  ];

  it('needs_device on device auto with a Mac online: the work moves to it', async () => {
    await pairMac(Date.now() + 1_000);
    const out = await end({ reason: 'needs_device', session: [] }, undefined, 'auto');
    expect(out.notices).toHaveLength(0);
    expect(out.next).toHaveLength(1);
    // Other test files share the emulator and may pair a Mac seen later.
    expect(out.next[0]?.device).toMatch(/^mac:/);
    expect(out.next[0]?.browser).toBe(true);
    expect(out.task.statusLine?.text).toMatch(/^Moving to Studio/);
  });

  it('needs_device on device auto with the Mac offline: it waits for it and says so', async () => {
    const d = db as NonNullable<typeof db>;
    await pairMac(Date.now() + 2_000);
    const { taskId, run } = await seed('auto');
    const notices: Parameters<Notify>[0][] = [];
    // An hour from now every Mac has missed its heartbeats; this one is still the latest seen.
    const later = Date.now() + 3_600_000;
    await finish(
      {
        db: d,
        auth,
        storage,
        costGate: costGateFor(d),
        now: () => later,
        notify: async (n) => void notices.push(n),
      },
      run,
      { reason: 'needs_device', session: [] },
    );
    const task = (await d.doc(paths.task(taskId)).get()).data() ?? {};
    const next = (await d.collection(paths.runs()).where('taskId', '==', taskId).get()).docs
      .map((r) => r.data())
      .filter((r) => r.state === 'queued');
    expect(next[0]?.device).toMatch(/^mac:/);
    expect(task.statusLine?.text).toMatch(/Waiting for .* to come online/);
    expect(notices[0]?.title).toMatch(/^Waiting for your Mac/);
  });

  it('needs_device on a task pinned to remote: asks before moving', async () => {
    await pairMac(Date.now() + 3_000);
    const out = await end({
      reason: 'needs_device',
      session: requestDevice('Google says this browser may not be secure'),
    });
    expect(out.next).toHaveLength(0);
    expect(out.task.status).toBe('needs_input');
    expect(out.task.activeRunId).toBeUndefined();
    const ask = out.system.find((m) => m.input?.moveToMac);
    expect(ask?.input).toMatchObject({ kind: 'approval', suggestedRule: 'Device(mac)' });
    expect(ask?.input.prompt).toMatch(/set to run remotely.*Continue it on your Mac/);
    expect(ask?.input.prompt).toMatch(/may not be secure$/);
    expect(out.notices[0]?.input).toMatchObject({ kind: 'approval' });
  });

  it('needs_device on a task pinned to remote with Device(mac) allowed: moves at once', async () => {
    const d = db as NonNullable<typeof db>;
    await pairMac(Date.now() + 4_000);
    const { taskId, run } = await seed('gcp');
    await d.doc(paths.task(taskId)).update({ allowRules: ['Device(mac)'] });
    await finish({ db: d, auth, storage, costGate: costGateFor(d), notify: async () => {} }, run, {
      reason: 'needs_device',
      session: [],
    });
    const next = (await d.collection(paths.runs()).where('taskId', '==', taskId).get()).docs
      .map((r) => r.data())
      .filter((r) => r.state === 'queued');
    expect(next).toHaveLength(1);
    expect(next[0]?.device).toMatch(/^mac:/);
  });

  it('lease_lost: the task is released and says the run stopped', async () => {
    const out = await end({ reason: 'lease_lost', error: 'gone', session: [] });
    expect(out.run.state).toBe('failed');
    expect(out.task.activeRunId).toBeUndefined();
    expect(out.task.statusLine?.text).toMatch(/Run stopped: gone/);
    expect(out.next).toHaveLength(0);
  });
});
