import { randomUUID } from 'node:crypto';
import { type CostGate, computeCost, contextWindow } from '@dodo/budget';
import {
  type Content,
  type FinishRequest,
  type HeartbeatResponse,
  type NotificationKind,
  paths,
  type RequestInputRequest,
  type Run,
  type RunEndReason,
  type RunGoogleAccess,
  type RunToolAccess,
  type TaskStatus,
} from '@dodo/core';
import type { Auth } from 'firebase-admin/auth';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { Storage } from 'firebase-admin/storage';
import { googleAccessForRun } from './google-tools.js';
import { toolAccessForRun } from './mcp.js';
import {
  HEARTBEAT_MS,
  LEASE_MS,
  runUid,
  scopesForRun,
  stripUndefined,
  workerShape,
} from './runtime.js';
import { enqueueRun } from './triggers.js';
import type { VaultSecretStore } from './vault.js';

export type Notify = (n: {
  /** Which Settings checkbox decides whether Telegram sends it. */
  kind: NotificationKind;
  title: string;
  body: string;
  taskId: string;
  input?: {
    messageId: string;
    kind: 'text' | 'choice' | 'approval';
    options?: string[];
    suggestedRule?: string;
  };
  /** A picture that goes with the question (a QR code, the icon to pick), sent as a photo. */
  image?: { data: Buffer; mimeType: string };
}) => Promise<void>;

export interface RunControlDeps {
  db: Firestore;
  auth: Auth;
  storage: Storage;
  costGate: CostGate;
  /** Push a "needs you" / "finished" notice to the user's channels. Never throws. */
  notify?: Notify;
  /** The agent is through with the task's Telegram messages: 👀 becomes 👍. Never throws. */
  ackTelegram?: (taskId: string) => Promise<void>;
  /** Where remote MCP servers' Authorization headers are kept (the vault's secret). */
  mcpSecrets?: Pick<VaultSecretStore, 'read'>;
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
  /** The model's context window, for compacting the conversation before it overflows. */
  contextWindow: number;
  /** The run gets browser tools (its executor provides them: your Chrome, or headless Chromium). */
  browser: boolean;
  /** The task's browser setting: `auto` lets the agent step up with request_browser. */
  browserSetting: 'none' | 'auto' | 'chrome';
  /** Merged permission rules: task, project and global. */
  policy: {
    profile: 'agent-decides' | 'untrusted';
    allow: string[];
    deny: string[];
    allowedHosts: string[];
  };
  /** Tools view: which built-ins and MCP servers this run gets. Absent: every built-in. */
  tools?: RunToolAccess;
  /** Google is connected (Settings › Integrations): the run gets the Google tools it has scopes for. */
  google?: RunGoogleAccess;
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
  // A broken tool setting must not keep the run from starting: it then gets the built-ins.
  const tools = await toolAccessForRun(deps.db, run, deps.mcpSecrets).catch((err) => {
    deps.log?.('tool access failed', { runId: run.id, err: String(err) });
    return undefined;
  });
  const google = await googleAccessForRun(deps.db).catch((err) => {
    deps.log?.('google access failed', { runId: run.id, err: String(err) });
    return undefined;
  });
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
    contextWindow: contextWindow(run.model),
    browser: run.browser === true,
    browserSetting: browserSettingOf(task, project),
    policy,
    ...(tools ? { tools } : {}),
    ...(google ? { google } : {}),
  };
}

