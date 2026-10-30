import { randomUUID } from 'node:crypto';
import { paths } from '@dodo/core';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { afterAll, describe, expect, it } from 'vitest';
import { RESERVATION_MAX_AGE_MS, sweepReservations } from './reservations.js';
import { costGateFor } from './runtime.js';

const enabled = !!process.env.FIRESTORE_EMULATOR_HOST;
const app = enabled ? initializeApp({ projectId: 'demo-dodo' }, 'reservations-test') : undefined;
const db = app ? getFirestore(app) : undefined;

describe.skipIf(!enabled)('sweepReservations', () => {
  afterAll(async () => {
    if (app) await deleteApp(app);
  });

  it('settles abandoned reservations and gives the reserved room back', async () => {
    const d = db as NonNullable<typeof db>;
    const taskId = `t-${randomUUID()}`;
    const gate = costGateFor(d);
    const scopes = [{ kind: 'task' as const, taskId }];
    const old = await gate.reserve({ scopes, category: 'tokens', amount: 1000, description: 'x' });
    const fresh = await gate.reserve({ scopes, category: 'tokens', amount: 500, description: 'y' });
    // Age the first one past the limit (other tests' fresh reservations stay out of it).
    const now = Date.now();
    await d
      .collection(paths.reservations())
      .doc(old.id)
      .update({ createdAt: now - RESERVATION_MAX_AGE_MS - 60_000 });

    const swept = await sweepReservations({ db: d, costGate: gate, now: () => now });
    expect(swept).toContain(old.id);
    expect(swept).not.toContain(fresh.id);

    const budget = (await d.doc(paths.budget(`task_${taskId}`)).get()).data();
    expect(budget?.reserved).toBe(500);
    expect(budget?.spent).toBe(1000);
    // Settled once: a second sweep finds nothing of this task's.
    expect(await sweepReservations({ db: d, costGate: gate, now: () => now })).not.toContain(
      old.id,
    );
  });
});
