import type {
  Artifact,
  Content,
  FinishRequest,
  GenerateRequest,
  GenerateResponse,
  HeartbeatResponse,
  PersonalInfo,
  Project,
  RequestInputRequest,
  RunEvent,
  StatusLine,
  Task,
  VaultEntry,
} from '@dodo/core';

/**
 * Everything a worker may do, behind interfaces so the loop runs identically on Cloud Run,
 * on a Mac and in tests. Money and state transitions go through the control plane
 * (callables, trusted code); task-level writes use the run's own scoped identity.
 */
export interface ControlPlane {
  generate(req: Omit<GenerateRequest, 'runId'>): Promise<GenerateResponse>;
  heartbeat(): Promise<HeartbeatResponse>;
  requestInput(req: Omit<RequestInputRequest, 'runId'>): Promise<void>;
  finish(req: Omit<FinishRequest, 'runId'>): Promise<void>;
}

export interface TaskStore {
  getTask(): Promise<Task>;
  getProject(): Promise<Project | undefined>;
  updateSummary(markdown: string): Promise<void>;
  setStatus(line: StatusLine): Promise<void>;
  postMessage(body: string): Promise<void>;
  listArtifacts(): Promise<Artifact[]>;
  readArtifact(id: string): Promise<string>;
  addArtifact(a: {
    kind: 'link' | 'text';
    name: string;
    url?: string;
    text?: string;
  }): Promise<string>;
  /** Settings › Personal info: not secret, the agent may use it freely. */
  getPersonalInfo(): Promise<PersonalInfo | undefined>;
  /** Vault entries without their values (names, sites, field names). */
  listVault(): Promise<VaultEntry[]>;
  /** Thread messages (user and agent) for context on a new or comment-triggered run. */
  recentMessages(
    limit: number,
  ): Promise<Array<{ author: string; body: string; createdAt: number }>>;
}

export interface TraceSink {
  emit(event: Omit<RunEvent, 'id' | 'runId' | 'seq' | 'createdAt'>): Promise<void>;
}

/** Gateway errors the loop reacts to, mirrored from the callable's error codes. */
export class GatewayBudgetError extends Error {
  constructor(message = 'Task budget exhausted') {
    super(message);
  }
}
/** The gateway's hourly cap across all runs is reached; not a budget, over at the top of the hour. */
export class GatewayRateLimitError extends Error {
  constructor(message = 'Hourly spending cap reached') {
    super(message);
  }
}
export class GatewayHaltedError extends Error {
  constructor(message = 'Processing halted') {
    super(message);
  }
}
export class LeaseLostError extends Error {
  constructor(message = 'Run lease lost') {
    super(message);
  }
}

export interface RunInput {
  runId: string;
  task: Task;
  project: Project | undefined;
  model: string;
  trigger: 'new' | 'comment' | 'resume';
  /** The model's context window in tokens; the conversation is compacted well before it. */
  contextWindow?: number;
  /** Restored conversation for resumes and comment runs; empty for a new run. */
  session: Content[];
  /** The user's answer when resuming after `ask_user` or an approval card. */
  answer?: { value: string; prompt: string; suggestedRule?: string; alwaysAllow?: boolean };
}

export type { Content };
