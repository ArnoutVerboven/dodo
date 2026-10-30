import {
  type AgentContext,
  AgentError,
  type Decision,
  decideThread,
  type Generate,
  recheckThread,
} from './agent.js';
import { type EventProposal, eventTimes, postEventCard } from './events.js';
import { type GmailThread, GoogleApiError, GoogleAuthError } from './google.js';
import {
  inboxQuery,
  type MailMessage,
  type MailThread,
  nameOf,
  replyMime,
  threadState,
  threadUrl,
  toThread,
  unanswered,
} from './mail.js';
import {
  type GmailFollowupConfig,
  gmailConfig,
  type JobRun,
  LIMITS,
  type RunEntry,
} from './model.js';
import type { JobStore, Notifier, TaskSink } from './ports.js';
import { formatLocal, localDay, type Slot, zonedTime } from './slots.js';
import {
  BudgetStop,
  OPEN_STATUSES as OPEN,
  pushEntry,
  type SourceSync,
  syncLinkedTasks,
} from './sync.js';

/** Gmail and Calendar as the job uses them (the REST clients, or fakes in tests). */
export interface GmailLike {
  profile(): Promise<{ emailAddress: string }>;
  listThreads(q: string, max: number): Promise<Array<{ id: string }>>;
  getThread(id: string, format: 'metadata' | 'full'): Promise<GmailThread>;
  createDraft(raw: string, threadId: string): Promise<{ id: string }>;
  updateDraft(id: string, raw: string, threadId: string): Promise<{ id: string }>;
}
export interface CalendarLike {
  timeZone(): Promise<string | undefined>;
  busy(from: Date, to: Date): Promise<Slot[]>;
}

export interface GmailJobDeps {
  store: JobStore;
  tasks: TaskSink;
  gmail: GmailLike;
  calendar: CalendarLike;
  /** Model calls, charged to the job's budget scope; throws BudgetStop when refused. */
  generate: Generate;
  notify?: Notifier;
  /** The shared personal profile (Settings › Personal info), if there is one. */
  profile?: () => Promise<UserProfile | undefined>;
  now?: () => number;
  ids?: () => string;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

/** What jobs read from the shared profile document (`settings/profile`). */
export interface UserProfile {
  schedulingNotes?: string;
  timeZone?: string;
}

/** Scheduling notes from the profile first, then the job's own "about you" text. */
export function userContext(profile: UserProfile | undefined, jobContext: string): string {
  return [profile?.schedulingNotes, jobContext]
    .map((s) => s?.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 4000);
}

export interface RunOptions {
  jobId: string;
  trigger: 'schedule' | 'manual';
  dryRun?: boolean;
}

const LOCK_TTL_MS = 9 * 60_000;
const MAX_LIST = 50;
const MAX_SYNC = 20;
const DEFAULT_TZ = 'Europe/Brussels';

/**
 * One run of the Gmail follow-up job. Returns the run record; scheduled runs that found
 * nothing to do are not stored, so the run list shows only runs that did something.
 */
export async function runGmailJob(deps: GmailJobDeps, opts: RunOptions): Promise<JobRun> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const started = now();
  const run: JobRun = {
    id: deps.ids?.() ?? `${opts.jobId}-${started}`,
    jobId: opts.jobId,
    trigger: opts.trigger,
    dryRun: !!opts.dryRun,
    state: 'running',
    counts: {
      scanned: 0,
      skipped: 0,
      ignored: 0,
      created: 0,
      updated: 0,
      resolved: 0,
      removed: 0,
      failed: 0,
    },
    entries: [],
    spent: 0,
    startedAt: started,
  };
  const skip = async (reason: string) => {
    run.state = 'skipped';
    run.error = reason;
    run.endedAt = now();
    if (opts.trigger === 'manual') await deps.store.saveRun(run);
    return run;
  };

