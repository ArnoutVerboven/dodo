import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The agent's browser on a Mac is your own Chrome. The daemon runs Playwright MCP in extension
 * mode: a small server on localhost that drives Chrome through the Playwright Extension, in
 * your profile, with your sessions and cookies. The worker reaches it over MCP from inside the
 * sandbox; nothing else on the machine listens for it, and it runs only while a run needs it.
 *
 * Setup is one click of yours: install the extension from the Chrome Web Store. The first time
 * the daemon connects, Chrome asks you to allow it; `dodo browser connect <token>` with the
 * token from the extension's page skips that, for a Mac that works while you are away.
 */

export const EXTENSION_ID = 'mmlmfjhmonkocbjadbfplnigmagldckm';
export const EXTENSION_URL = `https://chromewebstore.google.com/detail/playwright-extension/${EXTENSION_ID}`;

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
  /** 'ready': runs that ask for your Chrome get it. Otherwise the problems say what is missing. */
  state: 'ready' | 'unavailable';
  profiles: string[];
  problems: string[];
  /** Ready, with a catch: without the token, Chrome asks you to allow the first connection. */
  warnings: string[];
}

export function browserReport(config: { browser?: { token?: string } }): BrowserReport {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (process.platform !== 'darwin') problems.push('your own Chrome is driven on macOS only');
  const profiles = process.platform === 'darwin' ? profilesWithExtension() : [];
  if (process.platform === 'darwin' && profiles.length === 0)
    problems.push(`Playwright Extension not installed in Chrome (dodo browser install)`);
  if (!problems.length && !config.browser?.token)
    warnings.push(
      'Chrome asks you to allow the first connection; dodo browser connect <token> skips that',
    );
  return { state: problems.length ? 'unavailable' : 'ready', profiles, problems, warnings };
}

export interface BrowserServer {
  /** The MCP endpoint the worker connects to, on localhost. */
  url: string;
  /** False once the server process is gone; the next run starts a fresh one. */
  running(): boolean;
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

/**
 * Start Playwright MCP against your Chrome, on a free localhost port. Chrome itself is only
 * touched on the first tool call: the extension opens its connect page then, and either
 * connects on the token or waits for you to click Allow. Files the agent saves land in
 * `outputDir`.
 */
export function startBrowserServer(
  token: string | undefined,
  outputDir: string,
  log: (message: string) => void,
): Promise<BrowserServer> {
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const child: ChildProcess = spawn(
    process.execPath,
    [
      mcpCli(),
      '--extension',
      '--port',
      '0',
      '--host',
      'localhost',
      '--shared-browser-context',
      '--image-responses',
      'omit',
      '--output-dir',
      outputDir,
    ],
    {
      env: token ? { ...process.env, PLAYWRIGHT_MCP_EXTENSION_TOKEN: token } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
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
        resolve({
          url: `${m[1]}/mcp`,
          running: () => child.exitCode === null && child.signalCode === null,
          stop,
        });
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
