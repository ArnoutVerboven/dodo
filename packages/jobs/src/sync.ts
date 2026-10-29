import type { IngestTaskView } from '@dodo/core';
import { AgentError, type Recheck } from './agent.js';
import type { JobRun, JobThread, RunEntry } from './model.js';
import type { JobStore, TaskSink } from './ports.js';

/**
 * Keeping existing tasks in sync with the item they came from.
 *
 * Every job that makes tasks from a source (Gmail today; WhatsApp and others later) links each
 * task to its source item (`jobs/{jobId}/threads/{ref}`). The inbox scan only looks at new
 * messages, so on every run the job also walks its open links and asks the source what became
 * of them. The source answers with one of a few states, and this module acts on them the same
 * way for every integration:
 *
 *   gone       deleted (or trashed, or marked spam) at the source → the task is cancelled
 *   answered   you answered last → one short agent step: done, or still something for you
 *   waiting    the other side spoke last → nothing here; the scan of new messages handles it
 *   unknown    a passing error → try again next run
 *
 * A new integration implements `SourceSync` (two methods) and calls `syncLinkedTasks` at the
 * start of its run. Tasks a person closed or cancelled themselves just close the link.
 */

export type SourceState =
  | { kind: 'gone'; reason: string }
  /** `ref` names your latest answer (e.g. its message id), so it is rechecked only once. */
  | { kind: 'answered'; ref: string }
  | { kind: 'waiting' }
  | { kind: 'unknown' };

export interface SourceSync {
  /** The source's name in task notes, e.g. "Gmail". */
  label: string;
  /** What became of the linked item. Throw only for errors that must stop the run. */
  inspect(link: JobThread): Promise<SourceState & { subject?: string }>;
  /** One agent step after your answer: is anything left for you? Throws BudgetStop when refused. */
  recheck(link: JobThread, task: IngestTaskView): Promise<{ recheck: Recheck; cost: number }>;
}

/** The gateway refused for money reasons: stop the run, leave the rest for later. */
export class BudgetStop extends Error {
  constructor(readonly kind: 'budget_exhausted' | 'halted') {
    super(kind);
  }
}

export interface SyncContext {
  jobId: string;
  dryRun: boolean;
  store: JobStore;
  tasks: TaskSink;
  run: JobRun;
  now: () => number;
  /** Links looked at per run; the least recently checked go first. */
  max: number;
  /** Errors that must end the run (e.g. an expired sign-in) instead of skipping one link. */
  fatal?: (err: unknown) => boolean;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

export const OPEN_STATUSES = ['backlog', 'todo', 'in_progress', 'needs_input', 'review'];

/** Walks the job's open links. Returns true when the run must stop (budget or kill switch). */
export async function syncLinkedTasks(ctx: SyncContext, source: SourceSync): Promise<boolean> {
  const { store, tasks, run, jobId, dryRun } = ctx;
  const links = await store.openThreads(jobId, ctx.max);
  const save = (link: JobThread, patch: Partial<Parameters<JobStore['setThread']>[1]> = {}) =>
    dryRun
      ? Promise.resolve()
      : store.setThread(jobId, { ...link, ...patch, updatedAt: ctx.now() });

  for (const link of links) {
    const task = await tasks.get(link.taskId);
    if (!task || !OPEN_STATUSES.includes(task.status)) {
      // Closed or cancelled on the board (or gone): stop watching.
      await save(link, { open: false });
      continue;
    }
    let state: SourceState & { subject?: string };
    try {
      state = await source.inspect(link);
    } catch (err) {
      if (ctx.fatal?.(err)) throw err;
      ctx.log?.('sync inspect failed', { jobId, ref: link.id, err: String(err) });
      continue;
    }
    const entry: RunEntry = {
      threadId: link.id,
      subject: (state.subject ?? link.subject ?? task.title).slice(0, 200),
      from: 'you',
      decision: 'update',
      title: task.title,
      taskId: task.id,
    };

    if (state.kind === 'unknown' || state.kind === 'waiting') {
      await save(link); // moves it to the back of the queue
      continue;
    }

    if (state.kind === 'gone') {
      run.counts.removed++;
      pushEntry(run, { ...entry, decision: 'remove', reason: state.reason });
      if (dryRun) continue;
      await tasks.update(task.id, {
        status: 'cancelled',
        statusLine: { text: state.reason.slice(0, 200), needsYou: false },
      });
      await tasks.post(task.id, `${state.reason}, so this task was removed.`);
      await supersedeCards(tasks, link, `${source.label} item deleted`);
      await save(link, { open: false, approval: null, event: null });
      continue;
    }

    // Answered by you: recheck once per answer.
    if (link.checkedRef === state.ref) {
      await save(link);
      continue;
    }
    let result: Recheck;
    try {
      const r = await source.recheck(link, task);
      run.spent += r.cost;
      result = r.recheck;
    } catch (err) {
      if (err instanceof BudgetStop) {
        run.state = err.kind;
        run.error =
          err.kind === 'halted'
            ? 'Processing is halted (kill switch).'
            : 'The job budget for this month is used up.';
        return true;
      }
      if (ctx.fatal?.(err)) throw err;
      run.counts.failed++;
      pushEntry(run, { ...entry, decision: 'error', reason: (err as Error).message.slice(0, 300) });
      if (!(err instanceof AgentError)) ctx.log?.('recheck failed', { jobId, err: String(err) });
      continue;
    }

    if (result.action === 'done') {
      run.counts.resolved++;
      pushEntry(run, { ...entry, decision: 'done', reason: result.reason });
      if (dryRun) continue;
      await tasks.update(task.id, {
        status: 'done',
        statusLine: { text: `You replied in ${source.label}`, needsYou: false },
      });
      await tasks.post(
        task.id,
        `You replied in ${source.label}, so this task is done.\n\n${result.reason}`,
      );
      await supersedeCards(tasks, link, `You replied in ${source.label}`, { keepEvent: true });
      await save(link, { open: false, approval: null, checkedRef: state.ref });
      continue;
    }

    run.counts.updated++;
    pushEntry(run, { ...entry, reason: result.reason });
    if (dryRun) continue;
    const next = result.nextStep?.trim() || 'Follow up on your reply';
    await tasks.update(task.id, {
      statusLine: { text: next.slice(0, 200), needsYou: true },
      ...(result.dueDate ? { dueDate: result.dueDate } : {}),
    });
    await tasks.post(
      task.id,
      `You replied in ${source.label}, but something is still left: **${next}**\n\n${result.reason}`,
    );
    // Your reply makes a pending draft out of date; a pending calendar card still stands.
    await supersedeCards(tasks, link, `You replied in ${source.label}`, { keepEvent: true });
    await save(link, { approval: null, checkedRef: state.ref });
  }
  return false;
}

async function supersedeCards(
  tasks: TaskSink,
  link: JobThread,
  answer: string,
  opts: { keepEvent?: boolean } = {},
) {
  const cards = [link.approval, opts.keepEvent ? undefined : link.event].filter(
    (c): c is NonNullable<typeof c> => !!c,
  );
  for (const c of cards) {
    await tasks.transition(c.taskId, c.messageId, ['pending'], 'superseded', {}, answer);
  }
}

export function pushEntry(run: JobRun, e: RunEntry) {
  if (run.entries.length < 30) run.entries.push(e);
}
