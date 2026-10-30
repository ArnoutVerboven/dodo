import { randomUUID } from 'node:crypto';
import { scopesForTask, toolCost, toolReservation } from '@dodo/budget';
import { paths } from '@dodo/core';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_HOURLY_CAP } from './gateway.js';
import { FakeProvider } from './model-provider.js';
import { costGateFor } from './runtime.js';
import { searchWithBudget } from './search.js';

const enabled = !!process.env.FIRESTORE_EMULATOR_HOST;
const app = enabled ? initializeApp({ projectId: 'demo-dodo' }, 'search-test') : undefined;
const db = app ? getFirestore(app) : undefined;

describe.skipIf(!enabled)('searchWithBudget', () => {
  afterAll(async () => {
    if (app) await deleteApp(app);
  });

  async function seed(budget: number) {
    const d = db as NonNullable<typeof db>;
    const taskId = `t-${randomUUID()}`;
    const runId = `r-${randomUUID()}`;
    await d.doc(paths.task(taskId)).set({
      title: 'Find opening hours',
      status: 'running',
      ai: { enabled: true, budget },
      createdAt: 1,
      updatedAt: 1,
    });
    await d.doc(paths.run(runId)).set({ taskId, state: 'running', spent: 0, steps: 0 });
    const deps = {
      db: d,
      costGate: costGateFor(d),
      provider: new FakeProvider(),
      hourlyCap: DEFAULT_HOURLY_CAP,
    };
    const ctx = {
      scopes: scopesForTask(taskId, undefined, Date.now()),
      taskId,
      runId,
      description: 'web_search: test',
    };
    return { d, taskId, runId, deps, ctx };
  }

  it('charges the queries and tokens to the task, the run and the ledger', async () => {
    const { d, taskId, runId, deps, ctx } = await seed(1_000_000);
    const r = await searchWithBudget(deps, ctx, 'Atomium opening hours');
    expect(r.sources).toHaveLength(2);
    // The fake runs two queries and cites sources: both are billed.
    const expected = toolCost('web_search', 2, { input: 40, output: 60 });
    expect(r.cost).toBe(expected);

    const task = (await d.doc(paths.budget(`task_${taskId}`)).get()).data();
    expect(task?.spent).toBe(expected);
    expect(task?.reserved).toBe(0);
    expect((await d.doc(paths.run(runId)).get()).get('spent')).toBe(expected);
    const ledger = await d.collection(paths.ledger()).where('runId', '==', runId).get();
    expect(ledger.docs).toHaveLength(1);
    expect(ledger.docs[0]?.data()).toMatchObject({
      category: 'action',
      actual: expected,
      reserved: toolReservation('web_search'),
      overrun: 0,
    });
  });

  it('bills no query when nothing was found', async () => {
    const { deps, ctx } = await seed(1_000_000);
    const r = await searchWithBudget(deps, ctx, 'nothing at all');
    expect(r.sources).toHaveLength(0);
    expect(r.cost).toBe(toolCost('web_search', 0, { input: 40, output: 60 }));
  });

  it("refuses with the task's budget when it cannot cover the search", async () => {
    const { d, taskId, runId, deps, ctx } = await seed(10_000);
    await expect(searchWithBudget(deps, ctx, 'Atomium')).rejects.toThrow(
      /budget_exhausted\(task\)/,
    );
    const ledger = await d.collection(paths.ledger()).where('runId', '==', runId).get();
    expect(ledger.docs).toHaveLength(0);
    const task = (await d.doc(paths.budget(`task_${taskId}`)).get()).data();
    expect(task?.spent ?? 0).toBe(0);
  });
});
