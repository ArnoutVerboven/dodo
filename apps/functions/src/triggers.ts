import {
  type Device,
  type GlobalSettings,
  isLocalModel,
  type Project,
  paths,
  type Run,
  resolveAiConfig,
  type Task,
} from '@dodo/core';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { routeDevice, routeLocalModel, routeToMac } from './routing.js';
import { stripUndefined } from './runtime.js';

/**
 * Where runs come from. All three paths funnel into `enqueueRun`, which guarantees at most one
 * active run per task by writing `task.activeRunId` in the same transaction.
 */
export interface TriggerDeps {
  db: Firestore;
  /** Ends a run whose worker died, so the task can be picked up again. */
  reap?: (runId: string) => Promise<boolean>;
  /**
   * Browser `auto` on a new task: does it need one? A small model answers (routing.ts). Absent
   * (emulator, tests): no browser until the agent asks for one.
   */
  needsBrowser?: (task: Task) => Promise<boolean>;
  now?: () => number;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

const DEFAULT_MODEL = 'gemini-3.8-flash';

function resolveModel(choice: string): string {
  return choice === 'auto' ? DEFAULT_MODEL : choice;
}

export interface EnqueueOptions {
  trigger: Run['trigger'];
  /** Session to resume from (the previous run's), if any. */
  sessionPath?: string;
  /** For resumes after ask_user or an approval card. */
  answer?: { prompt: string; value: string; suggestedRule?: string; alwaysAllow?: boolean };
  /**
   * Browser for this run when already decided: the previous run's (a continued conversation
   * keeps its browser) or true for a step-up. Only `auto` looks at it; an explicit setting wins.
   */
  browser?: boolean;
  /** The run goes to the user's Mac whatever the device setting says (request_device). */
  device?: 'mac';
}

/** What the run's browser flag is, given the setting and what is already known. */
export async function decideBrowser(
  setting: Task['ai']['browser'],
  opts: Pick<EnqueueOptions, 'trigger' | 'browser'>,
  ask: (() => Promise<boolean>) | undefined,
  log?: TriggerDeps['log'],
): Promise<{ browser: boolean; reason?: string }> {
  if (setting === 'chrome') return { browser: true };
  if (setting === undefined || setting === 'none') return { browser: false };
  if (opts.browser !== undefined) return { browser: opts.browser };
  if (opts.trigger !== 'new' || !ask) return { browser: false };
  try {
    const browser = await ask();
    return { browser, reason: browser ? 'the task needs a browser' : undefined };
  } catch (err) {
    log?.('browser routing failed', { err: String(err) });
    return { browser: false };
  }
}

export async function enqueueRun(
  deps: TriggerDeps,
  taskId: string,
  opts: EnqueueOptions,
): Promise<string | undefined> {
  const now = (deps.now ?? Date.now)();
  const db = deps.db;
  const resolve = (task: Task, project: Project | undefined, settings: Partial<GlobalSettings>) =>
    resolveAiConfig({ ai: task.ai }, project, {
      defaults: settings.defaults ?? {},
      defaultTaskBudget: settings.defaultTaskBudget ?? 500_000,
    });

  // The browser question may cost a model call, so it is answered before the transaction.
  const first = (await db.doc(paths.task(taskId)).get()).data() as Task | undefined;
  if (!first?.ai?.enabled || first.activeRunId) return undefined;
  const firstProject = first.projectId
    ? ((await db.doc(paths.project(first.projectId)).get()).data() as Project | undefined)
    : undefined;
  const firstSettings = ((await db.doc(paths.settings()).get()).data() ??
    {}) as Partial<GlobalSettings>;
  const ask = deps.needsBrowser;
  const decided = await decideBrowser(
    resolve(first, firstProject, firstSettings).browser,
    opts,
    ask ? () => ask({ ...first, id: taskId }) : undefined,
    deps.log,
  );

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
    const devices = (await t.get(db.collection(paths.devices()))).docs.map(
      (d) => ({ id: d.id, ...d.data() }) as Device,
    );
    const ai = resolve(task, project, settings);
    const model = resolveModel(ai.model);
    const route =
      (opts.device === 'mac' ? routeToMac(devices) : undefined) ??
      (isLocalModel(model) ? routeLocalModel(ai.device, devices) : undefined) ??
      routeDevice(ai.device, ai.folder, devices, now);
    const routing = [route.reason, decided.browser ? 'with a browser' : undefined]
      .filter(Boolean)
      .join(', ');
    const ref = db.collection(paths.runs()).doc();
    const run: Omit<Run, 'id'> = {
      taskId,
      projectId: task.projectId,
      device: route.device,
      model,
      browser: decided.browser,
      routing,
      state: 'queued',
      trigger: opts.trigger,
      generation: 0,
      interrupt: false,
      compact: false,
      attempts: 0,
      sessionPath: opts.sessionPath,
      spent: 0,
      steps: 0,
      createdAt: now,
      updatedAt: now,
    };
    // Nested undefined (e.g. answer.suggestedRule) is not a Firestore value either.
    t.create(ref, JSON.parse(JSON.stringify(stripUndefined({ ...run, answer: opts.answer }))));
    t.update(db.doc(paths.task(taskId)), {
      activeRunId: ref.id,
      status: 'in_progress',
      statusLine: { text: `Queued: ${routing}`, needsYou: false },
      updatedAt: now,
    });
    return ref.id;
  });
}

