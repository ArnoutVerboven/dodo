import { CostGate, type Scope, scopesForTask } from '@dodo/budget';
import { defaultLimitFor, FirestoreBudgetStore } from '@dodo/budget/firestore';
import { paths, Run, type Run as RunT } from '@dodo/core';
import type { Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

/** Lease duration the heartbeat renews; a worker missing three beats loses the run. */
export const LEASE_MS = 60_000;
export const HEARTBEAT_MS = 15_000;
/** Cloud Run worker shape; drives infra metering and the execution timeout. */
export const WORKER_VCPU = 1;
export const WORKER_GIB = 1;

export interface Caller {
  uid: string;
  claims: Record<string, unknown>;
}

export const runUid = (runId: string) => `run:${runId}`;

export function costGateFor(db: Firestore): CostGate {
  return new CostGate(new FirestoreBudgetStore(db, defaultLimitFor(db)));
}

export function scopesForRun(run: Pick<RunT, 'taskId' | 'projectId'>, now = Date.now()): Scope[] {
  return scopesForTask(run.taskId, run.projectId, now);
}

/**
 * Every control-plane call from a worker is checked the same way: the caller is the run's own
 * identity, its lease generation is current, and the run is still live.
 */
export async function loadRunForCaller(
  db: Firestore,
  caller: Caller | undefined,
  runId: string,
  liveStates: RunT['state'][] = ['claimed', 'running'],
): Promise<RunT> {
  if (!caller) throw new HttpsError('unauthenticated', 'Sign in first');
  const snap = await db.doc(paths.run(runId)).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Unknown run');
  const parsed = Run.safeParse({ id: snap.id, ...snap.data() });
  if (!parsed.success) throw new HttpsError('internal', 'Corrupt run document');
  const run = parsed.data;
  const isOwner = caller.claims.dodo_owner === true;
  const isRun = caller.uid === runUid(runId) && caller.claims.run === runId;
  if (!isRun && !isOwner) throw new HttpsError('permission-denied', 'Not this run');
  if (isRun && caller.claims.generation !== run.generation) {
    throw new HttpsError('failed-precondition', 'lease_lost');
  }
  if (!liveStates.includes(run.state)) {
    throw new HttpsError('failed-precondition', `Run is ${run.state}`);
  }
  return run;
}

export function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
