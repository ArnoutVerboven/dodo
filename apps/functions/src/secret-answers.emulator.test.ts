import { randomBytes, randomUUID } from 'node:crypto';
import { paths } from '@dodo/core';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { afterAll, describe, expect, it } from 'vitest';
import {
  deleteSecretAnswers,
  resolveSecretAnswer,
  SECRET_ANSWER_TTL_MS,
  saveSecretAnswer,
  secretAnswerPath,
} from './secret-answers.js';

const enabled = !!process.env.FIRESTORE_EMULATOR_HOST;
const app = enabled ? initializeApp({ projectId: 'demo-dodo' }, 'secret-answers-test') : undefined;
const db = app ? getFirestore(app) : undefined;
const key = randomBytes(32);

describe.skipIf(!enabled)('secret answers', () => {
  afterAll(async () => {
    if (app) await deleteApp(app);
  });

  async function seed(input: Record<string, unknown>) {
    const d = db as NonNullable<typeof db>;
    const taskId = `t-${randomUUID()}`;
    const messageId = `m${randomUUID().slice(0, 8)}`;
    await d.doc(`${paths.messages(taskId)}/${messageId}`).set({
      author: 'agent',
      body: 'SMS code?',
      input,
      createdAt: 1,
    });
    return { taskId, messageId };
  }

  it('keeps the code out of the thread and hands it only to a run on that task', async () => {
    const d = db as NonNullable<typeof db>;
    let now = 1_000_000;
    const deps = { db: d, key: async () => key, now: () => now };
    const { taskId, messageId } = await seed({ kind: 'text', prompt: 'SMS code?', secret: true });

    const { ref } = await saveSecretAnswer(deps, { taskId, messageId, value: ' 482913 ' });
    expect(ref).toBe(`{{answer:${messageId}}}`);
    const msg = (await d.doc(`${paths.messages(taskId)}/${messageId}`).get()).data();
    expect(msg?.input.answer.value).toBe(ref);
    expect(JSON.stringify(msg)).not.toContain('482913');
    const stored = (await d.doc(secretAnswerPath(messageId)).get()).data();
    expect(JSON.stringify(stored)).not.toContain('482913'); // encrypted

    expect(await resolveSecretAnswer(deps, { id: 'r1', taskId }, messageId)).toEqual({
      value: '482913',
    });
    await expect(
      resolveSecretAnswer(deps, { id: 'r2', taskId: 'other' }, messageId),
    ).rejects.toThrow('No secret answer');
    // Answered once only.
    await expect(saveSecretAnswer(deps, { taskId, messageId, value: '1' })).rejects.toThrow(
      'Already answered',
    );

    now += SECRET_ANSWER_TTL_MS + 1;
    await expect(resolveSecretAnswer(deps, { id: 'r1', taskId }, messageId)).rejects.toThrow(
      'expired',
    );
    expect((await d.doc(secretAnswerPath(messageId)).get()).exists).toBe(false);
  });

  it('remembers the site the code was asked on and hands it out with the value', async () => {
    const d = db as NonNullable<typeof db>;
    const deps = { db: d, key: async () => key };
    const q = await seed({ kind: 'text', prompt: 'SMS code?', secret: true, site: 'kbc.be' });
    await saveSecretAnswer(deps, { ...q, value: '991122' });
    expect(await resolveSecretAnswer(deps, { id: 'r1', taskId: q.taskId }, q.messageId)).toEqual({
      value: '991122',
      site: 'kbc.be',
    });
  });

  it('refuses a question that is not secret, and deletes a task’s codes when it closes', async () => {
    const d = db as NonNullable<typeof db>;
    const deps = { db: d, key: async () => key };
    const plain = await seed({ kind: 'text', prompt: 'Which?' });
    await expect(saveSecretAnswer(deps, { ...plain, value: 'x' })).rejects.toThrow(
      'Not a secret question',
    );

    const s = await seed({ kind: 'text', prompt: 'Code?', secret: true });
    await saveSecretAnswer(deps, { ...s, value: '1234' });
    expect(await deleteSecretAnswers(deps, s.taskId)).toBe(1);
    expect((await d.doc(secretAnswerPath(s.messageId)).get()).exists).toBe(false);
  });
});
