import { z } from 'zod';
import { NewTask, TaskSource, TaskStatus, Timestamp } from './model.js';

/**
 * The task ingest API: how pipelines outside the task app (Jobs, scripts) put tasks on the
 * board. The same shapes are used over HTTP (`taskApi`) and in-process by Jobs.
 */

/** Ingested tasks never start an agent run by themselves; AI can be switched on later. */
export const IngestTaskRequest = NewTask.omit({ ai: true }).extend({
  title: z.string().min(1).max(200),
  description: z.string().max(20_000).default(''),
  status: TaskStatus.optional(),
  source: TaskSource,
  /** Unique per source (e.g. the Gmail thread id): a repeat returns the existing task. */
  idempotencyKey: z.string().min(1).max(500),
});
export type IngestTaskRequest = z.input<typeof IngestTaskRequest>;

export const IngestTaskResponse = z.object({
  taskId: z.string(),
  /** false when the idempotency key already had a task. */
  created: z.boolean(),
});
export type IngestTaskResponse = z.infer<typeof IngestTaskResponse>;

/** Changes a pipeline may make to a task it created. */
export const IngestTaskUpdate = z.object({
  title: z.string().min(1).max(200).optional(),
  status: TaskStatus.optional(),
  priority: NewTask.shape.priority.optional(),
  dueDate: z.iso.date().optional(),
  statusLine: z
    .object({ text: z.string().max(200), needsYou: z.boolean().default(false) })
    .optional(),
});
export type IngestTaskUpdate = z.input<typeof IngestTaskUpdate>;

export const IngestMessage = z.object({
  body: z.string().min(1).max(20_000),
});
export type IngestMessage = z.infer<typeof IngestMessage>;

/** A task as the API returns it: enough to match and link, not the whole document. */
export const IngestTaskView = z.object({
  id: z.string(),
  title: z.string(),
  status: TaskStatus,
  priority: z.string(),
  dueDate: z.string().optional(),
  tags: z.array(z.string()),
  source: TaskSource.optional(),
  updatedAt: Timestamp,
});
export type IngestTaskView = z.infer<typeof IngestTaskView>;

/** A personal access token for one source. Only its hash is stored. */
export const ApiToken = z.object({
  id: z.string(),
  name: z.string().min(1).max(100),
  source: TaskSource.shape.kind,
  /** First characters of the token, to recognise it in the list. */
  prefix: z.string(),
  hash: z.string(),
  revoked: z.boolean().default(false),
  lastUsedAt: Timestamp.optional(),
  createdAt: Timestamp,
});
export type ApiToken = z.infer<typeof ApiToken>;

export const CreateApiTokenRequest = z.object({
  name: z.string().min(1).max(100),
  source: TaskSource.shape.kind.default('api'),
});
export type CreateApiTokenRequest = z.input<typeof CreateApiTokenRequest>;
