import { spawn as spawnChild } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { type CliConfig, home } from './config.js';

/**
 * The local model this Mac offers its runs: the machine's local-LLM gateway when one answers,
 * else any server with the OpenAI chat completions API on this machine (started on demand by
 * the daemon when the config has a `command`).
 */
export type LocalModelConfig = NonNullable<CliConfig['localModel']>;

/**
 * Where dodo's own server listens (mlx_lm.server's default port); LM Studio uses 1234, Ollama
 * 11434. `127.0.0.1`, not `localhost`: node tries `::1` first, and mlx_lm.server is on IPv4.
 */
export const DEFAULT_LOCAL_MODEL_URL = 'http://127.0.0.1:8080/v1';
/** The model dodo sets up when it finds it in the cache; the same one the gateway serves. */
export const DEFAULT_MLX_MODEL = 'mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit';

/**
 * The machine's local-LLM gateway (llama-swap under launchd), shared by every app on this Mac:
 * it loads the model on the first request and unloads it when idle, by itself. dodo only talks
 * to it, never starts or stops it. Contract:
 * https://github.com/ArnoutVerboven/dotfiles/blob/main/llm/README.md#client-contract
 */
export const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:8090/v1';
/** The gateway's name for whichever model it serves by default. */
export const GATEWAY_MODEL = 'default';

/**
 * The gateway to try: `localModel.gateway` in the config (`false` or `""`: none), else
 * `$LOCAL_LLM_URL` (empty: none), else the default. Undefined when there is none to try, or it
 * is not on this Mac (the run's sandbox reaches only loopback).
 */
export function gatewayUrl(
  config: Pick<LocalModelConfig, 'gateway'> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw =
    config?.gateway !== undefined
      ? config.gateway
      : env.LOCAL_LLM_URL !== undefined
        ? env.LOCAL_LLM_URL
        : DEFAULT_GATEWAY_URL;
  if (raw === false || !raw.trim()) return undefined;
  try {
    const base = normaliseBaseUrl(raw);
    return isLoopback(base) ? base : undefined;
  } catch {
    return undefined;
  }
}

/** Is the gateway up? A 200 with a JSON `data` list from its model list (this loads nothing). */
export async function gatewayUp(url: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await fetchFn(`${normaliseBaseUrl(url)}/models`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (r.status !== 200) return false;
    const body = (await r.json()) as { data?: unknown };
    return Array.isArray(body?.data);
  } catch {
    return false;
  }
}

/** The command dodo's own mlx_lm.server runs with, as the gateway contract has it. */
export function mlxServerCommand(program: string, model: string, port: string): string[] {
  return [
    program,
    '--model',
    model,
    '--host',
    '127.0.0.1',
    '--port',
    port,
    '--chat-template-args',
    '{"enable_thinking":false}',
  ];
}

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

/** Stop the server after this long without a request (the gateway's idle time too). */
export const DEFAULT_IDLE_MINUTES = 15;
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

