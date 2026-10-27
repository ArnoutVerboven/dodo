import { affordableSeconds, type CostGate } from '@dodo/budget';
import { type Device, deviceIdFromChoice, isDeviceOnline, paths, type Run } from '@dodo/core';
import type { Auth } from 'firebase-admin/auth';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { runUid, scopesForRun, WORKER_GIB, WORKER_VCPU } from './runtime.js';

/** Starts a worker for a run. Remote: a Cloud Run Job execution. Local (emulator): nothing;
 * the dev worker script picks up `dispatching` runs itself. */
export interface Executor {
  start(run: Run, env: Record<string, string>, timeoutSeconds: number): Promise<string>;
}

export interface DispatcherDeps {
  db: Firestore;
  auth: Auth;
  costGate: CostGate;
  executor: Executor;
  now?: () => number;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

const MIN_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 3600;

/**
 * Idempotent: Firestore triggers fire at least once, so the state change queued → dispatching
 * happens in a transaction and a second invocation finds nothing to do.
 */
export async function dispatch(
  deps: DispatcherDeps,
  runId: string,
): Promise<'started' | 'skipped' | 'deferred'> {
  const now = (deps.now ?? Date.now)();
  const ref = deps.db.doc(paths.run(runId));
  type Step = { kind: 'start' | 'defer'; run: Run } | undefined;
  const step = await deps.db.runTransaction(async (t): Promise<Step> => {
    const snap = await t.get(ref);
    const run = snap.data() as Run | undefined;
    if (run?.state !== 'queued') return undefined;
    if (run.device !== 'gcp') return { kind: 'defer', run: { ...run, id: runId } }; // a Mac daemon claims it
    const generation = (run.generation ?? 0) + 1;
    t.update(ref, {
      state: 'dispatching',
      generation,
      attempts: FieldValue.increment(1),
      updatedAt: now,
    });
    return { kind: 'start', run: { ...run, id: runId, generation } };
  });
  if (!step) return 'skipped';
  if (step.kind === 'defer') {
    await deferToDevice(deps, step.run, now);
    return 'deferred';
  }
  const claimed = step.run;

  try {
    const remaining = await deps.costGate.available(scopesForRun(claimed, now));
    const timeoutSeconds = Math.max(
      MIN_TIMEOUT_S,
      Math.min(MAX_TIMEOUT_S, affordableSeconds(remaining, WORKER_VCPU, WORKER_GIB)),
    );
    // Needs roles/iam.serviceAccountTokenCreator on the gateway account itself (signBlob).
    const token = await deps.auth.createCustomToken(runUid(runId), {
      run: runId,
      taskId: claimed.taskId,
      generation: claimed.generation,
    });
    const execution = await deps.executor.start(
      claimed,
      { DODO_RUN_ID: runId, DODO_RUN_TOKEN: token, DODO_TIMEOUT_S: String(timeoutSeconds) },
      timeoutSeconds,
    );
    await ref.update({ state: 'claimed', execution, updatedAt: now });
    return 'started';
  } catch (err) {
    deps.log?.('executor start failed', { runId, err: String(err) });
    await ref.update({
      state: 'failed',
      endReason: 'error',
      error: `Could not start worker: ${String(err)}`,
      updatedAt: now,
    });
    await deps.db.doc(paths.task(claimed.taskId)).update({
      activeRunId: FieldValue.delete(),
      status: 'needs_input',
      statusLine: { text: 'Could not start the worker. Comment to retry.', needsYou: true },
      updatedAt: now,
    });
    return 'skipped';
  }
}

/**
 * A run addressed to a Mac stays queued until its daemon claims it. The task says what it is
 * waiting for; a run addressed to a Mac that is not paired fails right away instead of hanging.
 */
async function deferToDevice(deps: DispatcherDeps, run: Run, now: number) {
  const deviceId = deviceIdFromChoice(run.device);
  const device = deviceId
    ? ((await deps.db.doc(paths.device(deviceId)).get()).data() as Device | undefined)
    : undefined;
  const taskRef = deps.db.doc(paths.task(run.taskId));
  if (device?.state !== 'approved') {
    await deps.db.doc(paths.run(run.id)).update({
      state: 'failed',
      endReason: 'error',
      error: `Device ${run.device} is not paired`,
      endedAt: now,
      updatedAt: now,
    });
    await taskRef.update({
      activeRunId: FieldValue.delete(),
      status: 'needs_input',
      statusLine: {
        text: 'This Mac is not paired. Pick another device in the AI settings.',
        needsYou: true,
      },
      updatedAt: now,
    });
    return;
  }
  const text = isDeviceOnline(device.lastSeen, now)
    ? `Waiting for ${device.name}`
    : `Waiting for ${device.name} (offline since ${new Date(device.lastSeen ?? run.createdAt).toISOString().slice(11, 16)} UTC)`;
  await taskRef.update({ statusLine: { text, needsYou: false }, updatedAt: now });
}