  const job = await deps.store.getJob(opts.jobId);
  if (job?.kind !== 'gmail-followup') return skip('Unknown job');
  const config = gmailConfig(job.config);
  if (opts.trigger === 'schedule') {
    if (!job.enabled) return skip('Job is off');
    const due = (job.state.lastRunAt ?? 0) + config.intervalMinutes * 60_000;
    if (due > started + 60_000) return skip('Not due yet');
  }
  const connector = await deps.store.connector('google');
  if (connector?.status !== 'connected') {
    return skip('Google is not connected: connect it in the Jobs tab.');
  }
  if (!(await deps.store.lock(opts.jobId, run.id, started, LOCK_TTL_MS))) {
    return skip('Another run of this job is still going.');
  }
  if (opts.trigger === 'manual') await deps.store.saveRun(run);

  let failed = false;
  let reconnect = false;
  try {
    const me = (await deps.gmail.profile()).emailAddress.toLowerCase();
    const profile = await deps.profile?.().catch(() => undefined);
    const timeZone =
      config.timezone ||
      profile?.timeZone ||
      (await deps.calendar.timeZone().catch(() => undefined)) ||
      DEFAULT_TZ;
    const ctx: RunContext = {
      deps,
      opts,
      config,
      run,
      me,
      timeZone,
      now,
      log,
      account: connector.email ?? me,
      about: userContext(profile, config.context),
    };
    const stopped = await syncLinkedTasks(
      {
        jobId: opts.jobId,
        dryRun: !!opts.dryRun,
        store: deps.store,
        tasks: deps.tasks,
        run,
        now,
        max: MAX_SYNC,
        fatal: (err) => err instanceof GoogleAuthError,
        log,
      },
      gmailSync(ctx),
    );
    if (!stopped) await scanInbox(ctx);
    if (run.state === 'running') run.state = 'succeeded';
  } catch (err) {
    failed = true;
    run.state = 'failed';
    run.error = (err as Error).message.slice(0, 500);
    reconnect = err instanceof GoogleAuthError && err.reconnect;
    log('gmail job failed', { jobId: opts.jobId, err: String(err) });
  } finally {
    run.endedAt = now();
    const interesting =
      opts.trigger === 'manual' ||
      failed ||
      run.state !== 'succeeded' ||
      Object.values(run.counts).some((n) => n > 0);
    if (interesting)
      await deps.store.saveRun(run).catch((e) => log('saveRun failed', { e: String(e) }));
    const failures = failed ? job.state.consecutiveFailures + 1 : 0;
    const pause = failed && failures >= 3 && opts.trigger === 'schedule';
    await deps.store.unlock(
      opts.jobId,
      run.id,
      {
        lastRunAt: opts.dryRun ? job.state.lastRunAt : started,
        lastRunId: interesting ? run.id : job.state.lastRunId,
        lastResult: summarise(run),
        consecutiveFailures: failures,
        pausedReason: pause ? `Paused after 3 failed runs: ${run.error}` : '',
      },
      pause ? { enabled: false } : {},
    );
    if (reconnect) {
      await deps.store.setConnector('google', {
        ...connector,
        status: 'expired',
        error: 'Google sign-in expired or was revoked. Connect again.',
        updatedAt: now(),
      });
    }
  }
  return run;
}

interface RunContext {
  deps: GmailJobDeps;
  opts: RunOptions;
  config: GmailFollowupConfig;
  run: JobRun;
  me: string;
  account: string;
  timeZone: string;
  /** Profile scheduling notes + the job's own context, for the agent. */
  about: string;
  now: () => number;
  log: (message: string, data?: Record<string, unknown>) => void;
}