/** Has the server dodo started finished loading? `/health` (mlx_lm.server, llama.cpp), else the model list. */
async function serverReady(url: string, fetchFn: typeof fetch): Promise<boolean> {
  const base = normaliseBaseUrl(url);
  try {
    const r = await fetchFn(`${base.replace(/\/v\d+$/, '')}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (r.ok) return true;
  } catch {
    // not up yet, or no /health: try the model list
  }
  return serverUp(base, fetchFn);
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
      if (await serverReady(this.config.url, fetchFn)) {
        this.deps.log('local model: ready');
        return true;
      }
      await this.sleep(1_000);
    }
    this.deps.log('local model: not ready after 5 minutes; stopping it');
    this.stop();
    return false;
  }

  /** Running a server dodo started, with no request in flight. */
  idleOwnServer(): boolean {
    return !!this.proc && this.inFlight === 0 && !this.starting;
  }

  stop() {
    if (this.idle) this.clearTimer(this.idle);
    this.idle = undefined;
    this.proc?.stop();
    this.proc = undefined;
  }
}

/**
 * The on-demand endpoint for dodo's own runs when there is no gateway: an OpenAI-compatible
 * front for dodo's own model server that starts it on the first request and stops it when idle,
 * so a run that never calls the model never loads it. Private to the daemon's runs: it listens
 * on a free port of `127.0.0.1` (never the gateway's 8090), and sharing the model with other
 * apps is the gateway's job. It forwards `/v1/*` as it is, one request at a time.
 */
export async function startOnDemandEndpoint(
  config: LocalModelConfig,
  server: ModelServer,
  log: (message: string) => void,
): Promise<{ url: string; close(): Promise<void> }> {
  const { createServer } = await import('node:http');
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
    http.listen(0, '127.0.0.1', () => resolve());
  });
  // Generations can be long; node's defaults would cut them off.
  http.requestTimeout = 0;
  http.headersTimeout = 0;
  const address = http.address();
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`;
  log(`local model: dodo's own server on demand at ${url} (starts on the first request)`);
  return {
    url,
    close: () =>
      new Promise((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      }),
  };
}

/** Which server a run talks to: the gateway, dodo's own (on demand), or one you run yourself. */
export type LocalModelVia = 'gateway' | 'own' | 'yours';

export interface LocalModelRoute {
  url: string;
  model?: string;
  via: LocalModelVia;
}

/**
 * The daemon's local model. For each run it asks again whether the gateway is up (it can come
 * up, or go away, while the daemon runs): if so, the run talks to it with model `default` and
 * dodo starts nothing. Otherwise the run gets dodo's own server, on demand when the config has a
 * start command, or the server at the configured URL as it is.
 */
export class LocalModelHost {
  readonly server: ModelServer | undefined;
  private front: Promise<{ url: string; close(): Promise<void> } | undefined> | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    private readonly config: LocalModelConfig,
    private readonly deps: ModelServerDeps & { env?: NodeJS.ProcessEnv },
  ) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.env = deps.env ?? process.env;
    this.server = config.command?.length ? new ModelServer(config, deps) : undefined;
  }

  /** The gateway this host tries, if any. */
  gateway(): string | undefined {
    return gatewayUrl(this.config, this.env);
  }

  async forRun(): Promise<LocalModelRoute> {
    const gateway = this.gateway();
    if (gateway && (await gatewayUp(gateway, this.fetchFn))) {
      // Two copies of the model would not fit: free dodo's own once nothing uses it.
      if (this.server?.idleOwnServer()) {
        this.deps.log("local model: the gateway is up; stopping dodo's own server");
        this.server.stop();
      }
      return { url: gateway, model: GATEWAY_MODEL, via: 'gateway' };
    }
    const server = this.server;
    if (server) {
      this.front ??= startOnDemandEndpoint(this.config, server, this.deps.log).catch(
        (err: Error) => {
          this.deps.log(`local model: on-demand endpoint not started (${err.message})`);
          this.front = undefined;
          return undefined;
        },
      );
      const front = await this.front;
      if (front) return { url: front.url, model: this.config.model, via: 'own' };
    }
    return { url: normaliseBaseUrl(this.config.url), model: this.config.model, via: 'yours' };
  }

  async close() {
    this.server?.stop();
    const front = await this.front;
    this.front = undefined;
    await front?.close();
  }
}

/** The model server, as you and outside the sandbox (like local MCP servers); output to a log. */
export function spawnModelServer(command: string[]): ServerProcess {
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  const out = openSync(`${home()}/model.log`, 'a');
  const child = spawnChild(command[0] as string, command.slice(1), {
    stdio: ['ignore', out, out],
    env: process.env,
  });
  closeSync(out);
  let alive = true;
  const exited = new Promise<void>((resolve) => {
    const done = () => {
      alive = false;
      resolve();
    };
    child.on('exit', done);
    child.on('error', done);
  });
  return {
    running: () => alive,
    stop: () => {
      if (!alive) return;
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 10_000);
      void exited.then(() => clearTimeout(force));
    },
  };
}

/** Where Hugging Face keeps downloaded models (`HF_HUB_CACHE`, `HF_HOME`, or the default). */
export function hubCache(): string {
  const env = process.env;
  if (env.HF_HUB_CACHE) return env.HF_HUB_CACHE;
  const home = env.HF_HOME ?? `${env.HOME ?? ''}/.cache/huggingface`;
  return `${home}/hub`;
}