/** The task's latest run: its session continues the conversation, its browser stays. */
export async function latestRun(
  db: Firestore,
  taskId: string,
): Promise<{ sessionPath?: string; browser?: boolean }> {
  const q = await db
    .collection(paths.runs())
    .where('taskId', '==', taskId)
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();
  const doc = q.docs[0];
  return {
    sessionPath: doc?.get('sessionPath') as string | undefined,
    browser: doc?.get('browser') as boolean | undefined,
  };
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
  if (!after) return;
  let current = after;
  // A task stuck behind a dead worker (stale activeRunId) is released first.
  if (after.activeRunId && deps.reap && (await deps.reap(after.activeRunId))) {
    current = { ...after, activeRunId: undefined };
  }
  if (!isReady(current) || isReady(before)) return;
  // A task the agent already worked on continues its conversation instead of starting over.
  const { sessionPath, browser } = await latestRun(deps.db, after.id);
  const id = await enqueueRun(deps, after.id, {
    trigger: sessionPath ? 'comment' : 'new',
    sessionPath,
    browser,
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
  if (!task?.ai?.enabled) return;
  if (task.status === 'done' || task.status === 'cancelled') return;
  // A live run picks the comment up through its heartbeat; a dead one is reaped and replaced.
  if (task.activeRunId && !(deps.reap && (await deps.reap(task.activeRunId)))) return;
  const { sessionPath, browser } = await latestRun(deps.db, taskId);
  const id = await enqueueRun(deps, taskId, {
    trigger: sessionPath ? 'comment' : 'new',
    sessionPath,
    browser,
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
      suggestedRule?: string;
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
      // Not `todo`: that starts a run, which would hit the same budget and ask again.
      await db.doc(paths.task(taskId)).update({
        status: 'needs_input',
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

  // A run holding its worker for this very answer gets it through its heartbeat instead.
  if (task.activeRunId && (await isHoldingFor(db, task.activeRunId, messageId))) {
    deps.log?.('answer delivered to the holding run', {
      taskId,
      messageId,
      runId: task.activeRunId,
    });
    return;
  }

  const { sessionPath, browser } = await latestRun(db, taskId);
  const id = await enqueueRun(deps, taskId, {
    trigger: 'resume',
    sessionPath,
    browser,
    answer: {
      prompt: after.input?.prompt ?? '',
      value: answer.value,
      suggestedRule: after.input?.suggestedRule,
      alwaysAllow: !!answer.alwaysAllow,
    },
  });
  if (id) deps.log?.('run enqueued (answer)', { taskId, messageId, runId: id });
}

/** Whether the run is live and waiting for this message's answer (see `requestInput`'s hold). */
async function isHoldingFor(db: Firestore, runId: string, messageId: string): Promise<boolean> {
  const run = (await db.doc(paths.run(runId)).get()).data() as Run | undefined;
  return (
    !!run &&
    (run.state === 'running' || run.state === 'claimed') &&
    run.awaiting?.messageId === messageId
  );
}