function summarise(run: JobRun): string {
  if (run.state === 'failed') return `Failed: ${run.error ?? 'unknown error'}`;
  const c = run.counts;
  const parts = [
    c.created && `${c.created} new`,
    c.updated && `${c.updated} updated`,
    c.resolved && `${c.resolved} closed`,
    c.removed && `${c.removed} removed`,
    c.ignored && `${c.ignored} ignored`,
    c.failed && `${c.failed} failed`,
  ].filter(Boolean);
  const label = run.state === 'succeeded' ? '' : `${run.state.replace('_', ' ')}: `;
  return `${run.dryRun ? 'Dry run: ' : ''}${label}${parts.length ? parts.join(', ') : 'nothing new'}`;
}

/** Gmail as a source for syncLinkedTasks: deleted threads, and threads you answered. */
function gmailSync(ctx: RunContext): SourceSync {
  const { deps, config } = ctx;
  return {
    label: 'Gmail',
    async inspect(link) {
      let thread: MailThread;
      try {
        thread = toThread(await deps.gmail.getThread(link.id, 'metadata'));
      } catch (err) {
        if (err instanceof GoogleAuthError) throw err;
        if (err instanceof GoogleApiError && err.status === 404) {
          return { kind: 'gone', reason: 'The email was deleted in Gmail' };
        }
        return { kind: 'unknown' }; // a passing error: try again next run
      }
      return { ...threadState(thread, ctx.me), subject: thread.subject };
    },
    async recheck(_link, task) {
      const thread = toThread(await deps.gmail.getThread(_link.id, 'full'));
      return recheckThread({
        model: config.model,
        me: ctx.me,
        now: ctx.now(),
        timeZone: ctx.timeZone,
        hours: config.workingHours,
        thread,
        task,
        userContext: ctx.about,
        generate: deps.generate,
      });
    },
  };
}

async function scanInbox(ctx: RunContext) {
  const { deps, opts, config, run } = ctx;
  const started = ctx.now();
  const window = {
    now: started,
    unansweredMs: config.unansweredMinutes * 60_000,
    lookbackMs: config.lookbackDays * 86_400_000,
  };
  const candidates = await deps.gmail.listThreads(
    inboxQuery({ ...window, primaryOnly: config.primaryOnly }),
    MAX_LIST,
  );
  let handled = 0;
  for (const c of candidates) {
    if (handled >= config.maxItemsPerRun) break;
    if (ctx.now() - started > LIMITS.runTimeBudgetMs) {
      ctx.log('run time budget reached', { jobId: opts.jobId });
      break;
    }
    const meta = toThread(await deps.gmail.getThread(c.id, 'metadata'));
    const verdict = unanswered(meta, ctx.me, {
      ...window,
      now: ctx.now(),
      skipBulk: config.skipBulk,
    });
    if (!verdict.ok) {
      if (verdict.reason === 'bulk') await skipBulk(ctx, meta);
      continue;
    }
    const last = verdict.last;
    const claimed = opts.dryRun
      ? (await deps.store.peekItem(opts.jobId, last.id))
        ? 'exists'
        : 'claimed'
      : await deps.store.claimItem(opts.jobId, { id: last.id, threadId: c.id }, ctx.now());
    if (claimed === 'exists') continue;
    handled++;
    run.counts.scanned++;
    const stop = await handleThread(ctx, c.id, last);
    if (stop) break;
  }
}

/** Mailing lists are recorded once so the next runs skip them without reading them again. */
async function skipBulk(ctx: RunContext, thread: MailThread) {
  const last = thread.messages.at(-1);
  if (!last || ctx.opts.dryRun) return;
  const claim = await ctx.deps.store.claimItem(
    ctx.opts.jobId,
    { id: last.id, threadId: thread.id },
    ctx.now(),
  );
  if (claim !== 'claimed') return;
  await ctx.deps.store.updateItem(ctx.opts.jobId, last.id, {
    state: 'skipped',
    reason: 'mailing list or automated mail',
    updatedAt: ctx.now(),
  });
  ctx.run.counts.skipped++;
}

