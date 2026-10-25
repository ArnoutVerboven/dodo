import { eur } from '@dodo/core';
import { describe, expect, it } from 'vitest';
import { BudgetExceededError, CostGate, HaltedError, type Scope, scopeKey } from './cost-gate.js';
import { MemoryBudgetStore } from './memory-store.js';

const month = '2026-10';
const scopes: Scope[] = [
  { kind: 'global', month },
  { kind: 'task', taskId: 't1' },
];

function setup(limits: Record<string, number>) {
  const store = new MemoryBudgetStore((k) => limits[k]);
  let n = 0;
  const gate = new CostGate(store, () => `r${++n}`, () => 1);
  return { store, gate };
}

describe('CostGate', () => {
  it('reserves and settles, moving reserved into spent', async () => {
    const { store, gate } = setup({ 'global_2026-10': eur(10), task_t1: eur(1) });
    const r = await gate.reserve({ scopes, category: 'tokens', amount: eur(0.4), description: 'call' });
    expect(store.budgets.get('task_t1')).toMatchObject({ reserved: eur(0.4), spent: 0 });
    const entry = await gate.settle(r.id, eur(0.1));
    expect(entry?.overrun).toBe(0);
    expect(store.budgets.get('task_t1')).toMatchObject({ reserved: 0, spent: eur(0.1) });
    expect(store.budgets.get('global_2026-10')).toMatchObject({ reserved: 0, spent: eur(0.1) });
    expect(store.ledger).toHaveLength(1);
  });

  it('refuses a reservation that would exceed any scope', async () => {
    const { gate } = setup({ 'global_2026-10': eur(10), task_t1: eur(1) });
    await gate.reserve({ scopes, category: 'tokens', amount: eur(0.8), description: 'a' });
    await expect(
      gate.reserve({ scopes, category: 'tokens', amount: eur(0.3), description: 'b' }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('enforces the global cap across tasks', async () => {
    const { gate } = setup({ 'global_2026-10': eur(1), task_t1: eur(5), task_t2: eur(5) });
    await gate.reserve({ scopes, category: 'infra', amount: eur(0.9), description: 'a' });
    const other: Scope[] = [{ kind: 'global', month }, { kind: 'task', taskId: 't2' }];
    await expect(
      gate.reserve({ scopes: other, category: 'infra', amount: eur(0.2), description: 'b' }),
    ).rejects.toMatchObject({ scopeKey: scopeKey({ kind: 'global', month }) });
  });

  it('does not change anything when a reservation is refused', async () => {
    const { store, gate } = setup({ 'global_2026-10': eur(10), task_t1: eur(0.1) });
    await expect(
      gate.reserve({ scopes, category: 'tokens', amount: eur(0.2), description: 'x' }),
    ).rejects.toThrow();
    expect(store.budgets.size).toBe(0);
    expect(store.reservations.size).toBe(0);
  });

  it('refuses everything while halted', async () => {
    const { store, gate } = setup({ 'global_2026-10': eur(10), task_t1: eur(1) });
    store.halted = true;
    await expect(
      gate.reserve({ scopes, category: 'tokens', amount: 1, description: 'x' }),
    ).rejects.toBeInstanceOf(HaltedError);
    expect(await gate.available(scopes)).toBe(0);
  });

  it('is safe under parallel reservations', async () => {
    const { store, gate } = setup({ 'global_2026-10': eur(10), task_t1: eur(1) });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        gate.reserve({ scopes, category: 'tokens', amount: eur(0.1), description: 'p' }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
    expect(store.budgets.get('task_t1')?.reserved).toBe(eur(1));
  });

  it('settles at most once', async () => {
    const { store, gate } = setup({ 'global_2026-10': eur(10), task_t1: eur(1) });
    const r = await gate.reserve({ scopes, category: 'tokens', amount: eur(0.5), description: 'x' });
    await gate.settle(r.id, eur(0.2));
    expect(await gate.settle(r.id, eur(0.2))).toBeUndefined();
    expect(store.budgets.get('task_t1')).toMatchObject({ reserved: 0, spent: eur(0.2) });
  });

  it('records overruns instead of hiding them', async () => {
    const { gate } = setup({ 'global_2026-10': eur(10), task_t1: eur(1) });
    const r = await gate.reserve({ scopes, category: 'action', amount: eur(0.1), description: 'x' });
    const entry = await gate.settle(r.id, eur(0.15));
    expect(entry?.overrun).toBe(eur(0.05));
  });

  it('withReservation charges the full reservation when the operation throws', async () => {
    const { store, gate } = setup({ 'global_2026-10': eur(10), task_t1: eur(1) });
    await expect(
      gate.withReservation({ scopes, category: 'tokens', amount: eur(0.3), description: 'x' }, async () => {
        throw new Error('model failed');
      }),
    ).rejects.toThrow('model failed');
    expect(store.budgets.get('task_t1')).toMatchObject({ reserved: 0, spent: eur(0.3) });
  });

  it('available returns the tightest scope', async () => {
    const { gate } = setup({ 'global_2026-10': eur(10), task_t1: eur(1) });
    await gate.reserve({ scopes, category: 'tokens', amount: eur(0.25), description: 'x' });
    expect(await gate.available(scopes)).toBe(eur(0.75));
  });
});
