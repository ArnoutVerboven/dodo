import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * The agent's browser on a Mac is a real Chrome window on your screen, driven by Playwright MCP,
 * which the daemon runs as a small server on localhost. The worker reaches it over MCP from
 * inside the sandbox; nothing else on the machine listens for it. Two ways to get that window:
 *
 *   window      (default, nothing to install) dodo's own Chrome window, with its own profile
 *               under ~/.dodo/chrome. Log in to a site there once; the session stays.
 *   extension   your everyday Chrome, with your logins, through the Playwright Extension from
 *               the Chrome Web Store. Chrome asks you to allow the first connection, or
 *               `dodo browser connect <token>` with the extension's token skips that.
 *
 * The extension is used when it is installed, unless `dodo browser use window` says otherwise.
 */

export const EXTENSION_ID = 'mmlmfjhmonkocbjadbfplnigmagldckm';
export const EXTENSION_URL = `https://chromewebstore.google.com/detail/playwright-extension/${EXTENSION_ID}`;

export type BrowserMode = 'window' | 'extension';

export interface BrowserConfig {
  /** Force one way; by default the extension when installed, else dodo's own window. */
  mode?: BrowserMode;
  /** The Playwright Extension's token: skips Chrome's "allow" dialog. */
  token?: string;
}

/** Where Playwright looks for Chrome on a Mac; `DODO_CHROME_APP` overrides it (tests). */
export function chromeExecutable(): string {
  return (
    process.env.DODO_CHROME_APP ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  );
}

/** Chrome's user data folder; `DODO_CHROME_USER_DATA_DIR` overrides it (tests, other channels). */
export function chromeUserDataDir(): string {
  return (
    process.env.DODO_CHROME_USER_DATA_DIR ??
    path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
  );
}

/** The Chrome profiles the extension is installed in, the way Playwright itself looks for it. */
export function profilesWithExtension(userDataDir = chromeUserDataDir()): string[] {
  let entries: string[];
  try {
    entries = readdirSync(userDataDir);
  } catch {
    return [];
  }
  return entries
    .filter((e) => e === 'Default' || /^Profile \d+$/.test(e))
    .filter((profile) => {
      const dir = path.join(userDataDir, profile);
      if (existsSync(path.join(dir, 'Extensions', EXTENSION_ID))) return true;
      return ['Preferences', 'Secure Preferences'].some((f) => {
        try {
          const prefs = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as {
            extensions?: { settings?: Record<string, object> };
          };
          const record = prefs.extensions?.settings?.[EXTENSION_ID];
          return !!record && Object.keys(record).length > 0;
        } catch {
          return false;
        }
      });
    });
}

export interface BrowserReport {
  /** 'ready': runs that ask for a browser get one. Otherwise the problems say what is missing. */
  state: 'ready' | 'unavailable';
  /** How the window is obtained when ready. */
  mode?: BrowserMode;
  /** Chrome profiles with the extension. */
  profiles: string[];
  problems: string[];
  /** Ready, with a catch worth knowing. */
  warnings: string[];
}

export function browserReport(config: { browser?: BrowserConfig }): BrowserReport {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (process.platform !== 'darwin') {
    return {
      state: 'unavailable',
      profiles: [],
      problems: ['the browser is driven on macOS only'],
      warnings,
    };
  }
  const profiles = profilesWithExtension();
  const chrome = existsSync(chromeExecutable());
  const wanted = config.browser?.mode;
  let mode: BrowserMode | undefined;
  if (wanted === 'extension' || (wanted === undefined && profiles.length > 0)) {
    if (profiles.length === 0)
      problems.push('Playwright Extension not installed in Chrome (dodo browser install)');
    else {
      mode = 'extension';
      if (!config.browser?.token)
        warnings.push(
          'Chrome asks you to allow the first connection; dodo browser connect <token> skips that',
        );
    }
  } else if (!chrome) {
    problems.push(`Google Chrome not found at ${chromeExecutable()}; install Chrome`);
  } else {
    mode = 'window';
    warnings.push(
      "dodo's own Chrome window: log in to a site there once, the session stays (dodo browser install puts the agent in your everyday Chrome instead)",
    );
  }
  return { state: problems.length ? 'unavailable' : 'ready', mode, profiles, problems, warnings };
}

