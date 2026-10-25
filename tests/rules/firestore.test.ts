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
      await setDoc(doc(db, 'runs/r1'), { taskId: 't1', state: 'running', interrupt: false });
    });
  });

  const owner = () => env.authenticatedContext('owner', { dodo_owner: true }).firestore();
  const stranger = () =>
    env.authenticatedContext('someone', { email: 'x@example.com' }).firestore();
  const anon = () => env.unauthenticatedContext().firestore();

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

  it('denies unknown collections', async () => {
    await assertFails(setDoc(doc(owner(), 'anything/x'), { a: 1 }));
  });
});