/** Returns true when the run must stop (budget, halt, daily cap). */
async function handleThread(
  ctx: RunContext,
  threadId: string,
  last: MailMessage,
): Promise<boolean> {
  const { deps, opts, config, run } = ctx;
  const jobId = opts.jobId;
  const entry: RunEntry = {
    threadId,
    subject: last.subject.slice(0, 200),
    from: nameOf(last.from).slice(0, 100),
    decision: 'error',
  };
  try {
    const thread = toThread(await deps.gmail.getThread(threadId, 'full'));
    const known = await deps.store.getThread(jobId, threadId);
    const existingTask = known ? await deps.tasks.get(known.taskId) : undefined;
    const result = await decideThread({
      model: config.model,
      me: ctx.me,
      now: ctx.now(),
      timeZone: ctx.timeZone,
      hours: config.workingHours,
      thread,
      existing: existingTask,
      draftReplies: config.draftReplies,
      userContext: ctx.about,
      generate: deps.generate,
      busy: (from, to) => deps.calendar.busy(new Date(from), new Date(to)),
      searchTasks: (q) => deps.tasks.search(q),
    } satisfies AgentContext);
    run.spent += result.cost;
    const d = result.decision;
    entry.decision = d.action;
    entry.reason = d.reason;
    entry.title = d.title;
    entry.draft = d.reply?.slice(0, 2000);
    if (d.event) {
      const [date, time] = d.event.start.split('T') as [string, string];
      entry.event = `${d.event.title}, ${formatLocal(zonedTime(date, time, ctx.timeZone), ctx.timeZone)}`;
    }

    if (d.action === 'ignore') {
      run.counts.ignored++;
      if (!opts.dryRun) {
        await deps.store.updateItem(jobId, last.id, {
          state: 'ignored',
          decision: 'ignore',
          reason: d.reason,
          updatedAt: ctx.now(),
        });
      }
      pushEntry(run, entry);
      return false;
    }
    if (opts.dryRun) {
      run.counts[d.action === 'create' ? 'created' : 'updated']++;
      pushEntry(run, entry);
      return false;
    }

    // Follow-ups go to a task a source created; anything else becomes a new task.
    let taskId: string | undefined;
    let created = false;
    const target = d.action === 'update' && d.taskId ? await deps.tasks.get(d.taskId) : undefined;
    if (target) {
      taskId = target.id;
    } else {
      const day = localDay(ctx.now(), ctx.timeZone).date;
      if (!existingTask && !(await deps.store.countTask(jobId, day, config.maxTasksPerDay))) {
        await deps.store.releaseItem(jobId, last.id);
        run.counts.scanned--;
        run.error = `Daily cap of ${config.maxTasksPerDay} new tasks reached; the rest waits for tomorrow.`;
        return true;
      }
      const res = await deps.tasks.create({
        title: (d.title ?? thread.subject).slice(0, 200),
        description: describe(d, thread, last, ctx),
        priority: d.priority ?? 'none',
        dueDate: d.dueDate,
        tags: [...new Set([...config.tags, ...(d.tags ?? [])])].slice(0, 6),
        projectId: config.projectId,
        source: {
          kind: 'gmail',
          url: threadUrl(threadId, ctx.account),
          label: nameOf(last.from).slice(0, 200),
          ref: threadId,
          jobId,
        },
        idempotencyKey: threadId,
      });
      taskId = res.taskId;
      created = res.created;
    }
    if (!created) {
      const view = target ?? (await deps.tasks.get(taskId));
      await deps.tasks.update(taskId, {
        ...(view && !OPEN.includes(view.status) ? { status: 'todo' as const } : {}),
        ...(d.priority && d.priority !== 'none' ? { priority: d.priority } : {}),
        ...(d.dueDate ? { dueDate: d.dueDate } : {}),
        statusLine: { text: `New message from ${entry.from}`.slice(0, 200), needsYou: true },
      });
      await deps.tasks.post(
        taskId,
        `**New message from ${entry.from}** in "${thread.subject}"\n\n${d.summary ?? d.reason}`,
      );
    }
    entry.taskId = taskId;
    run.counts[created ? 'created' : 'updated']++;
    await deps.store.updateItem(jobId, last.id, {
      state: 'done',
      decision: d.action,
      reason: d.reason,
      taskId,
      updatedAt: ctx.now(),
    });

    const known2 = await deps.store.getThread(jobId, threadId);
    let approval: { taskId: string; messageId: string } | undefined;
    if (d.reply && config.draftReplies) {
      approval = await draftAndAsk(ctx, {
        taskId,
        threadId,
        last,
        reply: d.reply,
        title: d.title ?? thread.subject,
        previous: known2?.approval,
      });
    } else if (config.notify) {
      await deps.notify
        ?.notify({
          kind: 'job_task',
          title: created ? 'New task from email' : 'Email follow-up',
          body: d.title ?? thread.subject,
          taskId,
        })
        .catch(() => undefined);
    }
    const event = d.event
      ? await proposeEvent(ctx, {
          taskId,
          threadId,
          event: d.event,
          previous: known2?.event,
          notify: !approval,
        })
      : undefined;
    await deps.store.setThread(jobId, {
      id: threadId,
      taskId,
      open: true,
      lastMessageId: last.id,
      subject: thread.subject.slice(0, 200),
      updatedAt: ctx.now(),
      ...(approval ? { approval } : {}),
      ...(event ? { event } : {}),
    });
    pushEntry(run, entry);
    return false;
  } catch (err) {
    if (err instanceof BudgetStop) {
      if (!opts.dryRun) await deps.store.releaseItem(jobId, last.id);
      run.counts.scanned--;
      run.state = err.kind;
      run.error =
        err.kind === 'halted'
          ? 'Processing is halted (kill switch).'
          : 'The job budget for this month is used up.';
      return true;
    }
    if (err instanceof GoogleAuthError) throw err;
    run.counts.failed++;
    entry.reason = (err as Error).message.slice(0, 300);
    pushEntry(run, entry);
    if (!opts.dryRun) {
      await deps.store.updateItem(jobId, last.id, {
        state: 'failed',
        error: entry.reason,
        updatedAt: ctx.now(),
      });
    }
    if (!(err instanceof AgentError)) ctx.log('item failed', { threadId, err: String(err) });
    return false;
  }
}