export interface BrowserServer {
  /** The MCP endpoint the worker connects to, on localhost. */
  url: string;
  /** False once the server process is gone; the next run starts a fresh one. */
  running(): boolean;
  /**
   * Make sure the window is open and held before a run: Playwright MCP closes the browser when
   * its last client leaves, and the worker leaves at the end of every run. The daemon stays
   * connected as a client of its own, so the window and its tabs outlive the run and a login
   * you did for the agent is still there when the next run picks the task up.
   */
  hold(): Promise<void>;
  stop(): Promise<void>;
}

/** Where `@playwright/mcp`'s command lives; the bundle keeps the package external. */
export function mcpCli(): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.resolve('@playwright/mcp/package.json'))),
    'cli.js',
  );
}

const START_TIMEOUT_MS = 15_000;

export interface BrowserServerOptions {
  mode: BrowserMode;
  token?: string;
  /** Where files the agent saves land. */
  outputDir: string;
  /** The profile of dodo's own window (window mode): cookies and logins, kept between runs. */
  profileDir: string;
  log: (message: string) => void;
}

/** The daemon's own seat at the server; see `BrowserServer.hold`. */
class KeepAlive {
  private client?: Client;
  private connecting?: Promise<void>;
  constructor(
    private url: string,
    private log: (message: string) => void,
  ) {}

  async hold(): Promise<void> {
    if (!this.client) {
      this.connecting ??= this.connect().finally(() => {
        this.connecting = undefined;
      });
      await this.connecting;
    }
    // Any tool call does it: the server only takes a seat at the browser on the first call, and
    // takes it again after the window was closed by hand.
    await this.client?.callTool({ name: 'browser_tabs', arguments: { action: 'list' } });
  }

  private async connect(): Promise<void> {
    const client = new Client({ name: 'dodo-daemon', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(this.url)));
    client.onclose = () => {
      if (this.client === client) {
        this.client = undefined;
        this.log('browser: lost the hold on the window; taking it again on the next run');
      }
    };
    this.client = client;
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    await client?.close().catch(() => {});
  }
}

/**
 * Start Playwright MCP on a free localhost port and take a seat at the browser: dodo's own
 * window opens, or the extension's connect page does and either connects on the token or waits
 * for you to click Allow.
 */
export function startBrowserServer({
  mode,
  token,
  outputDir,
  profileDir,
  log,
}: BrowserServerOptions): Promise<BrowserServer> {
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const common = [
    '--port',
    '0',
    '--host',
    'localhost',
    '--shared-browser-context',
    '--image-responses',
    'omit',
    '--output-dir',
    outputDir,
  ];
  let args: string[];
  if (mode === 'extension') args = ['--extension', ...common];
  else {
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    args = ['--browser', 'chrome', '--user-data-dir', profileDir, ...common];
  }
  const child: ChildProcess = spawn(process.execPath, [mcpCli(), ...args], {
    env: token ? { ...process.env, PLAYWRIGHT_MCP_EXTENSION_TOKEN: token } : process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    });
  return new Promise<BrowserServer>((resolve, reject) => {
    let out = '';
    let settled = false;
    const fail = (why: string) => {
      if (settled) return;
      settled = true;
      void stop();
      reject(new Error(`browser server: ${why}`));
    };
    const timer = setTimeout(() => fail('did not start in time'), START_TIMEOUT_MS);
    const relay = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const line of text.split('\n')) if (line.trim()) log(`  [browser] ${line}`);
      if (settled) return;
      out += text;
      const m = /Listening on (http:\/\/\S+)/.exec(out);
      if (m) {
        settled = true;
        clearTimeout(timer);
        const url = `${m[1]}/mcp`;
        const keepAlive = new KeepAlive(url, log);
        const server: BrowserServer = {
          url,
          running: () => child.exitCode === null && child.signalCode === null,
          hold: () => keepAlive.hold(),
          stop: async () => {
            await keepAlive.close();
            await stop();
          },
        };
        keepAlive.hold().then(
          () => resolve(server),
          (err: Error) => {
            void server.stop();
            reject(new Error(`browser server: ${err.message}`));
          },
        );
      }
    };
    child.stdout?.on('data', relay);
    child.stderr?.on('data', relay);
    child.on('error', (err) => {
      clearTimeout(timer);
      fail(err.message);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      fail(`exited with ${code}`);
    });
  });
}
