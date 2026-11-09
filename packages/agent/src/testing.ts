import http from 'node:http';
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
import {
  type ControlPlane,
  GatewayBudgetError,
  GatewayHaltedError,
  GatewayRateLimitError,
  LeaseLostError,
  type TaskStore,
  type TraceSink,
} from './control-plane.js';

/** A scripted model: each entry is one response, in order. Used by tests and the local dry run. */
export type ScriptedTurn =
  | { text: string }
  | { calls: Array<{ name: string; args: Record<string, unknown> }> }
  | { error: Error };

export class FakeControlPlane implements ControlPlane {
  requests: GenerateRequest[] = [];
  heartbeats = 0;
  /** Thrown by the next heartbeats, in order (a network blip, a lost lease). */
  heartbeatErrors: Error[] = [];
  flags: Partial<HeartbeatResponse> = {};
  /** Input tokens every scripted reply reports. */
  inputTokens = 100;
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
      usage: {
        inputTokens: this.inputTokens,
        outputTokens: 20,
        thinkingTokens: 0,
        cachedInputTokens: 0,
      },
      cost: 1000,
      remaining: 400_000,
    };
  }
  private server: Promise<string> | undefined;

  /**
   * The same script behind a Gemini-shaped endpoint, for a harness with its own Gemini client:
   * each request is recorded in `requests` (in the gateway's form) and answered as Gemini
   * streams. A scripted error comes back the way the gateway sends that refusal.
   */
  geminiEndpoint(): Promise<{ baseUrl: string; token: string }> {
    this.server ??= new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => {
          body += c;
        });
        req.on('end', () => void this.answerGemini(req.url ?? '', body, res));
      });
      server.unref();
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as { port: number };
        resolve(`http://127.0.0.1:${port}/v1beta`);
      });
    });
    return this.server.then((baseUrl) => ({ baseUrl, token: 'run-token' }));
  }

  private async answerGemini(url: string, raw: string, res: http.ServerResponse) {
    const body = JSON.parse(raw || '{}') as {
      contents: Content[];
      systemInstruction?: { parts: Array<{ text?: string }> };
      tools?: Array<{ functionDeclarations: GenerateRequest['tools'] }>;
    };
    const model = /\/models\/([^:/]+):/.exec(url)?.[1] ?? 'unknown';
    try {
      const r = await this.generate({
        model,
        systemInstruction: body.systemInstruction?.parts.map((p) => p.text ?? '').join('\n'),
        contents: body.contents,
        tools: body.tools?.flatMap((t) => t.functionDeclarations ?? []),
      });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = {
        candidates: [{ content: r.content, finishReason: 'STOP', index: 0 }],
        usageMetadata: {
          promptTokenCount: r.usage.inputTokens,
          candidatesTokenCount: r.usage.outputTokens,
          totalTokenCount: r.usage.inputTokens + r.usage.outputTokens,
        },
      };
      res.end(`data: ${JSON.stringify(chunk)}\r\n\r\n`);
    } catch (err) {
      const [code, status] =
        err instanceof GatewayBudgetError || err instanceof GatewayRateLimitError
          ? [429, 'RESOURCE_EXHAUSTED']
          : err instanceof GatewayHaltedError
            ? [503, 'UNAVAILABLE']
            : err instanceof LeaseLostError
              ? [400, 'FAILED_PRECONDITION']
              : [500, 'INTERNAL'];
      const message =
        err instanceof GatewayRateLimitError
          ? `rate_governor: ${err.message}`
          : err instanceof GatewayHaltedError
            ? 'halted'
            : (err as Error).message;
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code, message, status } }));
    }
  }

  async heartbeat(): Promise<HeartbeatResponse> {
    this.heartbeats++;
    const err = this.heartbeatErrors.shift();
    if (err) throw err;
    const answer = this.inputRequests.length ? this.heldAnswers.shift() : undefined;
    return {
      ok: true,
      remaining: 400_000,
      pendingMessages: [],
      compact: false,
      ...this.flags,
      ...(answer ? { answer } : {}),
    };
  }
  /** Answers handed to a holding worker, one per heartbeat after a hold began. */
  heldAnswers: NonNullable<HeartbeatResponse['answer']>[] = [];
  async requestInput(req: Omit<RequestInputRequest, 'runId'>) {
    this.inputRequests.push(req);
    return { messageId: `m${this.inputRequests.length}` };
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
  personalInfo: PersonalInfo | undefined;
  vault: VaultEntry[] = [];
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
  async getPersonalInfo() {
    return this.personalInfo;
  }
  async listVault() {
    return this.vault;
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
