import {
  type Content,
  type FunctionDeclaration,
  type GenerateRequest,
  type GenerateResponse,
  type IngestTaskView,
  JOB_DECIDE_NUDGE,
  JOB_DRAFT_OFF,
  JOB_DRAFT_ON,
  JOB_RECHECK_SYSTEM,
  JOB_REVISE_SYSTEM,
  jobReviseTurn,
  jobTriageSystem,
  type Part,
} from '@dodo/core';
import { z } from 'zod';
import type { MailThread } from './mail.js';
import { LIMITS, type WorkingHours } from './model.js';
import { formatLocal, freeSlots, localDay, type Slot, zonedTime } from './slots.js';

/**
 * The agent step of a job: one short tool loop that reads one thread and decides what to do.
 * Read-only tools only (free slots, task search); the decision is data the job code acts on,
 * so a prompt injection in an email can at worst produce a wrong task or a draft you see first.
 */

export type Generate = (req: Omit<GenerateRequest, 'runId'>) => Promise<GenerateResponse>;

export const Decision = z.object({
  action: z.enum(['ignore', 'create', 'update']),
  reason: z.string().min(1).max(300),
  /** For update: the task to follow up on (from the thread's task or search_tasks). */
  taskId: z.string().optional(),
  title: z.string().max(120).optional(),
  summary: z.string().max(2000).optional(),
  priority: z.enum(['none', 'low', 'medium', 'high', 'urgent']).optional(),
  dueDate: z.iso.date().optional(),
  tags: z.array(z.string().max(30)).max(3).optional(),
  reply: z.string().max(5000).optional(),
  /** An appointment the thread settles, to offer for the user's calendar. */
  event: z
    .object({
      title: z.string().min(1).max(120),
      /** Local wall-clock time in the user's time zone. */
      start: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'start must be YYYY-MM-DDTHH:MM'),
      durationMinutes: z.number().int().min(5).max(720).default(60),
      location: z.string().max(300).optional(),
    })
    .optional(),
});
export type Decision = z.infer<typeof Decision>;

export interface AgentContext {
  model: string;
  me: string;
  now: number;
  timeZone: string;
  hours: WorkingHours;
  thread: MailThread;
  /** The task this thread already has, if any. */
  existing?: IngestTaskView & { summary?: string };
  draftReplies: boolean;
  /** What the user wrote about themselves in the job settings. */
  userContext?: string;
  generate: Generate;
  busy: (from: number, to: number) => Promise<Slot[]>;
  searchTasks: (query: string) => Promise<IngestTaskView[]>;
}

export interface AgentResult {
  decision: Decision;
  calls: number;
  cost: number;
}

export class AgentError extends Error {}

const declarations: FunctionDeclaration[] = [
  {
    name: 'find_free_slots',
    description:
      "Free slots in the user's Google Calendar within working hours. Use before proposing times.",
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'First day to consider, YYYY-MM-DD.' },
        to: { type: 'string', description: 'Last day to consider, YYYY-MM-DD (at most 21 days).' },
        durationMinutes: { type: 'integer', description: 'Length of the meeting, default 60.' },
        earliest: { type: 'string', description: 'Earliest start time of day, HH:MM (optional).' },
        latest: { type: 'string', description: 'Latest end time of day, HH:MM (optional).' },
        weekdays: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Allowed ISO weekdays, 1 = Monday (optional).',
        },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'search_tasks',
    description:
      "Search the user's open tasks by words in the title, to find a task this thread is about.",
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'decide',
    description: 'Record the decision. Always the last call.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['ignore', 'create', 'update'] },
        reason: { type: 'string', description: 'One sentence: why.' },
        taskId: { type: 'string' },
        title: { type: 'string' },
        summary: { type: 'string', description: 'Markdown, a few short lines.' },
        priority: { type: 'string', enum: ['none', 'low', 'medium', 'high', 'urgent'] },
        dueDate: { type: 'string', description: 'YYYY-MM-DD' },
        tags: { type: 'array', items: { type: 'string' } },
        reply: { type: 'string', description: 'The reply draft, plain text, no subject line.' },
        event: {
          type: 'object',
          description: 'Only when the thread settles one concrete appointment.',
          properties: {
            title: { type: 'string' },
            start: { type: 'string', description: 'Local start, YYYY-MM-DDTHH:MM' },
            durationMinutes: { type: 'integer' },
            location: { type: 'string' },
          },
          required: ['title', 'start'],
        },
      },
      required: ['action', 'reason'],
    },
  },
];

const MAX_MESSAGE_CHARS = 3000;
const MAX_THREAD_CHARS = 12_000;