const CHAT_FAMILY = /(qwen|llama|mistral|gemma|phi|gpt-oss|granite|deepseek|smollm)/i;
const NOT_CHAT = /(whisper|parakeet|embed|rerank|vision|-vl-|tts|diariz)/i;

/**
 * MLX chat models already downloaded (`models--mlx-community--…` with a snapshot), best first:
 * instruct models before base ones, Qwen (good at tool calls) before the rest.
 */
export async function findMlxModels(hub = hubCache()): Promise<string[]> {
  const { readdirSync, existsSync } = await import('node:fs');
  let entries: string[];
  try {
    entries = readdirSync(hub);
  } catch {
    return [];
  }
  const repos = entries
    .filter((e) => e.startsWith('models--'))
    .map((e) => ({ dir: e, repo: e.slice('models--'.length).replace('--', '/') }))
    .filter(({ repo }) => /mlx/i.test(repo) && CHAT_FAMILY.test(repo) && !NOT_CHAT.test(repo))
    .filter(({ dir }) => {
      try {
        return readdirSync(`${hub}/${dir}/snapshots`).some((s) =>
          existsSync(`${hub}/${dir}/snapshots/${s}/config.json`),
        );
      } catch {
        return false;
      }
    })
    .map(({ repo }) => repo);
  const score = (r: string) =>
    (r === DEFAULT_MLX_MODEL ? 4 : 0) +
    (/instruct|chat|-it\b/i.test(r) ? 2 : 0) +
    (/qwen/i.test(r) ? 1 : 0);
  return repos.sort((a, b) => score(b) - score(a) || a.localeCompare(b));
}

/** `mlx_lm.server` as an absolute path, from your shell's PATH or uv's / pip's tool folders. */
export async function findMlxServer(): Promise<string | undefined> {
  const { execFileSync } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  try {
    const found = execFileSync('/bin/sh', ['-lc', 'command -v mlx_lm.server'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (found) return found;
  } catch {
    // not on PATH
  }
  const home = process.env.HOME ?? '';
  return [`${home}/.local/bin/mlx_lm.server`, '/opt/homebrew/bin/mlx_lm.server'].find((p) =>
    existsSync(p),
  );
}

/** Install mlx-lm as a tool of its own (uv if you have it, else pip for your user). */
export async function installMlxLm(log: (m: string) => void): Promise<string | undefined> {
  const { execFileSync } = await import('node:child_process');
  const tries: Array<[string, string]> = [
    ['uv', 'uv tool install --upgrade mlx-lm'],
    ['pipx', 'pipx install mlx-lm'],
    ['pip3', 'pip3 install --user --upgrade mlx-lm'],
  ];
  for (const [tool, cmd] of tries) {
    try {
      execFileSync('/bin/sh', ['-lc', `command -v ${tool}`], { stdio: 'ignore' });
    } catch {
      continue;
    }
    log(`Installing mlx-lm: ${cmd}`);
    try {
      execFileSync('/bin/sh', ['-lc', cmd], { stdio: 'inherit' });
      return findMlxServer();
    } catch {
      log(`  ${cmd} failed`);
    }
  }
  return undefined;
}

/**
 * The local model in one go, for `dodo setup` and a bare `dodo model set`: the best MLX chat
 * model already in the Hugging Face cache, served on demand by mlx_lm.server (installed when
 * missing). Undefined, with the reason logged, when this Mac has none or cannot run MLX.
 */
export async function detectLocalModel(
  log: (m: string) => void,
  install = true,
): Promise<LocalModelConfig | undefined> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    log('Local model: skipped (MLX needs an Apple-silicon Mac).');
    return undefined;
  }
  const [model] = await findMlxModels();
  if (!model) {
    log(
      `Local model: none found in ${hubCache()} (optional; see docs/LOCAL_MODEL.md to download one).`,
    );
    return undefined;
  }
  let server = await findMlxServer();
  if (!server && install) server = await installMlxLm(log);
  if (!server) {
    log(`Local model: found ${model}, but mlx_lm.server is not installed (pip3 install mlx-lm).`);
    return undefined;
  }
  log(`Local model: ${model}, started on demand by ${server}.`);
  return {
    url: DEFAULT_LOCAL_MODEL_URL,
    model,
    command: mlxServerCommand(server, model, new URL(DEFAULT_LOCAL_MODEL_URL).port),
  };
}