function browserSettingOf(
  task: Record<string, unknown>,
  project: Record<string, unknown> | undefined,
): StartResponse['browserSetting'] {
  const ai = (task.ai ?? {}) as Record<string, unknown>;
  const pdefaults = (project?.defaults ?? {}) as Record<string, unknown>;
  const v = ai.browser ?? pdefaults.browser;
  return v === 'auto' || v === 'chrome' ? v : 'none';
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
    const shape = workerShape(run);
    const slice = computeCost(HEARTBEAT_MS / 1000, shape.vcpu, shape.gib);
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
      return {
        ok: false,
        reason: 'budget_exhausted',
        remaining: 0,
        pendingMessages: [],
        compact: false,
      };
    }
  }

  const fresh = (await ref.get()).data() as Run;
  if (settings.halted === true)
    return { ok: false, reason: 'halted', remaining: 0, pendingMessages: [], compact: false };
  if (fresh.interrupt)
    return { ok: false, reason: 'interrupted', remaining: 0, pendingMessages: [], compact: false };
  if (fresh.generation !== run.generation)
    return { ok: false, reason: 'lease_lost', remaining: 0, pendingMessages: [], compact: false };

  await ref.update({
    state: 'running',
    lease: { owner: runUid(run.id), expiresAt: now + LEASE_MS },
    startedAt: fresh.startedAt ?? now,
    updatedAt: now,
    // A compaction request is handed over once.
    ...(fresh.compact ? { compact: false } : {}),
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

  // A run holding for an answer gets it here, and the task goes back to working.
  const answer = fresh.awaiting ? await heldAnswer(deps, run, fresh.awaiting.messageId) : undefined;
  if (answer) {
    await ref.update({ awaiting: FieldValue.delete(), updatedAt: now });
    await deps.db.doc(paths.task(run.taskId)).update({
      status: 'in_progress',
      statusLine: { text: 'Working…', needsYou: false },
      updatedAt: now,
    });
  }

  return {
    ok: true,
    remaining: await deps.costGate.available(scopes),
    pendingMessages,
    compact: fresh.compact === true,
    ...(answer ? { answer } : {}),
  };
}

async function heldAnswer(
  deps: RunControlDeps,
  run: Run,
  messageId: string,
): Promise<HeartbeatResponse['answer']> {
  const msg = (await deps.db.doc(`${paths.messages(run.taskId)}/${messageId}`).get()).data() as
    | {
        input?: {
          prompt: string;
          suggestedRule?: string;
          answer?: { value: string; alwaysAllow?: unknown };
        };
      }
    | undefined;
  const a = msg?.input?.answer;
  if (!a) return undefined;
  return stripUndefined({
    messageId,
    prompt: msg?.input?.prompt ?? '',
    value: a.value,
    suggestedRule: msg?.input?.suggestedRule,
    alwaysAllow: !!a.alwaysAllow,
  });
}

/**
 * ask_user: store the session and post the question. Without a hold the run ends here and
 * the answer starts a new one. With a hold the worker stays (a remote browser keeps its page
 * and logins): the task is parked for the user but keeps the run, the heartbeat delivers the
 * answer, and the worker parks the run itself (`finish(waiting_input)`) when the hold runs out.
 */
export async function requestInput(
  deps: RunControlDeps,
  run: Run,
  req: Omit<RequestInputRequest, 'runId'>,
): Promise<{ messageId: string }> {
  const now = (deps.now ?? Date.now)();
  const sessionPath = await saveSession(deps, run.id, req.session);
  const messageRef = deps.db.collection(paths.messages(run.taskId)).doc();
  const image = req.image
    ? await saveInputImage(deps, run.taskId, messageRef.id, req.image)
    : undefined;
  const batch = deps.db.batch();
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
        secret: req.secret && req.kind === 'text' ? true : undefined,
        costEstimate: req.costEstimate,
        image: image && { storagePath: image.storagePath, mimeType: image.mimeType },
      }),
      createdAt: now,
    }),
  );
  if (req.holdMs) {
    batch.update(deps.db.doc(paths.run(run.id)), {
      sessionPath,
      awaiting: { messageId: messageRef.id, until: now + req.holdMs },
      updatedAt: now,
    });
    batch.update(deps.db.doc(paths.task(run.taskId)), {
      status: 'needs_input',
      statusLine: { text: `Waiting for you: ${req.prompt.slice(0, 100)}`, needsYou: true },
      updatedAt: now,
    });
    await batch.commit();
  } else {
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
  }
  const title = (await deps.db.doc(paths.task(run.taskId)).get()).get('title') as string;
  await deps.notify?.({
    kind: req.kind === 'approval' ? 'approval' : 'question',
    title: `Needs you: ${title}`,
    body: req.prompt,
    taskId: run.taskId,
    input: stripUndefined({
      messageId: messageRef.id,
      kind: req.kind,
      options: req.options,
      suggestedRule: req.suggestedRule,
      secret: req.secret && req.kind === 'text' ? true : undefined,
    }),
    image: image && { data: image.data, mimeType: image.mimeType },
  });
  // Asking the next question means the messages before it were read.
  await deps.ackTelegram?.(run.taskId);
  return { messageId: messageRef.id };
}

const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** A question's picture, next to the task's files, so the owner's app can show it. */
async function saveInputImage(
  deps: RunControlDeps,
  taskId: string,
  messageId: string,
  image: NonNullable<RequestInputRequest['image']>,
): Promise<{ storagePath: string; mimeType: string; data: Buffer } | undefined> {
  const data = Buffer.from(image.data, 'base64');
  if (!data.length) return undefined;
  const storagePath = `tasks/${taskId}/inputs/${messageId}.${IMAGE_EXT[image.mimeType] ?? 'img'}`;
  try {
    await deps.storage
      .bucket()
      .file(storagePath)
      .save(data, {
        contentType: image.mimeType,
        resumable: false,
        // The web app reads it with getDownloadURL, which needs a download token.
        metadata: { metadata: { firebaseStorageDownloadTokens: randomUUID() } },
      });
  } catch (err) {
    // The question matters more than its picture.
    deps.log?.('input image save failed', { err: String(err) });
    return undefined;
  }
  return { storagePath, mimeType: image.mimeType, data };
}

