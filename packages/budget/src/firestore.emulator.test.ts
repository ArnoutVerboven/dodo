import { eur } from '@dodo/core';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { BudgetExceededError, CostGate, HaltedError } from './cost-gate.js';
import { defaultLimitFor, FirestoreBudgetStore } from './firestore.js';
import { scopesForTask } from './scopes.js';

const enabled = !!process.env.FIRESTORE_EMULATOR_HOST;
const app = enabled ? initializeApp({ projectId: 'demo-dodo' }, 'budget-test') : undefined;
const db = app ? getFirestore(app) : undefined;

async function clear() {
  await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-dodo/databases/(default)/documents`,
    { method: 'DELETE' },
  );
}

describe.skipIf(!enabled)('FirestoreBudgetStore (emulator)', () => {
  const now = Date.UTC(2026, 9, 25);
  beforeEach(clear);
  afterAll(async () => app && deleteApp(app));

  it('enforces the task budget from the task document and the global cap from settings', async () => {
    if (!db) return;
    await db.doc('settings/global').set({ monthlyBudget: eur(1) });
    await db.doc('tasks/t1').set({ ai: { budget: eur(0.3) } });
    await db.doc('tasks/t2').set({ ai: { budget: eur(5) } });
    const gate = new CostGate(new FirestoreBudgetStore(db, defaultLimitFor(db)), undefined, () => now);

    const r = await gate.reserve({ scopes: scopesForTask('t1', undefined, now), category: 'tokens', amount: eur(0.2), description: 'a', taskId: 't1' });
    await expect(
      gate.reserve({ scopes: scopesForTask('t1', undefined, now), category: 'tokens', amount: eur(0.2), description: 'b' }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    await gate.settle(r.id, eur(0.05));

    // Global: 1 EUR - 0.05 spent leaves 0.95.
    await expect(
      gate.reserve({ scopes: scopesForTask('t2', undefined, now), category: 'infra', amount: eur(0.96), description: 'c' }),
    ).rejects.toMatchObject({ scopeKey: 'global_2026-10' });

    const ledger = await db.collection('ledger').get();
    expect(ledger.size).toBe(1);
    expect(ledger.docs[0]?.data()).toMatchObject({ taskId: 't1', actual: eur(0.05), reserved: eur(0.2) });
    expect((await db.doc('budgets/task_t1').get()).data()).toMatchObject({ reserved: 0, spent: eur(0.05) });
  });

  it('never oversubscribes under concurrent reservations', async () => {
    if (!db) return;
    await db.doc('settings/global').set({ monthlyBudget: eur(10) });
    await db.doc('tasks/t1').set({ ai: { budget: eur(1) } });
    const gate = new CostGate(new FirestoreBudgetStore(db, defaultLimitFor(db)), undefined, () => now);
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        gate.reserve({ scopes: scopesForTask('t1', undefined, now), category: 'tokens', amount: eur(0.1), description: 'p' }),
      ),
    );
    // Contention can make some transactions give up, which is safe; oversubscribing is not.
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBeLessThanOrEqual(10);
    expect(ok).toBeGreaterThan(0);
    expect((await db.doc('budgets/task_t1').get()).get('reserved')).toBe(ok * eur(0.1));
  }, 60_000);

  it('refuses everything when halted', async () => {
    if (!db) return;
    await db.doc('settings/global').set({ halted: true });
    const gate = new CostGate(new FirestoreBudgetStore(db, defaultLimitFor(db)), undefined, () => now);
    await expect(
      gate.reserve({ scopes: scopesForTask('t1', undefined, now), category: 'tokens', amount: 1, description: 'x' }),
    ).rejects.toBeInstanceOf(HaltedError);
  });

  it('applies a lowered task budget immediately', async () => {
    if (!db) return;
    await db.doc('tasks/t1').set({ ai: { budget: eur(1) } });
    const gate = new CostGate(new FirestoreBudgetStore(db, defaultLimitFor(db)), undefined, () => now);
    await gate.reserve({ scopes: scopesForTask('t1', undefined, now), category: 'tokens', amount: eur(0.3), description: 'a' });
    await db.doc('tasks/t1').set({ ai: { budget: eur(0.4) } });
    await expect(
      gate.reserve({ scopes: scopesForTask('t1', undefined, now), category: 'tokens', amount: eur(0.2), description: 'b' }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });
});
