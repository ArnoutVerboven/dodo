import {
  type GlobalSettings,
  type Project,
  paths,
  type Run,
  resolveAiConfig,
  type Task,
} from '@dodo/core';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { stripUndefined } from './runtime.js';

/**
 * Where runs come from. All three paths funnel into `enqueueRun`, which guarantees at most one
 * active run per task by writing `task.activeRunId` in the same transaction.
 */
export interface TriggerDeps {
  db: Firestore;
  now?: () => number;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

const DEFAULT_MODEL = 'gemini-2.5-flash';

function resolveModel(choice: string): string {
  return choice === 'auto' ? DEFAULT_MODEL : choice;
}
function resolveDevice(choice: string): string {
  return choice === 'auto' ? 'gcp' : choice;
}

export interface EnqueueOptions {
  trigger: Run['trigger'];
  /** Session to resume from (the previous run's), if any. */
  sessionPath?: string;
  /** For resumes after ask_user. */
  answer?: { prompt: string; value: string };
}

export async function enqueueRun(
  deps: TriggerDeps,
  taskId: string,
  opts: EnqueueOptions,
): Promise<string | undefined> {
  const now = (deps.now ?? Date.now)();
  const db = deps.db;
  return db.runTransaction(async (t) => {
    const taskSnap = await t.get(db.doc(paths.task(taskId)));
    const task = taskSnap.data() as Task | undefined;
    if (!task?.ai?.enabled) return undefined;
    if (task.activeRunId) return undefined;
    const settings = ((await t.get(db.doc(paths.settings()))).data() ??
      {}) as Partial<GlobalSettings>;
    const project = task.projectId
      ? ((await t.get(db.doc(paths.project(task.projectId)))).data() as Project | undefined)
      : undefined;
    const ai = resolveAiConfig({ ai: task.ai }, project, {
      defaults: settings.defaults ?? {},
      defaultTaskBudget: settings.defaultTaskBudget ?? 500_000,
    });
    const ref = db.collection(paths.runs()).doc();
    const run: Omit<Run, 'id'> = {
      taskId,
      projectId: task.projectId,
      device: resolveDevice(ai.device),
      model: resolveModel(ai.model),
      state: 'queued',
      trigger: opts.trigger,
      generation: 0,
      interrupt: false,
      attempts: 0,
      sessionPath: opts.sessionPath,
      spent: 0,
      steps: 0,
      createdAt: now,
      updatedAt: now,
    };
    t.create(ref, stripUndefined({ ...run, answer: opts.answer }));
    t.update(db.doc(paths.task(taskId)), {
      activeRunId: ref.id,
      status: 'in_progress',
      statusLine: { text: 'Queued', needsYou: false },
      updatedAt: now,
    });
    return ref.id;
  });
}

/** Latest session for a task, to continue a conversation on comment or resume. */
export async function latestSessionPath(
  db: Firestore,
  taskId: string,
): Promise<string | undefined> {
  const q = await db
    .collection(paths.runs())
    .where('taskId', '==', taskId)
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();
  return q.docs[0]?.get('sessionPath') as string | undefined;
}

const isReady = (t: Task | undefined) =>
  !!t &&
  t.ai?.enabled === true &&
  (t.status === 'todo' || t.status === 'in_progress') &&
  !t.activeRunId;

/** A task becomes AI-ready (enabled + todo/in progress + no active run): start a run. */
export async function onTaskChanged(
  deps: TriggerDeps,
  before: Task | undefined,
  after: Task | undefined,
) {
  if (!after || !isReady(after) || isReady(before)) return;
  // A task the agent already worked on continues its conversation instead of starting over.
  const sessionPath = await latestSessionPath(deps.db, after.id);
  const id = await enqueueRun(deps, after.id, {
    trigger: sessionPath ? 'comment' : 'new',
    sessionPath,
  });
  if (id) deps.log?.('run enqueued (task ready)', { taskId: after.id, runId: id });
}

/** A user comment on an idle AI task continues it; on a live run the heartbeat delivers it. */
export async function onUserMessage(
  deps: TriggerDeps,
  taskId: string,
  message: { author: string; input?: unknown },
) {
  if (message.author !== 'user' || message.input) return;
  const task = (await deps.db.doc(paths.task(taskId)).get()).data() as Task | undefined;
  if (!task?.ai?.enabled || task.activeRunId) return;
  if (task.status === 'done' || task.status === 'cancelled') return;
  const sessionPath = await latestSessionPath(deps.db, taskId);
  const id = await enqueueRun(deps, taskId, {
    trigger: sessionPath ? 'comment' : 'new',
    sessionPath,
  });
  if (id) deps.log?.('run enqueued (comment)', { taskId, runId: id });
}

/** An input request got its answer: apply side effects (always-allow, top-up) and resume. */
export async function onInputAnswered(
  deps: TriggerDeps,
  taskId: string,
  messageId: string,
  before: { input?: { answer?: unknown } } | undefined,
  after: {
    runId?: string;
    input?: {
      prompt: string;
      topUp?: number;
      answer?: { value: string; alwaysAllow?: { rule: string; scope: string } };
    };
  },
) {
  const answer = after.input?.answer;
  if (!answer || before?.input?.answer) return;
  const now = (deps.now ?? Date.now)();
  const db = deps.db;
  const task = (await db.doc(paths.task(taskId)).get()).data() as Task | undefined;
  if (!task) return;

  if (answer.alwaysAllow) {
    const { rule, scope } = answer.alwaysAllow;
    const ref =
      scope === 'global'
        ? db.doc(paths.settings())
        : scope === 'project' && task.projectId
          ? db.doc(paths.project(task.projectId))
          : db.doc(paths.task(taskId));
    await ref.set({ allowRules: FieldValue.arrayUnion(rule), updatedAt: now }, { merge: true });
  }

  if (after.input?.topUp) {
    if (!/^(y|yes|approve|ok)/i.test(answer.value)) {
      await db.doc(paths.task(taskId)).update({
        status: 'todo',
        statusLine: { text: 'Stopped: budget not topped up', needsYou: false },
        updatedAt: now,
      });
      return;
    }
    const current =
      task.ai.budget ?? (await db.doc(paths.settings()).get()).get('defaultTaskBudget') ?? 500_000;
    await db
      .doc(paths.task(taskId))
      .update({ 'ai.budget': current + after.input.topUp, updatedAt: now });
  }

  const sessionPath = await latestSessionPath(db, taskId);
  const id = await enqueueRun(deps, taskId, {
    trigger: 'resume',
    sessionPath,
    answer: { prompt: after.input?.prompt ?? '', value: answer.value },
  });
  if (id) deps.log?.('run enqueued (answer)', { taskId, messageId, runId: id });
}