/**
 * Where the task goes when its run ends. Never `todo` or `in_progress` with the run released:
 * that is what starts a run (onTaskChanged), so a stopped task would start again at once.
 */
const TASK_STATUS_AFTER: Record<RunEndReason, TaskStatus | undefined> = {
  finished: 'review',
  waiting_input: 'needs_input',
  // Stopped by the user or the kill switch: it waits for them (a comment, or back to To do).
  interrupted: 'needs_input',
  budget_exhausted: 'needs_input',
  halted: 'needs_input',
  lease_lost: undefined,
  error: 'needs_input',
  max_steps: 'review',
  needs_browser: 'in_progress',
  needs_device: 'in_progress',
};

/** The Macs a run can move to. */
async function pairedMacs(deps: RunControlDeps): Promise<string[]> {
  const snap = await deps.db.collection(paths.devices()).where('state', '==', 'approved').get();
  return snap.docs.map((d) => d.id);
}

/**
 * Any end other than ask_user: archive, settle, release the task, revoke the identity. Two
 * ends continue by themselves: `waiting_input` from a worker whose hold ran out (the answer
 * starts a new run, as if there had been no hold), and `needs_browser` (a new run with a
 * browser picks the session up at once).
 */
export async function finish(deps: RunControlDeps, run: Run, req: Omit<FinishRequest, 'runId'>) {
  const now = (deps.now ?? Date.now)();
  // A run reaped without a session (worker died) keeps whatever session it started from.
  const sessionPath = req.session.length
    ? await saveSession(deps, run.id, req.session)
    : run.sessionPath;
  const tracePath = await archiveTrace(deps, run.id);
  const state: Run['state'] =
    req.reason === 'finished' ||
    req.reason === 'max_steps' ||
    req.reason === 'needs_browser' ||
    req.reason === 'needs_device'
      ? 'succeeded'
      : req.reason === 'waiting_input'
        ? 'waiting_input'
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
      awaiting: FieldValue.delete(),
    }),
  );
  const taskRef = deps.db.doc(paths.task(run.taskId));
  const status = req.outcome === 'blocked' ? 'needs_input' : TASK_STATUS_AFTER[req.reason];
  const taskUpdate: Record<string, unknown> = { activeRunId: FieldValue.delete(), updatedAt: now };
  if (status) taskUpdate.status = status;
  if (req.reason === 'error' || req.reason === 'lease_lost') {
    taskUpdate.statusLine = { text: `Run stopped: ${req.error ?? req.reason}`, needsYou: true };
  }
  if (req.reason === 'interrupted' || req.reason === 'halted') {
    taskUpdate.statusLine = {
      text:
        req.reason === 'halted'
          ? 'Stopped: processing is halted'
          : 'Stopped. Comment or move it to To do to continue.',
      needsYou: false,
    };
  }
  if (req.reason === 'needs_browser') {
    taskUpdate.statusLine = { text: 'Starting again with a browser…', needsYou: false };
  }
  // Moving to the Mac needs one paired; otherwise the task waits for the user.
  const macs = req.reason === 'needs_device' ? await pairedMacs(deps) : [];
  if (req.reason === 'needs_device') {
    if (macs.length) {
      taskUpdate.statusLine = { text: 'Moving to your Mac…', needsYou: false };
    } else {
      taskUpdate.status = 'needs_input';
      taskUpdate.statusLine = { text: 'Needs your Mac: pair one under Settings', needsYou: true };
      batch.create(deps.db.collection(paths.messages(run.taskId)).doc(), {
        author: 'system',
        body: 'This step needs the browser on your Mac (an itsme or device-bound login), but no Mac is paired. Pair one under Settings › Devices, then comment to continue.',
        runId: run.id,
        createdAt: now,
      });
    }
  }
  batch.update(taskRef, taskUpdate);

  if (req.reason === 'budget_exhausted') {
    const cap = exhaustedCap(req.error);
    if (cap.kind === 'task') {
      // Enough for the call that was refused, at least 0.50 EUR, so one top-up gets it going.
      const topUp = Math.max(500_000, Math.ceil((cap.needed ?? 0) / 100_000) * 100_000);
      const eur = (topUp / 1_000_000).toFixed(2);
      batch.create(deps.db.collection(paths.messages(run.taskId)).doc(), {
        author: 'system',
        body: `This task has used its budget${cap.why ? `: ${cap.why}` : ''}.`,
        runId: run.id,
        input: {
          kind: 'approval',
          prompt: `This task has used its budget. Top it up by ${eur} EUR and continue?`,
          costEstimate: topUp,
          topUp,
        },
        createdAt: now,
      });
      taskUpdate.statusLine = { text: 'Budget used up. Top up to continue?', needsYou: true };
    } else {
      // A cap a task top-up cannot move: say which, and where it is raised.
      const where = cap.kind === 'project' ? 'on the project' : 'under Settings › Budget';
      batch.create(deps.db.collection(paths.messages(run.taskId)).doc(), {
        author: 'system',
        body: `Budget cap reached: ${cap.why}. Raise it ${where}, then comment to continue.`,
        runId: run.id,
        createdAt: now,
      });
      taskUpdate.statusLine = { text: 'Budget cap reached. Raise it to continue?', needsYou: true };
    }
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
  // The agent is through with what it was told, unless the run goes on in another one: a held
  // question was already acknowledged when it was asked, and a move to a browser or the Mac
  // continues the same work.
  const continues =
    req.reason === 'waiting_input' ||
    req.reason === 'needs_browser' ||
    (req.reason === 'needs_device' && macs.length > 0);
  if (!continues) await deps.ackTelegram?.(run.taskId);

  if (req.reason === 'waiting_input') {
    // The question was posted (and announced) when the hold began. If the answer came in the
    // moment the hold ended, nobody else will start the resume: do it here.
    const held = run.awaiting?.messageId;
    const answered = held ? await heldAnswer(deps, run, held) : undefined;
    if (answered) {
      await enqueueRun({ db: deps.db, now: deps.now, log: deps.log }, run.taskId, {
        trigger: 'resume',
        sessionPath,
        browser: run.browser,
        answer: answered,
      });
    }
    return;
  }
  if (req.reason === 'needs_browser') {
    const id = await enqueueRun({ db: deps.db, now: deps.now, log: deps.log }, run.taskId, {
      trigger: 'resume',
      sessionPath,
      browser: true,
    });
    deps.log?.('run restarted with a browser', { taskId: run.taskId, runId: id });
    return;
  }
  if (req.reason === 'needs_device') {
    if (!macs.length) return;
    const id = await enqueueRun({ db: deps.db, now: deps.now, log: deps.log }, run.taskId, {
      trigger: 'resume',
      sessionPath,
      browser: true,
      device: 'mac',
    });
    deps.log?.('run moved to the Mac', { taskId: run.taskId, runId: id });
    return;
  }

  const title = (await taskRef.get()).get('title') as string;
  const headline =
    req.reason === 'finished'
      ? `${req.outcome === 'done' ? 'Done' : req.outcome === 'blocked' ? 'Blocked' : 'Ready for review'}: ${title}`
      : req.reason === 'budget_exhausted'
        ? `Budget used up: ${title}`
        : req.reason === 'interrupted' || req.reason === 'halted'
          ? `Stopped: ${title}`
          : req.reason === 'needs_device'
            ? `Needs your Mac: ${title}`
            : `Run failed: ${title}`;
  const summary =
    ((await taskRef.get()).get('statusLine') as { text?: string } | undefined)?.text ?? '';
  const kind: NotificationKind =
    req.reason === 'finished'
      ? req.outcome === 'done'
        ? 'done'
        : req.outcome === 'blocked'
          ? 'blocked'
          : 'review'
      : req.reason === 'budget_exhausted'
        ? 'budget'
        : req.reason === 'interrupted' || req.reason === 'halted'
          ? 'stopped'
          : req.reason === 'needs_device'
            ? 'blocked'
            : 'failed';
  await deps.notify?.({ kind, title: headline, body: req.error ?? summary, taskId: run.taskId });
}

