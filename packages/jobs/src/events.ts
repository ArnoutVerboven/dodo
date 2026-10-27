import { createHash } from 'node:crypto';
import type { Decision } from './agent.js';
import type { NewCalendarEvent } from './google.js';
import { threadUrl } from './mail.js';
import type { JobStore, TaskSink } from './ports.js';
import { formatLocal, zonedTime } from './slots.js';

/**
 * Calendar events, only with your approval. When a thread settles an appointment the job
 * puts an "Add to calendar?" card on the task; approving it creates the event once, on your
 * primary calendar, without inviting anyone. Denying it does nothing.
 */

export type EventProposal = NonNullable<Decision['event']>;

export interface EventAction {
  type: 'jobs.event';
  state: 'pending' | 'creating' | 'created' | 'declined' | 'superseded' | 'failed';
  jobId: string;
  threadId: string;
  title: string;
  /** Local wall-clock start, `YYYY-MM-DDTHH:MM`, in `timeZone`. */
  start: string;
  durationMinutes: number;
  timeZone: string;
  location?: string;
  account?: string;
}

export const isEventAction = (a: unknown): a is EventAction =>
  !!a && typeof a === 'object' && (a as { type?: unknown }).type === 'jobs.event';

/** Same thread, same start: same event id, so approving twice cannot double-book. */
export function eventId(jobId: string, threadId: string, start: string): string {
  return createHash('sha256').update(`${jobId}\n${threadId}\n${start}`).digest('hex').slice(0, 40);
}

/** `YYYY-MM-DDTHH:MM:SS` wall-clock time of an instant in a zone. */
export function localIso(at: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}

export function eventTimes(a: Pick<EventAction, 'start' | 'durationMinutes' | 'timeZone'>) {
  const [date, time] = a.start.split('T') as [string, string];
  const start = zonedTime(date, time, a.timeZone);
  return { start, end: start + a.durationMinutes * 60_000 };
}

export function calendarEvent(a: EventAction): NewCalendarEvent {
  const { start, end } = eventTimes(a);
  return {
    id: eventId(a.jobId, a.threadId, a.start),
    title: a.title,
    start: localIso(start, a.timeZone),
    end: localIso(end, a.timeZone),
    timeZone: a.timeZone,
    location: a.location,
    description: `From this email thread: ${threadUrl(a.threadId, a.account)}`,
  };
}

function when(a: EventAction): string {
  const { start, end } = eventTimes(a);
  const endTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: a.timeZone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(end));
  return `${formatLocal(start, a.timeZone)} to ${endTime}`;
}

export async function postEventCard(
  tasks: TaskSink,
  a: Omit<EventAction, 'type' | 'state'> & { taskId: string; clash?: boolean },
): Promise<string> {
  const { taskId, clash, ...rest } = a;
  const action: EventAction = { type: 'jobs.event', state: 'pending', ...rest };
  const lines = [
    `**Add to your calendar?** ${a.title}`,
    '',
    `${when(action)} (${a.timeZone})${a.location ? `, ${a.location}` : ''}`,
  ];
  if (clash) lines.push('', 'Note: your calendar already has something at that time.');
  lines.push('', 'Approve to add it to your Google Calendar. Nobody is invited or emailed.');
  return tasks.post(taskId, lines.join('\n'), {
    input: { kind: 'approval', prompt: `Add "${a.title}" to your calendar?` },
    action: action as unknown as Record<string, unknown>,
  });
}

export interface EventDeps {
  tasks: TaskSink;
  store: JobStore;
  calendar: { insertEvent(e: NewCalendarEvent): Promise<{ id: string; htmlLink?: string }> };
  now?: () => number;
}

const APPROVE = /^(y|yes|approve|approved|ok|add)\b/i;

export async function handleEventAnswer(
  deps: EventDeps,
  taskId: string,
  messageId: string,
  action: EventAction,
  answer: string,
): Promise<'created' | 'declined' | 'failed' | 'noop'> {
  const now = deps.now ?? Date.now;
  const clear = async () => {
    const t = await deps.store.getThread(action.jobId, action.threadId);
    if (t?.event?.messageId === messageId)
      await deps.store.setThread(action.jobId, { ...t, event: null, updatedAt: now() });
  };

  if (!APPROVE.test(answer.trim())) {
    if (!(await deps.tasks.transition(taskId, messageId, ['pending'], 'declined'))) return 'noop';
    await clear();
    return 'declined';
  }
  if (!(await deps.tasks.transition(taskId, messageId, ['pending'], 'creating'))) return 'noop';
  try {
    const created = await deps.calendar.insertEvent(calendarEvent(action));
    await deps.tasks.transition(
      taskId,
      messageId,
      ['creating'],
      'created',
      created.htmlLink ? { eventUrl: created.htmlLink } : {},
    );
    const label = created.htmlLink ? `[${action.title}](${created.htmlLink})` : action.title;
    await deps.tasks.post(taskId, `Added to your calendar: ${label}, ${when(action)}.`);
    await clear();
    return 'created';
  } catch (err) {
    const msg = `Could not add the event: ${(err as Error).message.slice(0, 300)}`;
    await deps.tasks.transition(taskId, messageId, ['creating'], 'failed', { error: msg });
    await deps.tasks.post(taskId, msg);
    return 'failed';
  }
}