export function threadPrompt(
  ctx: Pick<
    AgentContext,
    'thread' | 'me' | 'now' | 'timeZone' | 'hours' | 'existing' | 'userContext'
  >,
): string {
  const msgs = ctx.thread.messages.slice(-6);
  let budget = MAX_THREAD_CHARS;
  const rendered = msgs
    .slice()
    .reverse()
    .map((m) => {
      const text = m.text.slice(0, Math.min(MAX_MESSAGE_CHARS, Math.max(0, budget)));
      budget -= text.length;
      const who = m.labels.includes('SENT') || m.fromEmail === ctx.me ? 'the user' : m.from;
      return `<message from="${escapeAttr(who)}" date="${formatLocal(m.date, ctx.timeZone)}">\n${text}\n</message>`;
    })
    .reverse()
    .join('\n');
  const existing = ctx.existing
    ? `\nThis thread already has a task: id ${ctx.existing.id}, "${ctx.existing.title}" (${ctx.existing.status}).\n`
    : '';
  const about = ctx.userContext?.trim()
    ? `\nThe user's notes about themselves: ${ctx.userContext.trim()}\n`
    : '';
  return `The user is ${ctx.me}. Now: ${formatLocal(ctx.now, ctx.timeZone)} (${ctx.timeZone}). Times can be proposed between ${ctx.hours.start} and ${ctx.hours.end}.
${about}${existing}
<thread subject="${escapeAttr(ctx.thread.subject)}">
${rendered}
</thread>`;
}

const escapeAttr = (s: string) => s.replace(/["<>]/g, '');

export async function decideThread(ctx: AgentContext): Promise<AgentResult> {
  const { value, calls, cost } = await decisionLoop({
    model: ctx.model,
    generate: ctx.generate,
    systemInstruction: jobTriageSystem(ctx.draftReplies ? JOB_DRAFT_ON : JOB_DRAFT_OFF),
    prompt: threadPrompt(ctx),
    declarations,
    schema: Decision,
    runTool: (name, args) => runTool(name, args, ctx),
  });
  return { decision: normalise(value, ctx), calls, cost };
}

/**
 * The shared tool loop: the model may call read-only tools, and must end with `decide`,
 * whose arguments are checked against `schema` (a bad call gets the errors back once more).
 */
async function decisionLoop<T>(opts: {
  model: string;
  generate: Generate;
  systemInstruction: string;
  prompt: string;
  declarations: FunctionDeclaration[];
  schema: z.ZodType<T>;
  runTool: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}): Promise<{ value: T; calls: number; cost: number }> {
  const session: Content[] = [{ role: 'user', parts: [{ text: opts.prompt }] }];
  let calls = 0;
  let cost = 0;
  let nudged = false;
  while (calls < LIMITS.maxModelCallsPerItem) {
    calls++;
    const res = await opts.generate({
      model: opts.model,
      systemInstruction: opts.systemInstruction,
      contents: session,
      tools: opts.declarations,
      maxOutputTokens: 4096,
      thinkingBudget: 512,
      temperature: 0.2,
    });
    cost += res.cost;
    session.push(res.content);
    const fcs = res.content.parts.filter((p) => p.functionCall);
    if (fcs.length === 0) {
      if (nudged) throw new AgentError('The model did not call decide');
      nudged = true;
      session.push({ role: 'user', parts: [{ text: JOB_DECIDE_NUDGE }] });
      continue;
    }
    const responses: Part[] = [];
    for (const p of fcs) {
      const fc = p.functionCall as NonNullable<Part['functionCall']>;
      if (fc.name === 'decide') {
        const parsed = opts.schema.safeParse(cleanArgs(fc.args ?? {}));
        if (!parsed.success) {
          responses.push(
            respond(fc, { error: parsed.error.issues.map((i) => i.message).join('; ') }),
          );
          continue;
        }
        return { value: parsed.data, calls, cost };
      }
      responses.push(respond(fc, await opts.runTool(fc.name, fc.args ?? {})));
    }
    session.push({ role: 'user', parts: responses });
  }
  throw new AgentError(`No decision after ${calls} model calls`);
}

/* ------------------------------ recheck ------------------------------ */

/** After the user answered a thread: is anything still left for them to do? */
export const Recheck = z.object({
  action: z.enum(['done', 'open']),
  reason: z.string().min(1).max(300),
  /** For open: the next step, shown as the task's status line. */
  nextStep: z.string().max(200).optional(),
  dueDate: z.iso.date().optional(),
});
export type Recheck = z.infer<typeof Recheck>;

const recheckDeclarations: FunctionDeclaration[] = [
  {
    name: 'decide',
    description: 'Record the decision. Always call it.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['done', 'open'] },
        reason: { type: 'string', description: 'One sentence: why.' },
        nextStep: { type: 'string', description: 'For open: what the user still has to do.' },
        dueDate: { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: ['action', 'reason'],
    },
  },
];

export interface RecheckContext
  extends Pick<
    AgentContext,
    'model' | 'me' | 'now' | 'timeZone' | 'hours' | 'thread' | 'userContext' | 'generate'
  > {
  task: IngestTaskView;
}

export async function recheckThread(
  ctx: RecheckContext,
): Promise<{ recheck: Recheck; calls: number; cost: number }> {
  const { value, calls, cost } = await decisionLoop({
    model: ctx.model,
    generate: ctx.generate,
    systemInstruction: JOB_RECHECK_SYSTEM,
    prompt: threadPrompt({ ...ctx, existing: ctx.task }),
    declarations: recheckDeclarations,
    schema: Recheck,
    runTool: async (name) => ({ error: `Unknown tool ${name}` }),
  });
  if (value.action === 'done') {
    value.nextStep = undefined;
    value.dueDate = undefined;
  }
  return { recheck: value, calls, cost };
}

/** Models sometimes send "" for optional fields; treat that as absent. */
function cleanArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== '' && v !== null));
}

