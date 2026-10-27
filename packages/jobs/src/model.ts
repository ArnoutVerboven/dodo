import { eur, MicroEur, Timestamp } from '@dodo/core';
import { z } from 'zod';

/**
 * Jobs data model, shared by the functions and the Jobs tab. Kept free of Node APIs so the web
 * app can import it (`@dodo/jobs/model`).
 *
 *   jobs/{jobId}                     config (owner edits) + state (server only)
 *   jobs/{jobId}/items/{messageId}   once-per-message ledger
 *   jobs/{jobId}/threads/{threadId}  thread → task link, open replies
 *   jobRuns/{runId}                  what each run did
 *   connectors/{id}                  connection status (no secrets)
 */

export const JobKind = z.enum(['gmail-followup', 'whatsapp-followup']);
export type JobKind = z.infer<typeof JobKind>;

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const WorkingHours = z.object({
  start: HHMM.default('09:00'),
  end: HHMM.default('18:00'),
  /** ISO weekdays, 1 = Monday. */
  days: z.array(z.number().int().min(1).max(7)).default([1, 2, 3, 4, 5]),
});
export type WorkingHours = z.infer<typeof WorkingHours>;

/** Hard upper bounds, whatever the config says. */
export const LIMITS = {
  maxItemsPerRun: 25,
  maxTasksPerDay: 50,
  maxModelCallsPerItem: 5,
  maxRevisions: 5,
  maxAttempts: 3,
  runTimeBudgetMs: 240_000,
  lookbackDays: 14,
  minIntervalMinutes: 15,
  maxMonthlyBudget: eur(10),
} as const;

export const GmailFollowupConfig = z.object({
  /** A thread counts once its last message (not from you) is this old. */
  unansweredMinutes: z.number().int().min(15).max(10_080).default(60),
  /** Messages older than this are never looked at. */
  lookbackDays: z.number().int().min(1).max(LIMITS.lookbackDays).default(3),
  /** Only the Primary inbox tab (skips Promotions, Social, Updates, Forums). */
  primaryOnly: z.boolean().default(true),
  /** Skip mailing lists and automated mail without a model call. */
  skipBulk: z.boolean().default(true),
  intervalMinutes: z.number().int().min(LIMITS.minIntervalMinutes).max(1440).default(30),
  maxItemsPerRun: z.number().int().min(1).max(LIMITS.maxItemsPerRun).default(10),
  maxTasksPerDay: z.number().int().min(1).max(LIMITS.maxTasksPerDay).default(20),
  monthlyBudget: MicroEur.max(LIMITS.maxMonthlyBudget).default(eur(1)),
  model: z.string().default('gemini-3.8-flash'),
  projectId: z.string().optional(),
  tags: z.array(z.string()).default(['email']),
  draftReplies: z.boolean().default(true),
  notify: z.boolean().default(true),
  /** Outer bounds for proposed times; the agent narrows them per activity (see `context`). */
  workingHours: WorkingHours.default({ start: '08:00', end: '21:00', days: [1, 2, 3, 4, 5, 6, 7] }),
  /** Free text the agent reads with every thread: your schedule, preferences, people. */
  context: z
    .string()
    .max(2000)
    .default(
      'I usually work Monday to Thursday until late, so on those days prefer evenings only for short calls. Friday and the weekend are best for visits and appointments in person.',
    ),
  /** IANA time zone for proposed slots; empty: the Google Calendar's own. */
  timezone: z.string().optional(),
});
export type GmailFollowupConfig = z.infer<typeof GmailFollowupConfig>;

export const JobState = z.object({
  lastRunAt: Timestamp.optional(),
  lastRunId: z.string().optional(),
  lastResult: z.string().optional(),
  consecutiveFailures: z.number().int().default(0),
  pausedReason: z.string().optional(),
  /** One run at a time: a lease that expires on its own if a run dies. */
  lock: z.object({ runId: z.string(), until: Timestamp }).optional(),
  /** Daily cap on new tasks. */
  day: z.object({ date: z.string(), tasksCreated: z.number().int() }).optional(),
});
export type JobState = z.infer<typeof JobState>;

export const Job = z.object({
  id: z.string(),
  kind: JobKind,
  enabled: z.boolean().default(false),
  config: z.record(z.string(), z.unknown()).default({}),
  state: JobState.default({ consecutiveFailures: 0 }),
  createdAt: Timestamp.optional(),
  updatedAt: Timestamp.optional(),
});
export type Job = z.infer<typeof Job>;

export const ItemState = z.enum(['processing', 'done', 'ignored', 'skipped', 'failed']);

