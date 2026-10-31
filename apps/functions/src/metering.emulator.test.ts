import { randomUUID } from 'node:crypto';
import { computeCost } from '@dodo/budget';
import { paths, type Run } from '@dodo/core';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import type { Auth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import type { Storage } from 'firebase-admin/storage';
import { afterAll, describe, expect, it } from 'vitest';
import { meterInfra } from './run-control.js';
import { costGateFor, HEARTBEAT_MS, WORKER_GIB, WORKER_VCPU } from './runtime.js';

const enabled = !!process.env.FIRESTORE_EMULATOR_HOST;
const app = enabled ? initializeApp({ projectId: 'demo-dodo' }, 'metering-test') : undefined;
const db = app ? getFirestore(app) : undefined;

const deps = () => {
  const d = db as NonNullable<typeof db>;
  return {
    db: d,
    auth: {} as Auth,
    storage: {} as Storage,
    costGate: costGateFor(d),
  };
};

async function seedRun(): Promise<Run> {
  const d = db as NonNullable<typeof db>;
  const runId = `r-${randomUUID()}`;
  const run = {
    taskId: `t-${randomUUID()}`,
    device: 'gcp',
    model: 'gemini-3.8-flash',
    state: 'running' as const,
    trigger: 'new' as const,
    generation: 1,
    interrupt: false,
    compact: false,
    attempts: 1,
    spent: 0,
    steps: 0,
    // A live lease, so the reaper test running against the same emulator leaves it alone.
    lease: { owner: 'run:x', expiresAt: Date.now() + 3_600_000 },
    createdAt: 1,
    updatedAt: 1,
  };
  await d.doc(paths.run(runId)).set(run);
  return { id: runId, ...run };
}

const cost = (ms: number) => computeCost(ms / 1000, WORKER_VCPU, WORKER_GIB);

describe.skipIf(!enabled)('meterInfra', () => {
  afterAll(async () => {
    if (app) await deleteApp(app);
  });

  it('charges the time that passed, not a full slice per beat', async () => {
    const d = db as NonNullable<typeof db>;
    const run = await seedRun();
    const t0 = 1_000_000;
    await meterInfra(deps(), run, t0);
    // Three quick beats 2 s apart (one per agent step).
    for (const t of [t0 + 2000, t0 + 4000, t0 + 6000]) await meterInfra(deps(), run, t);
    const budget = (await d.doc(paths.budget(`task_${run.taskId}`)).get()).data();
    const expected = 3 * cost(2000);
    expect(budget?.spent).toBe(expected);
    expect(budget?.spent).toBeLessThan(3 * cost(HEARTBEAT_MS));
    // One slice is held for the next interval, no more.
    expect(budget?.reserved).toBe(cost(HEARTBEAT_MS));
  });

  it('keeps one open reservation when two beats overlap', async () => {
    const d = db as NonNullable<typeof db>;
    const run = await seedRun();
    const t0 = 2_000_000;
    await meterInfra(deps(), run, t0);
    await Promise.all([meterInfra(deps(), run, t0 + 5000), meterInfra(deps(), run, t0 + 5000)]);
    const budget = (await d.doc(paths.budget(`task_${run.taskId}`)).get()).data();
    expect(budget?.reserved).toBe(cost(HEARTBEAT_MS));
    const open = await d
      .collection(paths.reservations())
      .where('runId', '==', run.id)
      .where('settled', '==', false)
      .get();
    expect(open.size).toBe(1);
  });
});
