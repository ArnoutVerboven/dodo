import type {
  Artifact,
  Content,
  FinishRequest,
  GenerateRequest,
  GenerateResponse,
  HeartbeatResponse,
  Project,
  RequestInputRequest,
  RunEvent,
  StatusLine,
  Task,
} from '@dodo/core';
import type { ControlPlane, TaskStore, TraceSink } from './control-plane.js';

/** A scripted model: each entry is one response, in order. Used by tests and the local dry run. */
export type ScriptedTurn =
  | { text: string }
  | { calls: Array<{ name: string; args: Record<string, unknown> }> }
  | { error: Error };

export class FakeControlPlane implements ControlPlane {
  requests: GenerateRequest[] = [];
  heartbeats = 0;
  flags: Partial<HeartbeatResponse> = {};
  inputRequests: Array<Omit<RequestInputRequest, 'runId'>> = [];
  finishes: Array<Omit<FinishRequest, 'runId'>> = [];

  constructor(private script: ScriptedTurn[]) {}

  async generate(req: Omit<GenerateRequest, 'runId'>): Promise<GenerateResponse> {
    this.requests.push(structuredClone({ runId: 'r', ...req }));
    const turn = this.script.shift();
    if (!turn) throw new Error('Script exhausted');
    if ('error' in turn) throw turn.error;
    const content: Content =
      'text' in turn
        ? { role: 'model', parts: [{ text: turn.text }] }
        : {
            role: 'model',
            parts: turn.calls.map((c, i) => ({
              functionCall: { id: `c${i}`, name: c.name, args: c.args },
            })),
          };
    return {
      content,
      usage: { inputTokens: 100, outputTokens: 20, thinkingTokens: 0, cachedInputTokens: 0 },
      cost: 1000,
      remaining: 400_000,
    };
  }
  async heartbeat(): Promise<HeartbeatResponse> {
    this.heartbeats++;
    return { ok: true, remaining: 400_000, pendingMessages: [], ...this.flags };
  }
  async requestInput(req: Omit<RequestInputRequest, 'runId'>) {
    this.inputRequests.push(req);
  }
  async finish(req: Omit<FinishRequest, 'runId'>) {
    this.finishes.push(req);
  }
}

export class MemoryTaskStore implements TaskStore {
  summary = '';
  status: StatusLine | undefined;
  messages: Array<{ author: string; body: string; createdAt: number }> = [];
  artifacts: Artifact[] = [];
  constructor(
    public task: Task,
    public project: Project | undefined = undefined,
  ) {}
  async getTask() {
    return this.task;
  }
  async getProject() {
    return this.project;
  }
  async updateSummary(markdown: string) {
    this.summary = markdown;
  }
  async setStatus(line: StatusLine) {
    this.status = line;
  }
  async postMessage(body: string) {
    this.messages.push({ author: 'agent', body, createdAt: Date.now() });
  }
  async listArtifacts() {
    return this.artifacts;
  }
  async readArtifact(id: string) {
    const a = this.artifacts.find((x) => x.id === id);
    if (!a) throw new Error(`No artifact ${id}`);
    return a.text ?? a.url ?? '';
  }
  async addArtifact(a: { kind: 'link' | 'text'; name: string; url?: string; text?: string }) {
    const id = `a${this.artifacts.length + 1}`;
    this.artifacts.push({ id, role: 'output', createdBy: 'agent', createdAt: Date.now(), ...a });
    return id;
  }
  async recentMessages(limit: number) {
    return this.messages.slice(-limit);
  }
}

export class MemoryTrace implements TraceSink {
  events: Array<Omit<RunEvent, 'id' | 'runId' | 'seq' | 'createdAt'>> = [];
  async emit(e: Omit<RunEvent, 'id' | 'runId' | 'seq' | 'createdAt'>) {
    this.events.push(e);
  }
  types() {
    return this.events.map((e) => e.type);
  }
}

export const sampleTask = (overrides: Partial<Task> = {}): Task => ({
  id: 't1',
  title: 'Summarise the attached document',
  titleSource: 'user',
  description: 'Read the attached notes and write a short summary.',
  status: 'in_progress',
  priority: 'none',
  tags: [],
  ai: { enabled: true },
  summary: '',
  externalRefs: {},
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});