export const JobItem = z.object({
  id: z.string(),
  threadId: z.string(),
  state: ItemState,
  attempts: z.number().int().default(1),
  claimedAt: Timestamp,
  reason: z.string().optional(),
  decision: z.string().optional(),
  taskId: z.string().optional(),
  draftId: z.string().optional(),
  approvalMessageId: z.string().optional(),
  error: z.string().optional(),
  updatedAt: Timestamp.optional(),
});
export type JobItem = z.infer<typeof JobItem>;

export const JobThread = z.object({
  id: z.string(),
  taskId: z.string(),
  /** Still watched: closes when you reply in Gmail or the task is done. */
  open: z.boolean().default(true),
  lastMessageId: z.string().optional(),
  subject: z.string().optional(),
  /** The reply approval card waiting for an answer, if any. */
  approval: z.object({ taskId: z.string(), messageId: z.string() }).optional(),
  /** The calendar event card waiting for an answer, if any. */
  event: z.object({ taskId: z.string(), messageId: z.string() }).optional(),
  updatedAt: Timestamp,
});
export type JobThread = z.infer<typeof JobThread>;

export const RunEntry = z.object({
  threadId: z.string(),
  subject: z.string(),
  from: z.string(),
  decision: z.enum(['ignore', 'create', 'update', 'skip', 'error']),
  reason: z.string().optional(),
  title: z.string().optional(),
  taskId: z.string().optional(),
  draft: z.string().optional(),
  /** The calendar event offered, e.g. "House visit, Tue 4 Nov 14:00". */
  event: z.string().optional(),
});
export type RunEntry = z.infer<typeof RunEntry>;

export const JobRunState = z.enum([
  'running',
  'succeeded',
  'failed',
  'budget_exhausted',
  'halted',
  'skipped',
]);

export const JobRun = z.object({
  id: z.string(),
  jobId: z.string(),
  trigger: z.enum(['schedule', 'manual']),
  dryRun: z.boolean().default(false),
  state: JobRunState,
  counts: z
    .object({
      scanned: z.number().int().default(0),
      skipped: z.number().int().default(0),
      ignored: z.number().int().default(0),
      created: z.number().int().default(0),
      updated: z.number().int().default(0),
      resolved: z.number().int().default(0),
      failed: z.number().int().default(0),
    })
    .default({
      scanned: 0,
      skipped: 0,
      ignored: 0,
      created: 0,
      updated: 0,
      resolved: 0,
      failed: 0,
    }),
  entries: z.array(RunEntry).default([]),
  spent: MicroEur.default(0),
  error: z.string().optional(),
  startedAt: Timestamp,
  endedAt: Timestamp.optional(),
});
export type JobRun = z.infer<typeof JobRun>;
export type RunCounts = JobRun['counts'];

export const ConnectorStatus = z.object({
  id: z.string(),
  status: z.enum(['connected', 'expired', 'missing_scopes', 'disconnected', 'error']),
  email: z.string().optional(),
  scopes: z.array(z.string()).default([]),
  missingScopes: z.array(z.string()).default([]),
  error: z.string().optional(),
  connectedAt: Timestamp.optional(),
  updatedAt: Timestamp,
});
export type ConnectorStatus = z.infer<typeof ConnectorStatus>;

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/calendar.readonly',
  // Create events, only after you approve them on the task.
  'https://www.googleapis.com/auth/calendar.events',
] as const;

/** Which connector each job needs. */
export const JOB_CONNECTOR: Record<JobKind, string> = {
  'gmail-followup': 'google',
  'whatsapp-followup': 'whatsapp',
};

export const jobPaths = {
  jobs: () => 'jobs',
  job: (id: string) => `jobs/${id}`,
  items: (jobId: string) => `jobs/${jobId}/items`,
  item: (jobId: string, id: string) => `jobs/${jobId}/items/${id}`,
  threads: (jobId: string) => `jobs/${jobId}/threads`,
  thread: (jobId: string, id: string) => `jobs/${jobId}/threads/${id}`,
  runs: () => 'jobRuns',
  run: (id: string) => `jobRuns/${id}`,
  connector: (id: string) => `connectors/${id}`,
  oauthState: (id: string) => `oauthStates/${id}`,
  /** Emulator only; production keeps tokens in Secret Manager. */
  connectorSecret: (id: string) => `connectorSecrets/${id}`,
} as const;

/** Parse a stored config with defaults; anything invalid falls back to the default value. */
export function gmailConfig(raw: unknown): GmailFollowupConfig {
  const parsed = GmailFollowupConfig.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  // Drop the offending keys one level deep and try again, so one bad field keeps the rest.
  const bad = new Set(parsed.error.issues.map((i) => String(i.path[0])));
  const kept = Object.fromEntries(
    Object.entries((raw ?? {}) as Record<string, unknown>).filter(([k]) => !bad.has(k)),
  );
  return GmailFollowupConfig.parse(kept);
}