/** Puts an "Add to calendar?" card on the task; the event is only created on approval. */
async function proposeEvent(
  ctx: RunContext,
  a: {
    taskId: string;
    threadId: string;
    event: EventProposal;
    previous?: { taskId: string; messageId: string };
    notify: boolean;
  },
): Promise<{ taskId: string; messageId: string }> {
  const { deps, opts } = ctx;
  if (a.previous) {
    await deps.tasks.transition(
      a.previous.taskId,
      a.previous.messageId,
      ['pending'],
      'superseded',
      {},
      'Replaced by a newer proposal',
    );
  }
  const proposal = {
    jobId: opts.jobId,
    threadId: a.threadId,
    title: a.event.title,
    start: a.event.start,
    durationMinutes: a.event.durationMinutes,
    timeZone: ctx.timeZone,
    location: a.event.location,
    account: ctx.account,
  };
  const { start, end } = eventTimes(proposal);
  const clash = await deps.calendar
    .busy(new Date(start), new Date(end))
    .then((b) => b.some((x) => x.start < end && x.end > start))
    .catch(() => false);
  const messageId = await postEventCard(deps.tasks, { ...proposal, taskId: a.taskId, clash });
  if (a.notify && ctx.config.notify) {
    await deps.notify
      ?.notify({
        kind: 'job_approval',
        title: 'Add to your calendar?',
        body: `${a.event.title}, ${formatLocal(start, ctx.timeZone)}`,
        taskId: a.taskId,
        input: { messageId, kind: 'approval' },
      })
      .catch(() => undefined);
  }
  return { taskId: a.taskId, messageId };
}

