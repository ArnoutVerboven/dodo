import { randomUUID } from 'node:crypto';
import { paths } from '@dodo/core';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import type { Auth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import type { Storage } from 'firebase-admin/storage';
import { afterAll, describe, expect, it } from 'vitest';
import { reapStaleRuns } from './run-control.js';
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

  async function seed(leaseExpiresAt: number) {
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
});
