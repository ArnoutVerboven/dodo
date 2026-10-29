import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The browser of a remote run: headless Chromium in the browser worker image, driven by
 * Playwright MCP as a child process on localhost, started for the run and gone with it. The
 * image sets `DODO_BROWSER=headless`; the plain worker image has neither Chromium nor this
 * flag, so a run that wants a browser only gets one when the dispatcher sent it to the
 * browser job. Nothing persists between runs yet: logins are typed from the vault each time,
 * and a question holds the run (and the page) for a while instead of ending it.
 */

export interface HeadlessBrowser {
  /** The MCP endpoint the browser tools connect to. */
  url: string;
  stop(): Promise<void>;
}

const START_TIMEOUT_MS = 30_000;

/** `@playwright/mcp`'s command, installed in the image next to the bundle (not bundled). */
export function mcpCli(): string {
  // Resolved at runtime, as the Mac daemon does: the bundle keeps the package external.
  return path.join(
    path.dirname(fileURLToPath(import.meta.resolve('@playwright/mcp/package.json'))),
    'cli.js',
  );
}

/**
 * Headless Chromium announces itself as "HeadlessChrome", and login providers (itsme among
 * them) refuse sessions from such a browser: a QR code taken from that page is rejected by
 * the phone app the moment it is scanned. Present the same Chromium the way a headed one does,
 * with its own major version.
 */
export function chromeUserAgent(version = chromiumVersion()): string {
  const major = version.split('.')[0] || '131';
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** The Chromium that Playwright MCP's own Playwright installs, from its browsers.json. */
function chromiumVersion(): string {
  let mcpDir: string;
  try {
    mcpDir = path.dirname(mcpCli());
  } catch {
    return '131.0.0.0';
  }
  const candidates = [
    path.join(mcpDir, 'node_modules', 'playwright-core', 'browsers.json'),
    path.join(mcpDir, '..', '..', 'playwright-core', 'browsers.json'),
  ];
  for (const file of candidates) {
    try {
      const json = JSON.parse(readFileSync(file, 'utf8')) as {
        browsers?: Array<{ name: string; browserVersion?: string }>;
      };
      const v = json.browsers?.find((b) => b.name === 'chromium')?.browserVersion;
      if (v) return v;
    } catch {
      // Not here; try the next place.
    }
  }
  return '131.0.0.0';
}

export function startHeadlessBrowser(opts: {
  outputDir: string;
  log: (message: string) => void;
}): Promise<HeadlessBrowser> {
  mkdirSync(opts.outputDir, { recursive: true, mode: 0o700 });
  const args = [
    '--browser',
    'chromium',
    '--headless',
    // The container runs the worker as an unprivileged user without user namespaces.
    '--no-sandbox',
    // In-memory profile: the container is thrown away with the run.
    '--isolated',
    '--port',
    '0',
    '--host',
    'localhost',
    '--shared-browser-context',
    '--viewport-size',
    '1280x900',
    '--user-agent',
    chromeUserAgent(),
    // Screenshots come back as images so ask_user can show them to the user; the model only
    // ever gets the text parts.
    '--image-responses',
    'allow',
    '--output-dir',
    opts.outputDir,
  ];
  const child: ChildProcess = spawn(process.execPath, [mcpCli(), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    });
  return new Promise<HeadlessBrowser>((resolve, reject) => {
    let out = '';
    let settled = false;
    const fail = (why: string) => {
      if (settled) return;
      settled = true;
      void stop();
      reject(new Error(`headless browser: ${why}`));
    };
    const timer = setTimeout(() => fail('did not start in time'), START_TIMEOUT_MS);
    const relay = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const line of text.split('\n')) if (line.trim()) opts.log(`  [browser] ${line}`);
      if (settled) return;
      out += text;
      const m = /Listening on (http:\/\/\S+)/.exec(out);
      if (m) {
        settled = true;
        clearTimeout(timer);
        resolve({ url: `${m[1]}/mcp`, stop });
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
