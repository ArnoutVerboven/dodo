import { spawn } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { createRequire as moduleRequire } from 'node:module';
import path from 'node:path';

/**
 * agent-browser (Vercel, Apache-2.0): a Rust CLI that drives Chrome over CDP through a small
 * daemon per session. dodo talks to it only through `batch` with the commands as JSON on stdin,
 * so what the agent types (vault values included) never shows up in a process list, and a
 * value that looks like a flag (`--headed`) stays a value.
 */

/** The native binary the npm package ships for this machine. */
export function agentBrowserBinary(): string {
  const require = moduleRequire(import.meta.url);
  const dir = path.dirname(require.resolve('agent-browser/package.json'));
  const os = process.platform === 'win32' ? 'win32' : process.platform;
  const file = path.join(
    dir,
    'bin',
    `agent-browser-${os}-${process.arch}${os === 'win32' ? '.exe' : ''}`,
  );
  // pnpm skips the package's postinstall, which is what marks it executable.
  try {
    chmodSync(file, 0o755);
  } catch {}
  return file;
}

export interface AgentBrowserOptions {
  binary?: string;
  /** One daemon and one browser per session name. */
  session: string;
  /**
   * Launch options. Every call carries the same ones: the daemon relaunches the browser when
   * they change.
   */
  headed?: boolean;
  executablePath?: string;
  /** A Chrome user data folder, kept between runs (cookies, logins). */
  profileDir?: string;
  userAgent?: string;
  /** Extra Chrome flags. */
  args?: string[];
  /**
   * The environment of the CLI, and so of the daemon it starts and the browser that starts.
   * Give it only what they need: everything here reaches Chrome.
   */
  env: Record<string, string>;
  /** Per call, the process is killed after this. */
  timeoutMs?: number;
}

export interface CommandResult {
  ok: boolean;
  data: Record<string, unknown>;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class AgentBrowser {
  private queue: Promise<unknown> = Promise.resolve();
  readonly binary: string;

  constructor(readonly opts: AgentBrowserOptions) {
    this.binary = opts.binary ?? agentBrowserBinary();
  }

  private base(): string[] {
    const o = this.opts;
    return [
      '--session',
      o.session,
      ...(o.headed ? ['--headed'] : []),
      ...(o.executablePath ? ['--executable-path', o.executablePath] : []),
      ...(o.profileDir ? ['--profile', o.profileDir] : []),
      ...(o.userAgent ? ['--user-agent', o.userAgent] : []),
      ...(o.args?.length ? ['--args', o.args.join(',')] : []),
    ];
  }

  /**
   * Runs commands one after another in one process. Calls are queued: two at once on a fresh
   * session race to start its daemon.
   */
  batch(commands: string[][], timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) {
    const next = this.queue.then(() => this.spawnBatch(commands, timeoutMs));
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Starts the session (daemon and browser) and turns off its live view: the daemon serves the
   * page, with mouse and keyboard input, on a localhost port by default, which anything on the
   * machine could reach. Throws when it stays on.
   */
  async start(): Promise<void> {
    const [off, status] = await this.batch([
      ['stream', 'disable'],
      ['stream', 'status'],
    ]);
    if (!off?.ok || status?.data.enabled !== false)
      throw new Error(
        `agent-browser did not start: ${off?.error ?? status?.error ?? 'its live view stayed on'}`,
      );
  }

  async one(command: string[], timeoutMs?: number): Promise<CommandResult> {
    const [r] = await this.batch([command], timeoutMs);
    return r ?? { ok: false, data: {}, error: 'no result' };
  }

  private spawnBatch(commands: string[][], timeoutMs: number): Promise<CommandResult[]> {
    return new Promise((resolve) => {
      const child = spawn(this.binary, [...this.base(), 'batch', '--json', '--omit-command'], {
        env: this.opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.stdout.on('data', (c: Buffer) => {
        out += c.toString('utf8');
      });
      child.stderr.on('data', (c: Buffer) => {
        if (err.length < 4000) err += c.toString('utf8');
      });
      const fail = (why: string) =>
        resolve(commands.map(() => ({ ok: false, data: {}, error: why })));
      child.on('error', (e) => {
        clearTimeout(timer);
        fail(e.message);
      });
      child.on('close', () => {
        clearTimeout(timer);
        if (timedOut) return fail(`the browser did not answer within ${timeoutMs / 1000} s`);
        resolve(parseBatch(out, commands.length, err));
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(commands));
    });
  }
}

/** `batch --json` prints an array with one row per command it ran. */
export function parseBatch(out: string, count: number, stderr = ''): CommandResult[] {
  let rows: unknown;
  try {
    rows = JSON.parse(out.trim() || 'null');
  } catch {
    rows = undefined;
  }
  const why = (stderr || out).trim().split('\n').slice(-3).join(' ') || 'no output';
  if (!Array.isArray(rows)) return Array.from({ length: count }, () => fail(why));
  const results: CommandResult[] = [];
  for (let i = 0; i < count; i++) {
    const r = rows[i] as
      | { success?: boolean; result?: unknown; error?: unknown; index?: number }
      | undefined;
    if (!r) {
      results.push(fail('not run'));
      continue;
    }
    const data =
      r.result && typeof r.result === 'object' ? (r.result as Record<string, unknown>) : {};
    results.push(
      r.success === false || r.error
        ? fail(typeof r.error === 'string' ? r.error : JSON.stringify(r.error ?? 'failed'))
        : { ok: true, data },
    );
  }
  return results;
}

const fail = (error: string): CommandResult => ({ ok: false, data: {}, error });
