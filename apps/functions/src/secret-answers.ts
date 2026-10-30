import { answerRef, paths, type Run } from '@dodo/core';
import type { Firestore } from 'firebase-admin/firestore';
import { decrypt, encrypt } from './browser-state.js';

/**
 * Secret answers to ask_user (ARCHITECTURE §9.3): an MFA code the user types in the app or
 * sends on Telegram. The value is stored here, encrypted with the browser-state key, in a
 * collection no client rule allows; the question's thread message only gets the reference
 * `{{answer:<messageId>}}`. So the code never enters the thread, the trace or the model's
 * context: the run's browser tool resolves the reference when it types it into the page, and
 * the loop redacts it from everything after. A code expires after a while, and every code of
 * a task is deleted when the task is done, cancelled or deleted.
 */

export interface SecretAnswerDeps {
  db: Firestore;
  key: () => Promise<Buffer>;
  now?: () => number;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

export class SecretAnswerError extends Error {
  constructor(
    readonly code: 'invalid-argument' | 'not-found' | 'permission-denied' | 'failed-precondition',
    message: string,
  ) {
    super(message);
  }
}

/** One-time codes are short-lived; a code older than this is not handed out any more. */
export const SECRET_ANSWER_TTL_MS = 30 * 60_000;

export const secretAnswerPath = (messageId: string) => `secretAnswers/${messageId}`;

interface StoredAnswer {
  taskId: string;
  /** base64 of iv ‖ tag ‖ ciphertext. */
  cipher: string;
  createdAt: number;
}

/**
 * Answers a secret question: stores the value and marks the question answered with its
 * reference. Refuses a question that is not secret or already answered.
 */
export async function saveSecretAnswer(
  deps: SecretAnswerDeps,
  req: { taskId: string; messageId: string; value: string; via?: 'telegram' },
): Promise<{ ref: string }> {
  const now = (deps.now ?? Date.now)();
  const value = req.value.trim();
  if (!value) throw new SecretAnswerError('invalid-argument', 'Empty answer');
  const cipher = encrypt(await deps.key(), value).toString('base64');
  const msgRef = deps.db.doc(`${paths.messages(req.taskId)}/${req.messageId}`);
  const ref = answerRef(req.messageId);
  await deps.db.runTransaction(async (t) => {
    const msg = await t.get(msgRef);
    const input = msg.get('input') as
      | { kind?: string; secret?: boolean; answer?: unknown }
      | undefined;
    if (!msg.exists || !input) throw new SecretAnswerError('not-found', 'No such question');
    if (!input.secret) throw new SecretAnswerError('failed-precondition', 'Not a secret question');
    if (input.answer) throw new SecretAnswerError('failed-precondition', 'Already answered');
    t.set(deps.db.doc(secretAnswerPath(req.messageId)), {
      taskId: req.taskId,
      cipher,
      createdAt: now,
    } satisfies StoredAnswer);
    t.update(msgRef, {
      'input.answer': { value: ref, answeredAt: now, ...(req.via ? { via: req.via } : {}) },
    });
  });
  // Never the value.
  deps.log?.('secret answer stored', { taskId: req.taskId, messageId: req.messageId });
  return { ref };
}

/** The value behind `{{answer:<messageId>}}`, for a live run on the question's task only. */
export async function resolveSecretAnswer(
  deps: SecretAnswerDeps,
  run: Pick<Run, 'id' | 'taskId'>,
  messageId: string,
): Promise<{ value: string }> {
  const snap = await deps.db.doc(secretAnswerPath(messageId)).get();
  const stored = snap.data() as StoredAnswer | undefined;
  if (!stored || stored.taskId !== run.taskId) {
    throw new SecretAnswerError('not-found', 'No secret answer with that reference on this task');
  }
  const now = (deps.now ?? Date.now)();
  if (now - stored.createdAt > SECRET_ANSWER_TTL_MS) {
    await snap.ref.delete();
    throw new SecretAnswerError(
      'failed-precondition',
      'That code has expired; ask the user for a new one (secret: true).',
    );
  }
  const value = decrypt(await deps.key(), Buffer.from(stored.cipher, 'base64'));
  deps.log?.('secret answer used', { taskId: run.taskId, messageId, runId: run.id });
  return { value };
}

/** Every secret answer of a task, when it is done, cancelled or deleted. */
export async function deleteSecretAnswers(
  deps: Pick<SecretAnswerDeps, 'db'>,
  taskId: string,
): Promise<number> {
  const snaps = await deps.db.collection('secretAnswers').where('taskId', '==', taskId).get();
  if (snaps.empty) return 0;
  const batch = deps.db.batch();
  for (const d of snaps.docs) batch.delete(d.ref);
  await batch.commit();
  return snaps.size;
}
