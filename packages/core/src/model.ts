import { z } from 'zod';

/**
 * Money is stored as integer micro-euros (1 EUR = 1_000_000) so that budget
 * arithmetic never suffers from floating point drift.
 */
export const MicroEur = z.number().int().nonnegative();
export type MicroEur = z.infer<typeof MicroEur>;

export const MICRO_PER_EUR = 1_000_000;
export const eur = (amount: number): MicroEur => Math.round(amount * MICRO_PER_EUR);
export const toEur = (micro: MicroEur): number => micro / MICRO_PER_EUR;

export const Timestamp = z.number().int().nonnegative(); // epoch millis

export const TaskStatus = z.enum([
  'backlog',
  'todo',
  'in_progress',
  'needs_input',
  'review',
  'done',
  'cancelled',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskPriority = z.enum(['none', 'low', 'medium', 'high', 'urgent']);
export type TaskPriority = z.infer<typeof TaskPriority>;

/** Where a run executes. `auto` lets the routing step decide. */
export const DeviceChoice = z.union([
  z.literal('auto'),
  z.literal('gcp'),
  z.string().regex(/^mac:[\w-]+$/),
]);
export type DeviceChoice = z.infer<typeof DeviceChoice>;

export const ModelChoice = z.union([z.literal('auto'), z.string().min(1)]);
export type ModelChoice = z.infer<typeof ModelChoice>;

/** AI settings on a task or project. Unset fields fall back to project, then global defaults. */
export const AiConfig = z.object({
  enabled: z.boolean().default(false),
  model: ModelChoice.optional(),
  device: DeviceChoice.optional(),
  repo: z.string().optional(),
  folder: z.string().optional(),
  /** `chrome`: the run may use your own Chrome on the Mac it runs on (browser tools). */
  browser: z.enum(['none', 'chrome']).optional(),
  tools: z.array(z.string()).optional(),
  budget: MicroEur.optional(),
  /** `untrusted`: nothing beyond the task tools runs without approval (ingest tasks). */
  profile: z.enum(['agent-decides', 'untrusted']).optional(),
});
export type AiConfig = z.infer<typeof AiConfig>;

export const StatusLine = z.object({
  text: z.string(),
  nextAction: z.string().optional(),
  needsYou: z.boolean().default(false),
});
export type StatusLine = z.infer<typeof StatusLine>;

/**
 * Where a task came from when something other than you created it (the ingest API, a job).
 * Shown as a logo on the board and as a link back to the original on the task page.
 */
export const TaskSourceKind = z.enum(['gmail', 'whatsapp', 'calendar', 'api']);
export type TaskSourceKind = z.infer<typeof TaskSourceKind>;

export const TaskSource = z.object({
  kind: TaskSourceKind,
  /** Opens the original (the Gmail thread, the chat). */
  url: z.string().url().optional(),
  /** Short label for the link, e.g. the sender. */
  label: z.string().max(200).optional(),
  /** The original's id in its own system, e.g. the Gmail thread id. */
  ref: z.string().max(500).optional(),
  /** The job that created the task, if any. */
  jobId: z.string().optional(),
});
export type TaskSource = z.infer<typeof TaskSource>;

export const Task = z.object({
  id: z.string(),
  title: z.string(),
  titleSource: z.enum(['user', 'ai']).default('user'),
  description: z.string().default(''),
  status: TaskStatus.default('todo'),
  priority: TaskPriority.default('none'),
  dueDate: z.iso.date().optional(),
  tags: z.array(z.string()).default([]),
  projectId: z.string().optional(),
  ai: AiConfig.default({ enabled: false }),
  summary: z.string().default(''),
  statusLine: StatusLine.optional(),
  /** The run currently queued or working on this task; at most one. */
  activeRunId: z.string().optional(),
  externalRefs: z.record(z.string(), z.string()).default({}),
  source: TaskSource.optional(),
  /** Permission rules answered "Always allow" for this task, e.g. `Browser(navigate:x.com)`. */
  allowRules: z.array(z.string()).optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Task = z.infer<typeof Task>;

/** Fields the user provides when creating a task. */
export const NewTask = Task.pick({
  description: true,
  priority: true,
  dueDate: true,
  tags: true,
  projectId: true,
  ai: true,
}).extend({ title: z.string().optional() });
export type NewTask = z.input<typeof NewTask>;

export const Project = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().default(''),
  defaults: AiConfig.omit({ enabled: true }).default({}),
  /** Hard cap for all tasks in the project together, per calendar month. */
  monthlyBudget: MicroEur.optional(),
  instructions: z.string().default(''),
  /** Permission rules answered "Always allow" for this project, e.g. `Browser(navigate:x.com)`. */
  allowRules: z.array(z.string()).optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Project = z.infer<typeof Project>;

export const InputKind = z.enum(['text', 'choice', 'approval']);
export type InputKind = z.infer<typeof InputKind>;

/** A picture attached to a question, e.g. a screenshot of a QR code; stored in Storage. */
export const InputImage = z.object({
  storagePath: z.string(),
  mimeType: z.string(),
});
export type InputImage = z.infer<typeof InputImage>;

export const InputRequest = z.object({
  kind: InputKind,
  prompt: z.string(),
  image: InputImage.optional(),
  options: z.array(z.string()).optional(),
  /** For approvals: the rule that "Always allow" would add, e.g. `Bash(git push:*)`. */
  suggestedRule: z.string().optional(),
  costEstimate: MicroEur.optional(),
  /** For a budget ask: what approving adds to the task's budget. */
  topUp: MicroEur.optional(),
  answer: z
    .object({
      value: z.string(),
      alwaysAllow: z
        .object({ rule: z.string(), scope: z.enum(['task', 'project', 'global']) })
        .optional(),
      answeredAt: Timestamp,
    })
    .optional(),
});
export type InputRequest = z.infer<typeof InputRequest>;

export const ThreadMessage = z.object({
  id: z.string(),
  author: z.enum(['user', 'agent', 'system']),
  body: z.string(),
  runId: z.string().optional(),
  input: InputRequest.optional(),
  createdAt: Timestamp,
});
export type ThreadMessage = z.infer<typeof ThreadMessage>;

export const Artifact = z.object({
  id: z.string(),
  kind: z.enum(['file', 'link', 'text']),
  role: z.enum(['reference', 'output']),
  name: z.string(),
  url: z.string().url().optional(),
  storagePath: z.string().optional(),
  text: z.string().optional(),
  createdBy: z.enum(['user', 'agent']),
  createdAt: Timestamp,
});
export type Artifact = z.infer<typeof Artifact>;

export const RunState = z.enum([
  'queued',
  'dispatching',
  'claimed',
  'running',
  'waiting_input',
  'interrupted',
  'budget_exhausted',
  'succeeded',
  'failed',
]);
export type RunState = z.infer<typeof RunState>;

export const Run = z.object({
  id: z.string(),
  taskId: z.string(),
  projectId: z.string().optional(),
  device: z.string(),
  model: z.string(),
  state: RunState,
  trigger: z.enum(['new', 'comment', 'resume']),
  /** Lease generation: every worker write carries it and is rejected when it changed. */
  generation: z.number().int().nonnegative().default(0),
  lease: z.object({ owner: z.string(), expiresAt: Timestamp }).optional(),
  interrupt: z.boolean().default(false),
  attempts: z.number().int().nonnegative().default(0),
  /** Cloud Run execution (remote) or process id (local) started for this run. */
  execution: z.string().optional(),
  /** Storage path of the serialised session once the run ended; input for resumes. */
  sessionPath: z.string().optional(),
  /** Storage path of the archived trace once the run ended. */
  tracePath: z.string().optional(),
  endReason: z.string().optional(),
  error: z.string().optional(),
  spent: MicroEur.default(0),
  steps: z.number().int().nonnegative().default(0),
  startedAt: Timestamp.optional(),
  endedAt: Timestamp.optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Run = z.infer<typeof Run>;

export const DeviceState = z.enum(['approved', 'revoked']);
export type DeviceState = z.infer<typeof DeviceState>;

/** A Mac running the dodo daemon. Paired once from Settings; revoked there too. */
export const Device = z.object({
  id: z.string(),
  name: z.string().min(1),
  platform: z.string().default('darwin'),
  state: DeviceState,
  /** Daemon protocol version, reported on every claim; old daemons are refused. */
  protocol: z.number().int().optional(),
  version: z.string().optional(),
  /** Folders the agent may work in on this Mac, as the daemon reports them. */
  folders: z.array(z.string()).default([]),
  lastSeen: Timestamp.optional(),
  currentRunId: z.string().optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Device = z.infer<typeof Device>;

export const GlobalSettings = z.object({
  connector: z.enum(['custom', 'notion', 'linear', 'github']).default('custom'),
  defaults: AiConfig.omit({ enabled: true }).default({}),
  /** Default per-task cap when a task sets none. */
  defaultTaskBudget: MicroEur.default(eur(0.5)),
  /** Internal lifetime cap, mirroring the GCP lifetime budget and kept below its 40 EUR halt. */
  totalBudget: MicroEur.default(eur(35)),
  /** Internal monthly cap. */
  monthlyBudget: MicroEur.default(eur(25)),
  /** Set by the kill switch or by hand. While true no cost can be reserved. */
  halted: z.boolean().default(false),
  haltReason: z.string().optional(),
  /** Telegram pairing: the code is shown in Settings, the chat id is set by the webhook. */
  telegram: z
    .object({
      chatId: z.number().optional(),
      pairingCode: z.string().optional(),
      pairedAt: Timestamp.optional(),
    })
    .optional(),
  /** One-time code shown in Settings; `dodo login <code>` consumes it. */
  devicePairing: z.object({ code: z.string(), createdAt: Timestamp }).optional(),
  /** Permission rules answered "Always allow" everywhere, e.g. `Browser(navigate:x.com)`. */
  allowRules: z.array(z.string()).optional(),
});
export type GlobalSettings = z.infer<typeof GlobalSettings>;
