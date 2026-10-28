import { scopeKey, scopesForTask } from '@dodo/budget';
import { describe, expect, it } from 'vitest';
import { tightestScope } from './gateway.js';

const gate = (rooms: Record<string, number>) => ({
  available: async (scopes: Parameters<typeof scopeKey>[0][]) =>
    Math.min(...scopes.map((s) => rooms[scopeKey(s)] ?? Number.MAX_SAFE_INTEGER)),
});

describe('tightestScope', () => {
  const scopes = scopesForTask('t1', 'p1', Date.UTC(2026, 9, 28));
  const month = '2026-10';

  it("names the task's budget when it is the one that is out", async () => {
    const found = await tightestScope(
      gate({ total: 34_000_000, [`global_${month}`]: 20_000_000, task_t1: 0 }),
      scopes,
    );
    expect(found).toEqual({ key: 'task_t1', room: 0 });
  });

  it('names the month when it is tighter than the task', async () => {
    const found = await tightestScope(
      gate({ total: 34_000_000, [`global_${month}`]: 10_000, task_t1: 400_000 }),
      scopes,
    );
    expect(found).toEqual({ key: `global_${month}`, room: 10_000 });
  });

  it('prefers the task on a tie, since a top-up fixes that one', async () => {
    const found = await tightestScope(
      gate({ total: 0, [`global_${month}`]: 0, task_t1: 0, [`project_p1_${month}`]: 0 }),
      scopes,
    );
    expect(found.key).toBe('task_t1');
  });
});
