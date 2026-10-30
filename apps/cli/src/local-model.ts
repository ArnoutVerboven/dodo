import type { CliConfig } from './config.js';

/**
 * The local model this Mac offers its runs: any server with the OpenAI chat completions API
 * on this machine. dodo does not start it; `dodo model set` only says where it is.
 */
export type LocalModelConfig = NonNullable<CliConfig['localModel']>;

/** mlx_lm.server's default port; LM Studio uses 1234, Ollama 11434. */
export const DEFAULT_LOCAL_MODEL_URL = 'http://localhost:8080/v1';

/** `http://localhost:8080` → `http://localhost:8080/v1`; a `/v1` already there stays. */
export function normaliseBaseUrl(url: string): string {
  const trimmed = url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/, '');
  const parsed = new URL(trimmed);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`Not an http(s) URL: ${url}`);
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/** The host the worker connects to must be this Mac: the sandbox only lets it reach loopback. */
export function isLoopback(url: string): boolean {
  const host = new URL(url).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

export interface LocalModelCheck {
  ok: boolean;
  models: string[];
  /** The model called a tool when asked to: the agent can work with it. */
  toolCalls?: boolean;
  seconds?: number;
  problem?: string;
}

/**
 * Is the server up, which models does it list, and does the model call a tool when given one?
 * A model that cannot call tools can only talk, and dodo's agent works through tools.
 */
export async function checkLocalModel(
  config: LocalModelConfig,
  fetchFn: typeof fetch = fetch,
): Promise<LocalModelCheck> {
  const base = normaliseBaseUrl(config.url);
  let models: string[] = [];
  try {
    const r = await fetchFn(`${base}/models`, { signal: AbortSignal.timeout(5_000) });
    if (r.ok) {
      const body = (await r.json()) as { data?: Array<{ id?: string }> };
      models = (body.data ?? []).flatMap((m) => (m.id ? [m.id] : []));
    }
  } catch (err) {
    return {
      ok: false,
      models,
      problem: `nothing answers at ${base} (${(err as Error).message}); is the server running?`,
    };
  }
  const started = Date.now();
  try {
    const r = await fetchFn(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(300_000),
      body: JSON.stringify({
        ...(config.model ? { model: config.model } : {}),
        messages: [
          { role: 'system', content: 'You are a test. Always answer by calling a tool.' },
          { role: 'user', content: 'Set the status to "hello".' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'set_status',
              description: 'Set the task status line',
              parameters: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
              },
            },
          },
        ],
        max_tokens: 200,
        temperature: 0,
        stream: false,
      }),
    });
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    if (!r.ok) {
      const detail = (await r.text().catch(() => '')).slice(0, 300);
      return { ok: false, models, seconds, problem: `HTTP ${r.status}: ${detail}` };
    }
    const body = (await r.json()) as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: unknown[] } }>;
    };
    const msg = body.choices?.[0]?.message;
    const toolCalls = !!msg?.tool_calls?.length || /<tool_call>/.test(msg?.content ?? '');
    return { ok: true, models, toolCalls, seconds };
  } catch (err) {
    return { ok: false, models, problem: (err as Error).message };
  }
}

/** Stop the server after this long without a request. */
export const DEFAULT_IDLE_MINUTES = 10;
/** Where the on-demand endpoint listens: runs and other apps on this Mac call it. */
export const DEFAULT_SHARED_PORT = 8090;
/** Loading a 30B model from disk takes a while; give up after this. */
const START_TIMEOUT_MS = 5 * 60_000;

