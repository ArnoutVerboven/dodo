import { type CostGate, computeCost } from '@dodo/budget';
import {
  type Content,
  type FinishRequest,
  type HeartbeatResponse,
  paths,
  type RequestInputRequest,
  type Run,
  type RunEndReason,
  type TaskStatus,
} from '@dodo/core';
import type { Auth } from 'firebase-admin/auth';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { Storage } from 'firebase-admin/storage';
import {
  HEARTBEAT_MS,
  LEASE_MS,
  runUid,
  scopesForRun,
  stripUndefined,
  WORKER_GIB,
  WORKER_VCPU,
} from './runtime.js';

export type Notify = (n: {
  title: string;
  body: string;
  taskId: string;
  input?: { messageId: string; kind: 'text' | 'choice' | 'approval'; options?: string[] };
}) => Promise<void>;

export interface RunControlDeps {
  db: Firestore;
  auth: Auth;
  storage: Storage;
  costGate: CostGate;
  /** Push a "needs you" / "finished" notice to the user's channels. Never throws. */
  notify?: Notify;
  now?: () => number;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

export interface StartResponse {
  task: Record<string, unknown>;
  project: Record<string, unknown> | undefined;
  session: Content[];
  answer?: { prompt: string; value: string; suggestedRule?: string; alwaysAllow?: boolean };
  trigger: Run['trigger'];
  model: string;
  /** Merged permission rules: task, project and global. */
  policy: {
    profile: 'agent-decides' | 'untrusted';
    allow: string[];
    deny: string[];
    allowedHosts: string[];
  };
}

/** The permission rules a run is judged by: global, then project, then task, in that order. */
export function mergePolicy(
  task: Record<string, unknown>,
  project: Record<string, unknown> | undefined,
  settings: Record<string, unknown>,
): StartResponse['policy'] {
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  const ai = (task.ai ?? {}) as Record<string, unknown>;
  const pdefaults = (project?.defaults ?? {}) as Record<string, unknown>;
  return {
    profile: (ai.profile ?? pdefaults.profile ?? 'agent-decides') as 'agent-decides' | 'untrusted',
    allow: [...list(settings.allowRules), ...list(project?.allowRules), ...list(task.allowRules)],
    deny: [...list(settings.denyRules), ...list(project?.denyRules), ...list(task.denyRules)],
    allowedHosts: [
      ...list(settings.allowedHosts),
      ...list(project?.allowedHosts),
      ...list(task.allowedHosts),
    ],
  };
}

/** Policy for a run that has not started yet (the sandbox asks before the worker's first call). */
export async function policyForRun(db: Firestore, run: Run): Promise<StartResponse['policy']> {
  const [task, project, settings] = await Promise.all([
    db.doc(paths.task(run.taskId)).get(),
    run.projectId ? db.doc(paths.project(run.projectId)).get() : undefined,
    db.doc(paths.settings()).get(),
  ]);
  return mergePolicy(task.data() ?? {}, project?.data(), settings.data() ?? {});
}

/** First call of a worker: claimed → running, and the context it needs (session comes from Storage). */
export async function start(deps: RunControlDeps, run: Run): Promise<StartResponse> {
  const now = (deps.now ?? Date.now)();
  const taskSnap = await deps.db.doc(paths.task(run.taskId)).get();
  const task = { id: taskSnap.id, ...taskSnap.data() };
  const project = run.projectId
    ? (await deps.db.doc(paths.project(run.projectId)).get()).data()
    : undefined;
  const session = run.sessionPath ? await loadSession(deps, run.sessionPath).catch(() => []) : [];
  const raw = (await deps.db.doc(paths.run(run.id)).get()).data() as Record<string, unknown>;
  const settings = (await deps.db.doc(paths.settings()).get()).data() ?? {};
  const policy = mergePolicy(task, project, settings);
  await deps.db.doc(paths.run(run.id)).update({
    state: 'running',
    startedAt: now,
    lease: { owner: runUid(run.id), expiresAt: now + LEASE_MS },
    updatedAt: now,
    localToken: FieldValue.delete(),
  });
  await deps.db.doc(paths.task(run.taskId)).update({
    statusLine: { text: 'Working…', needsYou: false },
    updatedAt: now,
  });
  return {
    task,
    project: project ? { id: run.projectId, ...project } : undefined,
    session,
    answer: raw.answer as StartResponse['answer'],
    trigger: run.trigger,
    model: run.model,
    policy,
  };
}

/**
 * Heartbeat: renew the lease, meter infra for the next interval, report flags and new user
 * comments. The worker cannot write any of this itself.
 */
export async function heartbeat(deps: RunControlDeps, run: Run): Promise<HeartbeatResponse> {
  const now = (deps.now ?? Date.now)();
  const ref = deps.db.doc(paths.run(run.id));
  const settings = (await deps.db.doc(paths.settings()).get()).data() ?? {};
  const scopes = scopesForRun(run, now);

  // Settle the previous infra slice at its full reserved amount and reserve the next one.
  if (run.device === 'gcp') {
    const slice = computeCost(HEARTBEAT_MS / 1000, WORKER_VCPU, WORKER_GIB);
    const prev = (await ref.get()).get('infraReservation') as string | undefined;
    if (prev) await deps.costGate.settle(prev, slice);
    try {
      const r = await deps.costGate.reserve({
        scopes,
        category: 'infra',
        amount: slice,
        description: 'Cloud Run worker time',
        taskId: run.taskId,
        projectId: run.projectId,
        runId: run.id,
      });
      await ref.update({ infraReservation: r.id, spent: FieldValue.increment(prev ? slice : 0) });
    } catch {
      await ref.update({ infraReservation: FieldValue.delete() });
      return { ok: false, reason: 'budget_exhausted', remaining: 0, pendingMessages: [] };
    }
  }

  const fresh = (await ref.get()).data() as Run;
  if (settings.halted === true)
    return { ok: false, reason: 'halted', remaining: 0, pendingMessages: [] };
  if (fresh.interrupt)
    return { ok: false, reason: 'interrupted', remaining: 0, pendingMessages: [] };
  if (fresh.generation !== run.generation)
    return { ok: false, reason: 'lease_lost', remaining: 0, pendingMessages: [] };

  await ref.update({
    state: 'running',
    lease: { owner: runUid(run.id), expiresAt: now + LEASE_MS },
    startedAt: fresh.startedAt ?? now,
    updatedAt: now,
  });

  const since = fresh.startedAt ?? run.createdAt;
  const msgs = await deps.db
    .collection(paths.messages(run.taskId))
    .where('author', '==', 'user')
    .where('createdAt', '>', since)
    .orderBy('createdAt')
    .limit(20)
    .get();
  const pendingMessages = msgs.docs
    .filter((d) => !d.get('input'))
    .map((d) => ({
      id: d.id,
      body: d.get('body') as string,
      createdAt: d.get('createdAt') as number,
    }));

  return { ok: true, remaining: await deps.costGate.available(scopes), pendingMessages };
}

/** ask_user: store the session, post the question, park the task. The run ends here. */
export async function requestInput(
  deps: RunControlDeps,
  run: Run,
  req: Omit<RequestInputRequest, 'runId'>,
) {
  const now = (deps.now ?? Date.now)();
  const sessionPath = await saveSession(deps, run.id, req.session);
  const batch = deps.db.batch();
  const messageRef = deps.db.collection(paths.messages(run.taskId)).doc();
  batch.create(
    messageRef,
    stripUndefined({
      author: 'agent',
      body: req.prompt,
      runId: run.id,
      input: stripUndefined({
        kind: req.kind,
        prompt: req.prompt,
        options: req.options,
        suggestedRule: req.suggestedRule,
        costEstimate: req.costEstimate,
      }),
      createdAt: now,
    }),
  );
  batch.update(deps.db.doc(paths.run(run.id)), {
    state: 'waiting_input',
    sessionPath,
    endReason: 'waiting_input',
    endedAt: now,
    updatedAt: now,
    lease: FieldValue.delete(),
    infraReservation: FieldValue.delete(),
  });
  batch.update(deps.db.doc(paths.task(run.taskId)), {
    status: 'needs_input',
    activeRunId: FieldValue.delete(),
    statusLine: { text: `Waiting for you: ${req.prompt.slice(0, 100)}`, needsYou: true },
    updatedAt: now,
  });
  await batch.commit();
  await endRun(deps, run);
  const title = (await deps.db.doc(paths.task(run.taskId)).get()).get('title') as string;
  await deps.notify?.({
    title: `Needs you: ${title}`,
    body: req.prompt,
    taskId: run.taskId,
    input: { messageId: messageRef.id, kind: req.kind, options: req.options },
  });
}

const TASK_STATUS_AFTER: Record<RunEndReason, TaskStatus | undefined> = {
  finished: 'review',
  waiting_input: 'needs_input',
  interrupted: 'todo',
  budget_exhausted: 'needs_input',
  halted: 'todo',
  lease_lost: undefined,
  error: 'needs_input',
  max_steps: 'review',
};

/** Any end other than ask_user: archive, settle, release the task, revoke the identity. */
export async function finish(deps: RunControlDeps, run: Run, req: Omit<FinishRequest, 'runId'>) {
  const now = (deps.now ?? Date.now)();
  // A run reaped without a session (worker died) keeps whatever session it started from.
  const sessionPath = req.session.length
    ? await saveSession(deps, run.id, req.session)
    : run.sessionPath;
  const tracePath = await archiveTrace(deps, run.id);
  const state: Run['state'] =
    req.reason === 'finished' || req.reason === 'max_steps'
      ? 'succeeded'
      : req.reason === 'interrupted' || req.reason === 'halted'
        ? 'interrupted'
        : req.reason === 'budget_exhausted'
          ? 'budget_exhausted'
          : 'failed';

  const batch = deps.db.batch();
  batch.update(
    deps.db.doc(paths.run(run.id)),
    stripUndefined({
      state,
      endReason: req.reason,
      error: req.error,
      sessionPath,
      tracePath,
      endedAt: now,
      updatedAt: now,
      lease: FieldValue.delete(),
      infraReservation: FieldValue.delete(),
    }),
  );
  const taskRef = deps.db.doc(paths.task(run.taskId));
  const status = req.outcome === 'blocked' ? 'needs_input' : TASK_STATUS_AFTER[req.reason];
  const taskUpdate: Record<string, unknown> = { activeRunId: FieldValue.delete(), updatedAt: now };
  if (status) taskUpdate.status = status;
  if (req.reason === 'error' || req.reason === 'lease_lost') {
    taskUpdate.statusLine = { text: `Run stopped: ${req.error ?? req.reason}`, needsYou: true };
  }
  batch.update(taskRef, taskUpdate);

  if (req.reason === 'budget_exhausted') {
    const topUp = 500_000;
    batch.create(deps.db.collection(paths.messages(run.taskId)).doc(), {
      author: 'system',
      body: 'This task has used its budget.',
      runId: run.id,
      input: {
        kind: 'approval',
        prompt: 'This task has used its budget. Top it up by 0.50 EUR and continue?',
        costEstimate: topUp,
        topUp,
      },
      createdAt: now,
    });
    taskUpdate.statusLine = { text: 'Budget used up. Top up to continue?', needsYou: true };
    batch.update(taskRef, taskUpdate);
  } else if (req.reason === 'error') {
    batch.create(deps.db.collection(paths.messages(run.taskId)).doc(), {
      author: 'system',
      body: `The run failed: ${req.error ?? 'unknown error'}. Comment to retry.`,
      runId: run.id,
      createdAt: now,
    });
  }
  await batch.commit();
  await endRun(deps, run);
  const title = (await taskRef.get()).get('title') as string;
  const headline =
    req.reason === 'finished'
      ? `${req.outcome === 'done' ? 'Done' : req.outcome === 'blocked' ? 'Blocked' : 'Ready for review'}: ${title}`
      : req.reason === 'budget_exhausted'
        ? `Budget used up: ${title}`
        : req.reason === 'interrupted' || req.reason === 'halted'
          ? `Stopped: ${title}`
          : `Run failed: ${title}`;
  const summary =
    ((await taskRef.get()).get('statusLine') as { text?: string } | undefined)?.text ?? '';
  await deps.notify?.({ title: headline, body: req.error ?? summary, taskId: run.taskId });
}

/** Shared tail: settle the infra slice and make the run identity worthless. */
async function endRun(deps: RunControlDeps, run: Run) {
  const prev = (await deps.db.doc(paths.run(run.id)).get()).get('infraReservation') as
    | string
    | undefined;
  if (prev)
    await deps.costGate.settle(prev, computeCost(HEARTBEAT_MS / 1000, WORKER_VCPU, WORKER_GIB));
  try {
    await deps.auth.deleteUser(runUid(run.id));
  } catch (err) {
    if ((err as { code?: string }).code !== 'auth/user-not-found')
      deps.log?.('revoke failed', { err: String(err) });
  }
}

async function saveSession(
  deps: RunControlDeps,
  runId: string,
  session: Content[],
): Promise<string> {
  const path = paths.sessionBlob(runId);
  await deps.storage
    .bucket()
    .file(path)
    .save(JSON.stringify(session), { contentType: 'application/json' });
  return path;
}

export async function loadSession(
  deps: Pick<RunControlDeps, 'storage'>,
  path: string,
): Promise<Content[]> {
  const [buf] = await deps.storage.bucket().file(path).download();
  return JSON.parse(buf.toString('utf8')) as Content[];
}

/** Move the live trace out of Firestore into one JSON blob, so Firestore stays small. */
async function archiveTrace(deps: RunControlDeps, runId: string): Promise<string | undefined> {
  const events = await deps.db.collection(paths.runEvents(runId)).orderBy('seq').get();
  if (events.empty) return undefined;
  const path = paths.traceBlob(runId);
  await deps.storage
    .bucket()
    .file(path)
    .save(JSON.stringify(events.docs.map((d) => ({ id: d.id, ...d.data() }))), {
      contentType: 'application/json',
    });
  const batch = deps.db.batch();
  for (const d of events.docs) batch.delete(d.ref);
  await batch.commit();
  return path;
}

/**
 * Lease sweep: a worker that died (OOM, crash, cancelled execution) never calls finish. Runs
 * whose lease expired a while ago are ended as `lease_lost`, which releases the task and
 * settles the open infra reservation. Runs stuck in `claimed` (never started) are included.
 */
/** Reap one run if its lease expired; returns whether it was reaped. Used before enqueueing. */
export async function reapIfStale(
  deps: RunControlDeps,
  runId: string,
  graceMs = 2 * LEASE_MS,
): Promise<boolean> {
  const now = (deps.now ?? Date.now)();
  const snap = await deps.db.doc(paths.run(runId)).get();
  if (!snap.exists) return false;
  const run = { id: snap.id, ...snap.data() } as Run;
  if (!['claimed', 'running', 'dispatching', 'queued'].includes(run.state)) return false;
  const deadline = run.lease?.expiresAt ?? run.updatedAt;
  if (deadline + graceMs > now) return false;
  await finish(deps, run, {
    reason: 'lease_lost',
    error: 'The worker stopped responding.',
    session: [],
  });
  return true;
}

export async function reapStaleRuns(
  deps: RunControlDeps,
  graceMs = 2 * LEASE_MS,
): Promise<string[]> {
  const now = (deps.now ?? Date.now)();
  const live = await deps.db
    .collection(paths.runs())
    .where('state', 'in', ['claimed', 'running'])
    .get();
  const reaped: string[] = [];
  for (const d of live.docs) {
    const run = { id: d.id, ...d.data() } as Run;
    const deadline = run.lease?.expiresAt ?? run.updatedAt;
    if (deadline + graceMs > now) continue;
    await finish(deps, run, {
      reason: 'lease_lost',
      error: 'The worker stopped responding.',
      session: [],
    });
    reaped.push(run.id);
  }
  return reaped;
}
