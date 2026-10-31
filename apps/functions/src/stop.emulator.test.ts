import { randomUUID } from 'node:crypto';
import { paths, type Run, type Task } from '@dodo/core';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import type { Auth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import type { Storage } from 'firebase-admin/storage';
import { afterAll, describe, expect, it } from 'vitest';
import { finish } from './run-control.js';
import { costGateFor } from './runtime.js';
import { onInputAnswered, onTaskChanged } from './triggers.js';

const enabled = !!process.env.FIRESTORE_EMULATOR_HOST;
const app = enabled ? initializeApp({ projectId: 'demo-dodo' }, 'stop-test') : undefined;
const db = app ? getFirestore(app) : undefined;

const storage = {
  bucket: () => ({
    file: () => ({ save: async () => {}, download: async () => [Buffer.from('[]')] }),
  }),
} as unknown as Storage;
const auth = { deleteUser: async () => {} } as unknown as Auth;

/** Pressing Stop (or the kill switch) ends the run; nothing may start a new one by itself. */
describe.skipIf(!enabled)('a stopped run stays stopped', () => {
  afterAll(async () => {
    if (app) await deleteApp(app);
  });

  async function seedRunning() {
    const d = db as NonNullable<typeof db>;
    const taskId = `t-${randomUUID()}`;
    const runId = `r-${randomUUID()}`;
    await d.doc(paths.task(taskId)).set({
      title: 'Stop me',
      status: 'in_progress',
      ai: { enabled: true, device: 'mac' },
      activeRunId: runId,
      createdAt: 1,
      updatedAt: 1,
    });
    await d.doc(paths.run(runId)).set({
      taskId,
      device: 'mac',
      model: 'gemini-3.8-flash',
      state: 'running',
      trigger: 'new',
      generation: 1,
      interrupt: true,
      compact: false,
      attempts: 1,
      sessionPath: paths.sessionBlob(runId),
      spent: 0,
      steps: 2,
      // A live lease, so the reaper test sharing the emulator does not end it first.
      lease: { owner: `run:${runId}`, expiresAt: Date.now() + 3_600_000 },
      createdAt: 1,
      updatedAt: 1,
    });
    return { taskId, runId };
  }

  const taskOf = async (taskId: string) => {
    const snap = await (db as NonNullable<typeof db>).doc(paths.task(taskId)).get();
    return { id: snap.id, ...snap.data() } as Task;
  };
  const runsOf = async (taskId: string) =>
    (
      await (db as NonNullable<typeof db>)
        .collection(paths.runs())
        .where('taskId', '==', taskId)
        .get()
    ).docs;

  for (const reason of ['interrupted', 'halted'] as const) {
    it(`does not start again after a run ends as ${reason}`, async () => {
      const d = db as NonNullable<typeof db>;
      const { taskId, runId } = await seedRunning();
      const before = await taskOf(taskId);
      const run = { id: runId, ...(await d.doc(paths.run(runId)).get()).data() } as Run;

      await finish({ db: d, auth, storage, costGate: costGateFor(d) }, run, {
        reason,
        session: [],
      });
      const after = await taskOf(taskId);
      expect(after.activeRunId).toBeUndefined();
      expect(after.status).toBe('needs_input');

      // The task trigger sees the run being released: it must not queue a new run.
      await onTaskChanged({ db: d }, before, after);
      expect(await runsOf(taskId)).toHaveLength(1);

      // Moving it back to To do is the user acting: that does continue it.
      await d.doc(paths.task(taskId)).update({ status: 'todo' });
      await onTaskChanged({ db: d }, after, await taskOf(taskId));
      expect(await runsOf(taskId)).toHaveLength(2);
    });
  }

  it('does not start again when a budget top-up is declined', async () => {
    const d = db as NonNullable<typeof db>;
    const taskId = `t-${randomUUID()}`;
    await d.doc(paths.task(taskId)).set({
      title: 'Out of budget',
      status: 'needs_input',
      ai: { enabled: true, device: 'mac' },
      createdAt: 1,
      updatedAt: 1,
    });
    const before = await taskOf(taskId);
    const input = { prompt: 'Top up?', topUp: 500_000 };
    await onInputAnswered(
      { db: d },
      taskId,
      'm1',
      { input: {} },
      {
        input: { ...input, answer: { value: 'no' } },
      },
    );
    const after = await taskOf(taskId);
    expect(after.status).toBe('needs_input');
    await onTaskChanged({ db: d }, before, after);
    expect(await runsOf(taskId)).toHaveLength(0);
  });
});
