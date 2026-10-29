import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

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
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');
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
