import { randomUUID } from 'node:crypto';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createApiToken,
  handleApiRequest,
  ingestTask,
  listIngestedTasks,
  postIngestMessage,
  updateIngestedTask,
} from './ingest.js';

const enabled = !!process.env.FIRESTORE_EMULATOR_HOST;
const app = enabled ? initializeApp({ projectId: 'demo-dodo' }, 'ingest-test') : undefined;
const db = app ? getFirestore(app) : undefined;

// Other packages' emulator tests share the database, so nothing here clears it: every test
// uses its own random keys.
describe.skipIf(!enabled)('task ingest API (emulator)', () => {
  afterAll(async () => app && deleteApp(app));

  it('creates a task once per source and key, with AI off and the untrusted profile', async () => {
    if (!db) return;
    const key = randomUUID();
    const req = {
      title: 'Schedule house visit Kerkstraat',
      description: 'quoted mail',
      tags: ['email'],
      source: { kind: 'gmail', ref: key, url: 'https://mail.google.com/mail/#all/x' },
      idempotencyKey: key,
    };
    const first = await ingestTask({ db }, req);
    const again = await ingestTask({ db }, { ...req, title: 'different' });
    expect(first.created).toBe(true);
    expect(again).toEqual({ taskId: first.taskId, created: false });
    const task = (await db.doc(`tasks/${first.taskId}`).get()).data();
    expect(task).toMatchObject({
      title: 'Schedule house visit Kerkstraat',
      status: 'todo',
      ai: { enabled: false, profile: 'untrusted' },
      source: { kind: 'gmail', ref: key },
      externalRefs: { gmail: key },
    });
  });

  it('lists, updates and messages only tasks of the same source', async () => {
    if (!db) return;
    const key = randomUUID();
    const { taskId } = await ingestTask(
      { db },
      { title: 'From WhatsApp', source: { kind: 'whatsapp' }, idempotencyKey: key },
    );
    const open = await listIngestedTasks({ db }, { kind: 'whatsapp', open: true, limit: 200 });
    expect(open.map((t) => t.id)).toContain(taskId);
    await updateIngestedTask({ db }, taskId, { status: 'done' }, 'whatsapp');
    const stillOpen = await listIngestedTasks({ db }, { kind: 'whatsapp', open: true, limit: 200 });
    expect(stillOpen.map((t) => t.id)).not.toContain(taskId);
    await expect(updateIngestedTask({ db }, taskId, { status: 'todo' }, 'gmail')).rejects.toThrow(
      'Unknown task',
    );
    const messageId = await postIngestMessage({ db }, taskId, { body: 'New message' });
    const msg = (await db.doc(`tasks/${taskId}/messages/${messageId}`).get()).data();
    expect(msg).toMatchObject({ author: 'system', body: 'New message' });
    expect(msg && 'input' in msg).toBe(false);
  });

  it('refuses tasks the API did not create', async () => {
    if (!db) return;
    const id = randomUUID();
    await db.doc(`tasks/${id}`).set({ title: 'mine', status: 'todo', updatedAt: 1 });
    await expect(updateIngestedTask({ db }, id, { status: 'done' })).rejects.toThrow(
      'Unknown task',
    );
  });

  it('serves HTTP with a per-source token, and refuses bad or revoked tokens', async () => {
    if (!db) return;
    const { id, token } = await createApiToken({ db }, { name: 'script', source: 'gmail' });
    const call = (method: string, path: string, body?: unknown, auth = `Bearer ${token}`) =>
      handleApiRequest({ db }, { method, path, query: {}, authorization: auth, body });

    expect((await call('GET', '/v1/tasks', undefined, 'Bearer nope')).status).toBe(401);
    const key = randomUUID();
    // The token decides the source, whatever the body says.
    const created = await call('POST', '/v1/tasks', {
      title: 'Via HTTP',
      source: { kind: 'whatsapp' },
      idempotencyKey: key,
    });
    expect(created.status).toBe(201);
    const { taskId } = created.body as { taskId: string };
    expect((await db.doc(`tasks/${taskId}`).get()).get('source.kind')).toBe('gmail');
    const repeat = await call('POST', '/v1/tasks', {
      title: 'Via HTTP',
      source: {},
      idempotencyKey: key,
    });
    expect(repeat).toEqual({ status: 200, body: { taskId, created: false } });
    expect((await call('POST', `/v1/tasks/${taskId}/messages`, { body: 'hi' })).status).toBe(201);
    expect((await call('PATCH', `/v1/tasks/${taskId}`, { priority: 'high' })).status).toBe(200);
    expect((await call('POST', '/v1/tasks', { title: '' })).status).toBe(400);

    await db.doc(`apiTokens/${id}`).update({ revoked: true });
    expect((await call('GET', '/v1/tasks')).status).toBe(401);
  });

  it('rate limits a token per hour', async () => {
    if (!db) return;
    const { id, token } = await createApiToken({ db }, { name: 'busy' });
    const hour = Math.floor(Date.now() / 3_600_000);
    await db.doc(`apiTokens/${id}`).update({ window: { hour, count: 120 } });
    const res = await handleApiRequest(
      { db },
      { method: 'GET', path: '/v1/tasks', query: {}, authorization: `Bearer ${token}`, body: {} },
    );
    expect(res.status).toBe(429);
  });
});