function normalise(d: Decision, ctx: AgentContext): Decision {
  // A follow-up can only target the thread's own task or one search_tasks could return;
  // anything else becomes a new task.
  if (d.action === 'update' && !d.taskId && ctx.existing) d.taskId = ctx.existing.id;
  if (d.action === 'update' && !d.taskId) d.action = 'create';
  if (d.action === 'create' && !d.title) d.title = ctx.thread.subject.slice(0, 120);
  if (!ctx.draftReplies) d.reply = undefined;
  if (d.event && (d.action === 'ignore' || !eventInFuture(d.event.start, ctx))) d.event = undefined;
  return d;
}

/** Only appointments from now up to a year ahead; anything else is a misread date. */
function eventInFuture(start: string, ctx: Pick<AgentContext, 'now' | 'timeZone'>): boolean {
  const [date, time] = start.split('T') as [string, string];
  const at = zonedTime(date, time, ctx.timeZone);
  if (!Number.isFinite(at) || localDay(at, ctx.timeZone).date !== date) return false;
  return at > ctx.now && at < ctx.now + 366 * 86_400_000;
}

const respond = (
  fc: NonNullable<Part['functionCall']>,
  response: Record<string, unknown>,
): Part => ({
  functionResponse: { ...(fc.id ? { id: fc.id } : {}), name: fc.name, response },
});

async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: AgentContext,
): Promise<Record<string, unknown>> {
  try {
    if (name === 'find_free_slots') {
      const day = /^\d{4}-\d{2}-\d{2}$/;
      const fromDay = typeof args.from === 'string' && day.test(args.from) ? args.from : undefined;
      const toDay = typeof args.to === 'string' && day.test(args.to) ? args.to : undefined;
      const from = Math.max(
        ctx.now + 3_600_000,
        fromDay ? Date.parse(`${fromDay}T00:00:00Z`) - 86_400_000 : ctx.now,
      );
      const to = Math.min(
        from + 21 * 86_400_000,
        toDay ? Date.parse(`${toDay}T23:59:59Z`) + 86_400_000 : from + 7 * 86_400_000,
      );
      const duration = Math.min(Math.max(Number(args.durationMinutes) || 60, 15), 480);
      const slots = freeSlots({
        from,
        to,
        durationMinutes: duration,
        busy: await ctx.busy(from, to),
        hours: narrowHours(ctx.hours, args),
        timeZone: ctx.timeZone,
        max: 8,
      });
      return {
        timeZone: ctx.timeZone,
        slots: slots.map(
          (s) =>
            `${formatLocal(s.start, ctx.timeZone)} – ${formatLocal(s.end, ctx.timeZone).split(', ').pop()}`,
        ),
      };
    }
    if (name === 'search_tasks') {
      const tasks = await ctx.searchTasks(String(args.query ?? ''));
      return {
        tasks: tasks.slice(0, 10).map((t) => ({ taskId: t.id, title: t.title, status: t.status })),
      };
    }
    return { error: `Unknown tool ${name}` };
  } catch (err) {
    return { error: (err as Error).message.slice(0, 300) };
  }
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The agent may narrow the configured bounds for one search, never widen them. */
export function narrowHours(hours: WorkingHours, args: Record<string, unknown>): WorkingHours {
  const earliest =
    typeof args.earliest === 'string' && HHMM.test(args.earliest) ? args.earliest : undefined;
  const latest =
    typeof args.latest === 'string' && HHMM.test(args.latest) ? args.latest : undefined;
  const days = Array.isArray(args.weekdays)
    ? hours.days.filter((d) => (args.weekdays as unknown[]).includes(d))
    : hours.days;
  return {
    start: earliest && earliest > hours.start ? earliest : hours.start,
    end: latest && latest < hours.end ? latest : hours.end,
    days: days.length ? days : hours.days,
  };
}

/** Rewrites a draft with the user's instruction ("propose Thursday instead"). One model call. */
export async function reviseDraft(opts: {
  model: string;
  generate: Generate;
  thread: string;
  draft: string;
  instruction: string;
}): Promise<{ text: string; cost: number }> {
  const res = await opts.generate({
    model: opts.model,
    systemInstruction: JOB_REVISE_SYSTEM,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: jobReviseTurn(opts.thread, opts.draft, opts.instruction),
          },
        ],
      },
    ],
    maxOutputTokens: 2048,
    thinkingBudget: 256,
    temperature: 0.3,
  });
  const text = res.content.parts
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join('')
    .trim();
  if (!text) throw new AgentError('The model returned an empty draft');
  return { text: text.replace(/^<draft>\s*|\s*<\/draft>$/g, ''), cost: res.cost };
}