/**
 * What the gateway said when it refused: `budget_exhausted(<kind>): <why>` (see gateway.ts).
 * A worker from before that message, or a heartbeat refusal, gives no error: the task's budget.
 */
export function exhaustedCap(error: string | undefined): {
  kind: 'total' | 'monthly' | 'project' | 'job' | 'task';
  why?: string;
  needed?: number;
} {
  const m = /^budget_exhausted\((total|monthly|project|job|task)\):\s*(.*)$/s.exec(error ?? '');
  if (!m) return { kind: 'task' };
  const needs = /needs €(\d+(?:\.\d+)?)/.exec(m[2] ?? '');
  return {
    kind: m[1] as 'total' | 'monthly' | 'project' | 'job' | 'task',
    why: m[2],
    needed: needs ? Math.round(Number(needs[1]) * 1_000_000) : undefined,
  };
}

/** Shared tail: settle the infra slice and make the run identity worthless. */
async function endRun(deps: RunControlDeps, run: Run) {
  const prev = (await deps.db.doc(paths.run(run.id)).get()).get('infraReservation') as
    | string
    | undefined;
  if (prev) {
    const shape = workerShape(run);
    await deps.costGate.settle(prev, computeCost(HEARTBEAT_MS / 1000, shape.vcpu, shape.gib));
  }
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