/** Creates (or updates) the Gmail draft and puts an approval card with it on the task. */
async function draftAndAsk(
  ctx: RunContext,
  a: {
    taskId: string;
    threadId: string;
    last: MailMessage;
    reply: string;
    title: string;
    previous?: { taskId: string; messageId: string };
  },
): Promise<{ taskId: string; messageId: string }> {
  const { deps, opts } = ctx;
  const item = await deps.store.peekItem(opts.jobId, a.last.id);
  const raw = replyMime({ from: ctx.me, inReplyTo: a.last, body: a.reply });
  // A retried item already made its draft: update it instead of making a second one.
  const draft = item?.draftId
    ? await deps.gmail.updateDraft(item.draftId, raw, a.threadId)
    : await deps.gmail.createDraft(raw, a.threadId);
  await deps.store.updateItem(opts.jobId, a.last.id, { draftId: draft.id });
  if (a.previous) {
    await deps.tasks.transition(
      a.previous.taskId,
      a.previous.messageId,
      ['pending'],
      'superseded',
      {},
      'Replaced by a newer draft',
    );
  }
  const to = a.last.replyTo ?? a.last.from;
  const messageId = await postApproval(deps.tasks, {
    taskId: a.taskId,
    jobId: opts.jobId,
    threadId: a.threadId,
    draftId: draft.id,
    to,
    text: a.reply,
    revision: 0,
    replyToMessageId: a.last.id,
    account: ctx.account,
  });
  await deps.store.updateItem(opts.jobId, a.last.id, { approvalMessageId: messageId });
  if (ctx.config.notify) {
    await deps.notify
      ?.notify({
        kind: 'job_approval',
        title: `Reply to ${nameOf(to)}?`,
        body: `${a.title}\n\n${a.reply.slice(0, 1500)}`,
        taskId: a.taskId,
        input: { messageId, kind: 'approval' },
      })
      .catch(() => undefined);
  }
  return { taskId: a.taskId, messageId };
}

export interface ReplyAction {
  type: 'jobs.reply';
  state: 'pending' | 'sending' | 'sent' | 'declined' | 'revising' | 'superseded' | 'failed';
  jobId: string;
  threadId: string;
  draftId: string;
  to: string;
  revision: number;
  /** The message being answered: the reply threads under it. */
  replyToMessageId: string;
  account?: string;
}

export async function postApproval(
  tasks: TaskSink,
  a: Omit<ReplyAction, 'type' | 'state'> & { taskId: string; text: string },
): Promise<string> {
  const name = nameOf(a.to);
  const quoted = a.text
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join('\n');
  const body = `**Draft reply to ${name}**${a.revision ? ` (rewrite ${a.revision})` : ''}, saved as a draft in [Gmail](${threadUrl(a.threadId, a.account)}):\n\n${quoted}\n\nApprove to send it as it is in Gmail at that moment (you can edit it there first). Deny with a reason to have it rewritten.`;
  const action: ReplyAction = {
    type: 'jobs.reply',
    state: 'pending',
    jobId: a.jobId,
    threadId: a.threadId,
    draftId: a.draftId,
    to: a.to,
    revision: a.revision,
    replyToMessageId: a.replyToMessageId,
    account: a.account,
  };
  return tasks.post(a.taskId, body, {
    input: { kind: 'approval', prompt: `Send this reply to ${name}?` },
    action: action as unknown as Record<string, unknown>,
  });
}

/** The task description: the summary, then the latest message quoted as untrusted source text. */
function describe(d: Decision, thread: MailThread, last: MailMessage, ctx: RunContext): string {
  const quoted = last.text
    .slice(0, 1500)
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join('\n');
  return [
    d.summary ?? d.reason,
    '',
    `**From** ${nameOf(last.from)} · **Subject** ${thread.subject} · [Open in Gmail](${threadUrl(thread.id, ctx.account)})`,
    '',
    quoted,
  ].join('\n');
}