/** Does anything answer at the server's model list? */
export async function serverUp(url: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await fetchFn(`${normaliseBaseUrl(url)}/models`, {
      signal: AbortSignal.timeout(2_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export interface ServerProcess {
  running(): boolean;
  stop(): void;
}

export interface ModelServerDeps {
  fetchFn?: typeof fetch;
  /** Starts the server command; the daemon spawns it as you, outside the sandbox. */
  spawn: (command: string[]) => ServerProcess;
  log: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

/**
 * The model server on demand: started by the first request when nothing answers yet, stopped
 * once no request has come for a while, so its memory is free in between. Requests in flight
 * keep it up. A server dodo did not start (yours, LM Studio) is used as it is, never stopped.
 */
export class ModelServer {
  private proc: ServerProcess | undefined;
  private starting: Promise<boolean> | undefined;
  private idle: unknown;
  private inFlight = 0;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(
    private readonly config: LocalModelConfig,
    private readonly deps: ModelServerDeps,
  ) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  }

  /** A request starts: the server answers when this resolves true. Pair with `done()`. */
  async acquire(): Promise<boolean> {
    this.inFlight++;
    if (this.idle) {
      this.clearTimer(this.idle);
      this.idle = undefined;
    }
    this.starting ??= this.start().finally(() => {
      this.starting = undefined;
    });
    const ok = await this.starting;
    if (!ok) this.done();
    return ok;
  }

  /** A request ended: once none is left, the idle clock starts for a server dodo started. */
  done() {
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (this.inFlight > 0 || !this.proc) return;
    if (this.idle) this.clearTimer(this.idle);
    const minutes = this.config.idleMinutes ?? DEFAULT_IDLE_MINUTES;
    this.idle = this.setTimer(() => {
      this.idle = undefined;
      if (this.inFlight > 0) return;
      this.deps.log(`local model: idle for ${minutes} min; stopping it to free its memory`);
      this.stop();
    }, minutes * 60_000);
  }

  private async start(): Promise<boolean> {
    const fetchFn = this.deps.fetchFn ?? fetch;
    if (await serverUp(this.config.url, fetchFn)) return true;
    const command = this.config.command;
    if (!command?.length) {
      this.deps.log(`local model: nothing answers at ${this.config.url}, and no start command`);
      return false;
    }
    if (!this.proc?.running()) {
      this.deps.log(`local model: starting ${command.join(' ')}`);
      this.proc = this.deps.spawn(command);
    }
    const until = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < until) {
      if (!this.proc?.running()) {
        this.deps.log('local model: the server exited while starting (see ~/.dodo/model.log)');
        this.proc = undefined;
        return false;
      }
      if (await serverUp(this.config.url, fetchFn)) {
        this.deps.log('local model: ready');
        return true;
      }
      await this.sleep(1_000);
    }
    this.deps.log('local model: not ready after 5 minutes; stopping it');
    this.stop();
    return false;
  }

  stop() {
    if (this.idle) this.clearTimer(this.idle);
    this.idle = undefined;
    this.proc?.stop();
    this.proc = undefined;
  }
}

/**
 * The shared endpoint (`http://localhost:8090/v1` by default): an OpenAI-compatible front for
 * the model server that starts it on the first request and stops it when idle. dodo's runs use
 * it, and so can any other app on this Mac, so they share one copy of the model in memory.
 * It forwards `/v1/*` as it is, one request at a time (a laptop runs one generation well).
 */
export async function startSharedEndpoint(
  config: LocalModelConfig,
  server: ModelServer,
  log: (message: string) => void,
): Promise<{ url: string; close(): Promise<void> }> {
  const { createServer } = await import('node:http');
  const port = config.port ?? DEFAULT_SHARED_PORT;
  const upstream = new URL(normaliseBaseUrl(config.url));
  let queue: Promise<unknown> = Promise.resolve();
  const http = createServer((req, res) => {
    const path = req.url ?? '/';
    if (!path.startsWith('/v1/')) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const work = queue.then(async () => {
        if (!(await server.acquire())) {
          res
            .writeHead(503, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: { message: 'The local model server did not start.' } }));
          return;
        }
        try {
          const target = `${upstream.origin}${upstream.pathname.replace(/\/v\d+$/, '')}${path}`;
          const r = await fetch(target, {
            method: req.method,
            headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
            body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
          });
          res.writeHead(r.status, {
            'content-type': r.headers.get('content-type') ?? 'application/json',
          });
          if (r.body) for await (const chunk of r.body) res.write(chunk);
          res.end();
        } catch (err) {
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: (err as Error).message } }));
        } finally {
          server.done();
        }
      });
      queue = work.catch(() => undefined);
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, 'localhost', () => resolve());
  });
  // Generations can be long; node's defaults would cut them off.
  http.requestTimeout = 0;
  http.headersTimeout = 0;
  const address = http.address();
  const url = `http://localhost:${typeof address === 'object' && address ? address.port : port}/v1`;
  log(`local model: on demand at ${url} (starts on the first request)`);
  return {
    url,
    close: () =>
      new Promise((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      }),
  };
}
