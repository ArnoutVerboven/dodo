import type {
  IngestTaskRequest,
  IngestTaskResponse,
  IngestTaskUpdate,
  IngestTaskView,
  InputRequest,
} from '@dodo/core';
import type { ConnectorStatus, Job, JobItem, JobRun, JobThread } from './model.js';

/**
 * What a job needs from the outside, as interfaces: the task app (only through the ingest API),
 * its own state store, notifications and the model gateway. The functions app wires them up.
 */

/** The task ingest API, in-process. A job never writes task documents itself. */
export interface TaskSink {
  create(req: IngestTaskRequest): Promise<IngestTaskResponse>;
  /** Undefined for unknown tasks and for tasks no source created (those a job may not touch). */
  get(taskId: string): Promise<IngestTaskView | undefined>;
  update(taskId: string, update: IngestTaskUpdate): Promise<void>;
  post(
    taskId: string,
    body: string,
    opts?: { input?: Omit<InputRequest, 'answer'>; action?: Record<string, unknown> },
  ): Promise<string>;
  /** Open tasks (any origin) whose title matches the words, read-only. */
  search(query: string): Promise<IngestTaskView[]>;
  /**
   * Moves the job action on an approval card from one of `from` to `to`, at most once.
   * Returns the action as it was before, or undefined when it was not in `from`.
   */
  transition(
    taskId: string,
    messageId: string,
    from: string[],
    to: string,
    patch?: Record<string, unknown>,
    answer?: string,
  ): Promise<Record<string, unknown> | undefined>;
}

export interface Notifier {
  notify(n: {
    title: string;
    body: string;
    taskId: string;
    input?: { messageId: string; kind: 'approval' };
  }): Promise<void>;
}

export type ClaimResult = 'claimed' | 'exists';

export interface JobStore {
  getJob(jobId: string): Promise<Job | undefined>;
  /** Takes the job's lease; false when another run holds it. */
  lock(jobId: string, runId: string, now: number, ttlMs: number): Promise<boolean>;
  unlock(
    jobId: string,
    runId: string,
    state: Partial<Job['state']>,
    extra?: { enabled?: boolean },
  ): Promise<void>;
  saveRun(run: JobRun): Promise<void>;
  /** Once per message: creates the ledger entry, or re-claims a failed / stale one within limits. */
  claimItem(
    jobId: string,
    item: Pick<JobItem, 'id' | 'threadId'>,
    now: number,
  ): Promise<ClaimResult>;
  peekItem(jobId: string, itemId: string): Promise<JobItem | undefined>;
  updateItem(jobId: string, itemId: string, patch: Partial<JobItem>): Promise<void>;
  /** Gives the message back (nothing was done with it), e.g. when the budget ran out. */
  releaseItem(jobId: string, itemId: string): Promise<void>;
  getThread(jobId: string, threadId: string): Promise<JobThread | undefined>;
  /** `approval: null` removes the pending card. */
  setThread(
    jobId: string,
    thread: Omit<JobThread, 'approval'> & { approval?: JobThread['approval'] | null },
  ): Promise<void>;
  openThreads(jobId: string, limit: number): Promise<JobThread[]>;
  /** Counts a new task against the daily cap; false when the cap is reached. */
  countTask(jobId: string, date: string, max: number): Promise<boolean>;
  connector(id: string): Promise<ConnectorStatus | undefined>;
  setConnector(id: string, status: Omit<ConnectorStatus, 'id'>): Promise<void>;
}
