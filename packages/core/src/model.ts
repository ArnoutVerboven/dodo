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
  tools: z.array(z.string()).optional(),
  budget: MicroEur.optional(),
});
export type AiConfig = z.infer<typeof AiConfig>;

export const StatusLine = z.object({
  text: z.string(),
  nextAction: z.string().optional(),
  needsYou: z.boolean().default(false),
});
export type StatusLine = z.infer<typeof StatusLine>;

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
  externalRefs: z.record(z.string(), z.string()).default({}),
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
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Project = z.infer<typeof Project>;

export const InputKind = z.enum(['text', 'choice', 'approval']);
export type InputKind = z.infer<typeof InputKind>;

export const InputRequest = z.object({
  kind: InputKind,
  prompt: z.string(),
  options: z.array(z.string()).optional(),
  /** For approvals: the rule that "Always allow" would add, e.g. `Bash(git push:*)`. */
  suggestedRule: z.string().optional(),
  costEstimate: MicroEur.optional(),
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
  lease: z.object({ owner: z.string(), expiresAt: Timestamp }).optional(),
  interrupt: z.boolean().default(false),
  attempts: z.number().int().nonnegative().default(0),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Run = z.infer<typeof Run>;

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
});
export type GlobalSettings = z.infer<typeof GlobalSettings>;
