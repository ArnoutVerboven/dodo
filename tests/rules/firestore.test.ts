import { readFileSync } from 'node:fs';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const enabled = !!process.env.FIRESTORE_EMULATOR_HOST;
let env: RulesTestEnvironment;

describe.skipIf(!enabled)('firestore.rules', () => {
  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: 'demo-dodo-rules',
      firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') },
    });
  });
  afterAll(() => env?.cleanup());
  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'tasks/t1'), { title: 'x' });
      await setDoc(doc(db, 'tasks/t1/messages/m1'), {
        author: 'agent',
        body: 'q',
        input: { kind: 'text', prompt: 'q' },
      });
      await setDoc(doc(db, 'budgets/task_t1'), { reserved: 0, spent: 1 });
      await setDoc(doc(db, 'runs/r1'), {
        taskId: 't1',
        state: 'running',
        interrupt: false,
        generation: 2,
      });
      await setDoc(doc(db, 'runs/r9'), {
        taskId: 't1',
        state: 'succeeded',
        interrupt: false,
        generation: 1,
      });
    });
  });

  const owner = () => env.authenticatedContext('owner', { dodo_owner: true }).firestore();
  const stranger = () =>
    env.authenticatedContext('someone', { email: 'x@example.com' }).firestore();
  const anon = () => env.unauthenticatedContext().firestore();
  const run = (runId = 'r1', generation = 2, taskId = 't1') =>
    env.authenticatedContext(`run:${runId}`, { run: runId, taskId, generation }).firestore();

  it('lets only the owner read and write tasks', async () => {
    await assertSucceeds(getDoc(doc(owner(), 'tasks/t1')));
    await assertSucceeds(setDoc(doc(owner(), 'tasks/t2'), { title: 'new' }));
    await assertFails(getDoc(doc(stranger(), 'tasks/t1')));
    await assertFails(getDoc(doc(anon(), 'tasks/t1')));
    await assertFails(setDoc(doc(stranger(), 'tasks/t3'), { title: 'spam' }));
  });

  it('keeps budget state read-only for the owner', async () => {
    await assertSucceeds(getDoc(doc(owner(), 'budgets/task_t1')));
    await assertFails(setDoc(doc(owner(), 'budgets/task_t1'), { reserved: 0, spent: 0 }));
    await assertFails(setDoc(doc(owner(), 'ledger/x'), { actual: 0 }));
    await assertFails(setDoc(doc(owner(), 'reservations/x'), { amount: 0 }));
  });

  it('lets the owner post only as the user, and answer input requests', async () => {
    await assertSucceeds(
      setDoc(doc(owner(), 'tasks/t1/messages/m2'), { author: 'user', body: 'hi' }),
    );
    await assertFails(
      setDoc(doc(owner(), 'tasks/t1/messages/m3'), { author: 'agent', body: 'fake' }),
    );
    await assertSucceeds(
      updateDoc(doc(owner(), 'tasks/t1/messages/m1'), { 'input.answer': { value: 'ok' } }),
    );
    await assertFails(updateDoc(doc(owner(), 'tasks/t1/messages/m1'), { body: 'rewritten' }));
  });

  it('lets the owner only request an interrupt on runs', async () => {
    await assertSucceeds(updateDoc(doc(owner(), 'runs/r1'), { interrupt: true }));
    await assertFails(updateDoc(doc(owner(), 'runs/r1'), { state: 'succeeded' }));
    await assertFails(setDoc(doc(owner(), 'runs/r2'), { taskId: 't1' }));
  });

  it('lets a live run write its trace and its task summary, status, messages and artifacts', async () => {
    await assertSucceeds(getDoc(doc(run(), 'tasks/t1')));
    await assertSucceeds(
      updateDoc(doc(run(), 'tasks/t1'), { summary: 's', statusLine: { text: 'x' }, updatedAt: 1 }),
    );
    await assertFails(updateDoc(doc(run(), 'tasks/t1'), { title: 'renamed' }));
    await assertFails(updateDoc(doc(run(), 'tasks/t1'), { ai: { budget: 1e9 } }));
    await assertSucceeds(
      setDoc(doc(run(), 'runs/r1/events/e1'), { runId: 'r1', seq: 0, type: 'run_started' }),
    );
    await assertFails(setDoc(doc(run(), 'runs/r9/events/e1'), { runId: 'r9', seq: 0 }));
    await assertSucceeds(
      setDoc(doc(run(), 'tasks/t1/messages/m5'), { author: 'agent', runId: 'r1', body: 'hi' }),
    );
    await assertFails(
      setDoc(doc(run(), 'tasks/t1/messages/m6'), { author: 'user', runId: 'r1', body: 'spoof' }),
    );
    await assertFails(
      setDoc(doc(run(), 'tasks/t1/messages/m7'), {
        author: 'agent',
        runId: 'r1',
        body: 'q',
        input: { kind: 'text', prompt: 'q' },
      }),
    );
    await assertSucceeds(
      setDoc(doc(run(), 'tasks/t1/artifacts/a1'), { createdBy: 'agent', kind: 'text', name: 'n' }),
    );
    await assertFails(updateDoc(doc(run(), 'runs/r1'), { state: 'succeeded' }));
    await assertFails(updateDoc(doc(run(), 'runs/r1'), { interrupt: true }));
    await assertFails(getDoc(doc(run(), 'settings/global')));
    await assertFails(getDoc(doc(run(), 'budgets/task_t1')));
  });

  it('rejects a run whose lease generation is stale, ended, or on another task', async () => {
    await assertFails(updateDoc(doc(run('r1', 1), 'tasks/t1'), { summary: 'stale' }));
    await assertFails(setDoc(doc(run('r1', 1), 'runs/r1/events/e2'), { runId: 'r1', seq: 1 }));
    await assertFails(updateDoc(doc(run('r9', 1), 'tasks/t1'), { summary: 'ended' }));
    await assertFails(updateDoc(doc(run('r1', 2, 't2'), 'tasks/t1'), { summary: 'other task' }));
    await assertFails(getDoc(doc(run('r1', 2, 't2'), 'tasks/t1')));
  });

  it('keeps push tokens to the owner', async () => {
    await assertSucceeds(setDoc(doc(owner(), 'pushTokens/tok1'), { createdAt: 1 }));
    await assertSucceeds(getDoc(doc(owner(), 'pushTokens/tok1')));
    await assertFails(getDoc(doc(stranger(), 'pushTokens/tok1')));
    await assertFails(setDoc(doc(stranger(), 'pushTokens/tok2'), { createdAt: 1 }));
    await assertFails(getDoc(doc(run(), 'pushTokens/tok1')));
  });

  it('denies unknown collections', async () => {
    await assertFails(setDoc(doc(owner(), 'anything/x'), { a: 1 }));
  });
});
