import type { CostGate } from '@dodo/budget';
import { paths } from '@dodo/core';
import type { Firestore } from 'firebase-admin/firestore';

/**
 * Longest a reservation can legitimately stay open: a model call is bounded by the gateway's
 * 300 s timeout, an infra slice is renewed every 15 s. Anything older was left behind by a
 * process that died between reserve and settle.
 */
export const RESERVATION_MAX_AGE_MS = 30 * 60_000;

export interface SweepDeps {
  db: Firestore;
  costGate: CostGate;
  now?: () => number;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

/**
 * Settle reservations left open by a crashed or timed-out function, at their reserved amount
 * (the call may have run and been billed). Without this they hold budget on every scope forever.
 */
export async function sweepReservations(
  deps: SweepDeps,
  maxAgeMs = RESERVATION_MAX_AGE_MS,
): Promise<string[]> {
  const now = (deps.now ?? Date.now)();
  const stale = await deps.db
    .collection(paths.reservations())
    .where('settled', '==', false)
    .where('createdAt', '<', now - maxAgeMs)
    .limit(200)
    .get();
  const swept: string[] = [];
  for (const d of stale.docs) {
    const amount = d.get('amount') as number;
    try {
      await deps.costGate.settle(d.id, amount);
      swept.push(d.id);
    } catch (err) {
      deps.log?.('reservation sweep failed', { reservationId: d.id, err: String(err) });
    }
  }
  if (swept.length) {
    deps.log?.('settled abandoned reservations', {
      count: swept.length,
      runs: [...new Set(stale.docs.map((d) => d.get('runId')).filter(Boolean))],
    });
  }
  return swept;
}
