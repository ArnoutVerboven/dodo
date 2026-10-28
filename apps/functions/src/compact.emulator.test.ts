import { randomUUID } from 'node:crypto';
import { type Content, paths } from '@dodo/core';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type { Storage } from 'firebase-admin/storage';
import { afterAll, describe, expect, it } from 'vitest';
import { compactTask } from './compact.js';
import { DEFAULT_HOURLY_CAP } from './gateway.js';
import { FakeProvider } from './model-provider.js';
import { costGateFor } from './runtime.js';

const enabled = !!process.env.FIRESTORE_EMULATOR_HOST;
const app = enabled ? initializeApp({ projectId: 'demo-dodo' }, 'compact-test') : undefined;
const db = app ? getFirestore(app) : undefined;

/** Storage as a map: enough for saving and loading session blobs. */
function memoryStorage() {
  const files = new Map<string, string>();
  const storage = {
    bucket: () => ({
      file: (path: string) => ({
        save: async (data: string) => {
          files.set(path, data);
        },
        download: async () => {
          const v = files.get(path);
          if (v === undefined) throw new Error('not found');
          return [Buffer.from(v, 'utf8')];
        },
      }),
    }),
  } as unknown as Storage;
  return { files, storage };
}

describe.skipIf(!enabled)('compactTask', () => {
  afterAll(async () => {
    if (app) await deleteApp(app);
  });

  const deps = (storage: Storage) => {
    const d = db as NonNullable<typeof db>;
    return {
      gateway: {
        db: d,
        costGate: costGateFor(d),
        provider: new FakeProvider(),
        hourlyCap: DEFAULT_HOURLY_CAP,
      },
      storage,
    };
  };

  async function seed(session: Content[] | undefined, runState = 'succeeded') {
    const d = db as NonNullable<typeof db>;
    const taskId = `t-${randomUUID()}`;
    const runId = `r-${randomUUID()}`;
    const { files, storage } = memoryStorage();
    await d.doc(paths.task(taskId)).set({
      title: 'Compact me',
      status: 'review',
      ai: { enabled: true },
      context: { tokens: 300_000, max: 1_048_576 },
      createdAt: 1,
      updatedAt: 1,
      ...(runState === 'running' ? { activeRunId: runId } : {}),
    });
    const sessionPath = session ? paths.sessionBlob(runId) : undefined;
    if (session && sessionPath) files.set(sessionPath, JSON.stringify(session));
    await d.doc(paths.run(runId)).set({
      taskId,
      device: 'gcp',
      model: 'gemini-3.8-flash',
      state: runState,
      trigger: 'new',
      generation: 1,
      interrupt: false,
      attempts: 1,
      ...(sessionPath ? { sessionPath } : {}),
      spent: 0,
      steps: 3,
      createdAt: 1,
      updatedAt: 1,
    });
    return { taskId, runId, files, storage, sessionPath };
  }

  const session: Content[] = [
    { role: 'user', parts: [{ text: 'Plan the trip' }] },
    {
      role: 'model',
      parts: [{ functionCall: { name: 'set_status', args: { text: 'Planning' } } }],
    },
    { role: 'user', parts: [{ functionResponse: { name: 'set_status', response: { ok: true } } }] },
  ];

  it('summarises an idle conversation into the session the next run continues from', async () => {
    const d = db as NonNullable<typeof db>;
    const { taskId, files, storage, sessionPath } = await seed(session);
    const result = await compactTask(deps(storage), taskId);
    expect(result.state).toBe('compacted');

    const runs = await d
      .collection(paths.runs())
      .where('taskId', '==', taskId)
      .orderBy('createdAt', 'desc')
      .get();
    const latest = runs.docs[0]?.data();
    expect(latest?.trigger).toBe('compact');
    expect(latest?.state).toBe('succeeded');
    expect(latest?.sessionPath).not.toBe(sessionPath);
    const compacted = JSON.parse(files.get(latest?.sessionPath) ?? '[]') as Content[];
    expect(compacted).toHaveLength(1);
    expect(compacted[0]?.parts[0]?.text).toContain('This conversation was compacted');

    const task = (await d.doc(paths.task(taskId)).get()).data();
    expect(task?.status).toBe('review');
    expect(task?.activeRunId).toBeUndefined();
    expect(task?.context.compactedAt).toBeGreaterThan(0);
    expect(task?.context.tokens).toBeLessThan(300_000);
    const msgs = await d.collection(paths.messages(taskId)).get();
    expect(msgs.docs[0]?.get('body')).toContain('0.30M →');
  });

  it('asks a working run to compact at its next step', async () => {
    const d = db as NonNullable<typeof db>;
    const { taskId, runId, storage } = await seed(session, 'running');
    expect((await compactTask(deps(storage), taskId)).state).toBe('requested');
    expect((await d.doc(paths.run(runId)).get()).get('compact')).toBe(true);
  });

  it('does nothing without a conversation', async () => {
    const { taskId, storage } = await seed(undefined);
    expect((await compactTask(deps(storage), taskId)).state).toBe('nothing');
  });
});
