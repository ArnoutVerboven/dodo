import { chownSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { type BrowserClient, connectMcpServer } from '@dodo/agent';
import type { createConnection as CreateConnection } from '@playwright/mcp';
import type { BrowserContextOptions } from 'playwright';

/**
 * The browser of a remote run: headless Chromium in the browser worker image. The worker
 * launches it with Playwright, opens one context, and runs Playwright MCP in this process on
 * that context: the browser tools reach it over an in-memory MCP transport, and the worker
 * still owns the context, so it can restore the task's logins (Playwright `storageState`,
 * cookies and local storage) at the start and read them back at the end for the control
 * plane to keep until the task is closed.
 *
 * The image sets `DODO_BROWSER=headless`; the plain worker image has neither Chromium nor
 * this flag, so a run that wants a browser only gets one when the dispatcher sent it to the
 * browser job. `playwright` and `@playwright/mcp` are installed in the image next to the
 * bundle and resolved at runtime (the bundle keeps them external).
 */

/** Playwright's `storageState` as JSON. */
export type StorageStateJson = string;

export interface HeadlessBrowser {
  client: BrowserClient;
  /** The context's logins now, for the next run of this task. */
  storageState(): Promise<StorageStateJson>;
  /** Adds stored cookies (the shared Google session) to the live context. */
  addState(json: StorageStateJson): Promise<boolean>;
  /** The page the agent is on, for the next run's hint; none on a blank page. */
  lastUrl(): string | undefined;
  stop(): Promise<void>;
}

/**
 * Headless Chromium announces itself as "HeadlessChrome", and login providers (itsme among
 * them) refuse sessions from such a browser: a QR code taken from that page is rejected by
 * the phone app the moment it is scanned. Present the same Chromium the way a headed one does,
 * with its own major version.
 */
export function chromeUserAgent(version: string): string {
  const major = version.split('.')[0] || '131';
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** The stored state, when it parses as one; anything else starts fresh. */
export function parseStorageState(
  json: StorageStateJson | undefined,
): BrowserContextOptions['storageState'] | undefined {
  if (!json) return undefined;
  try {
    const v = JSON.parse(json) as { cookies?: unknown; origins?: unknown };
    if (!v || typeof v !== 'object' || (!Array.isArray(v.cookies) && !Array.isArray(v.origins)))
      return undefined;
    return {
      cookies: Array.isArray(v.cookies) ? v.cookies : [],
      origins: Array.isArray(v.origins) ? v.origins : [],
    } as BrowserContextOptions['storageState'];
  } catch {
    return undefined;
  }
}

/**
 * The user Chromium runs as, apart from the worker (issue #139): set by `DODO_BROWSER_UID` /
 * `DODO_BROWSER_GID` in the browser image. The browser renders pages from any site the task
 * opens; as root, a renderer exploit would land next to the run's credential. Unset (tests, a
 * dev machine): Chromium runs as the worker, as before.
 */
export interface BrowserUser {
  uid: number;
  gid: number;
  home: string;
  /** Runs Chromium as `uid` (apps/worker/chromium-as-browser.sh). */
  wrapper: string;
}

export function browserUser(env: NodeJS.ProcessEnv = process.env): BrowserUser | undefined {
  if (!env.DODO_BROWSER_UID) return undefined;
  const uid = Number(env.DODO_BROWSER_UID);
  const gid = Number(env.DODO_BROWSER_GID ?? env.DODO_BROWSER_UID);
  if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid <= 0) {
    throw new Error('DODO_BROWSER_UID / DODO_BROWSER_GID must be positive integers');
  }
  if (process.getuid?.() !== 0) {
    throw new Error('DODO_BROWSER_UID is set but the worker is not running as root');
  }
  return {
    uid,
    gid,
    home: env.DODO_BROWSER_HOME ?? '/home/browser',
    wrapper: env.DODO_BROWSER_WRAPPER ?? '/usr/local/bin/chromium-as-browser',
  };
}

/**
 * The headless shell Playwright would launch on its own (`headless: true`), found in the browsers
 * folder; the full Chromium when there is none.
 */
export function headlessShellPath(browsersPath: string | undefined, fallback: string): string {
  if (!browsersPath || !existsSync(browsersPath)) return fallback;
  for (const d of readdirSync(browsersPath).sort().reverse()) {
    if (!d.startsWith('chromium_headless_shell-')) continue;
    for (const sub of readdirSync(path.join(browsersPath, d))) {
      for (const bin of ['chrome-headless-shell', 'headless_shell']) {
        const p = path.join(browsersPath, d, sub, bin);
        if (existsSync(p)) return p;
      }
    }
  }
  return fallback;
}

/**
 * Only what Chromium needs. Playwright otherwise hands the browser the worker's whole
 * environment, the run's credential included.
 */
export function browserEnv(
  user: BrowserUser,
  chromium: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {
    PATH: env.PATH ?? '/usr/bin:/bin',
    HOME: user.home,
    LANG: env.LANG ?? 'C.UTF-8',
    DODO_CHROMIUM: chromium,
    DODO_BROWSER_UID: String(user.uid),
    DODO_BROWSER_GID: String(user.gid),
  };
  for (const k of [
    'TZ',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
  ]) {
    const v = env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export async function startHeadlessBrowser(opts: {
  outputDir: string;
  /** The task's logins from an earlier run, as the control plane handed them back. */
  storageState?: StorageStateJson;
  log: (message: string) => void;
}): Promise<HeadlessBrowser> {
  mkdirSync(opts.outputDir, { recursive: true, mode: 0o700 });
  const { chromium } = await import('playwright');
  const { createConnection } = (await import('@playwright/mcp')) as {
    createConnection: typeof CreateConnection;
  };

  const user = browserUser();
  let asUser:
    | { executablePath: string; downloadsPath: string; env: Record<string, string> }
    | undefined;
  if (user) {
    // Downloads are written by Chromium itself, so into a folder the browser user owns.
    const downloadsPath = `${opts.outputDir}-downloads`;
    mkdirSync(downloadsPath, { recursive: true, mode: 0o700 });
    chownSync(downloadsPath, user.uid, user.gid);
    const real = headlessShellPath(process.env.PLAYWRIGHT_BROWSERS_PATH, chromium.executablePath());
    asUser = { executablePath: user.wrapper, downloadsPath, env: browserEnv(user, real) };
  }
  const launch = (sandbox: boolean) =>
    chromium.launch({
      headless: true,
      chromiumSandbox: sandbox,
      // Without this Chromium tells every page it is automated (navigator.webdriver), and login
      // providers such as itsme refuse the session.
      args: ['--disable-blink-features=AutomationControlled'],
      ...asUser,
    });
  let browser: Awaited<ReturnType<typeof launch>>;
  if (user) {
    // As its own user, Chromium's sandbox works where the kernel lets it make a user namespace.
    // Where it can't, the browser still runs, as that user, and the log says so.
    browser = await launch(true).catch(async (err: Error) => {
      opts.log(
        `browser: Chromium sandbox unavailable, running without it: ${err.message.split('\n')[0]}`,
      );
      return launch(false);
    });
  } else {
    // A dev machine or a test as root: no separate user, no sandbox (it refuses to run as root).
    browser = await launch(false);
  }
  const restored = parseStorageState(opts.storageState);
  if (opts.storageState && !restored) opts.log('browser: stored logins unreadable; starting fresh');
  const context = await browser.newContext({
    userAgent: chromeUserAgent(browser.version()),
    viewport: { width: 1280, height: 900 },
    ...(restored ? { storageState: restored } : {}),
  });
  if (restored) opts.log('browser: logins from an earlier run restored');

  const server = await createConnection(
    {
      // Screenshots come back as images so ask_user can show them to the user; the model
      // only ever gets the text parts.
      imageResponses: 'allow',
      outputDir: opts.outputDir,
    },
    async () => context,
  );
  const client = await connectMcpServer(server);

  let stopped = false;
  return {
    client,
    async storageState() {
      return JSON.stringify(await context.storageState());
    },
    async addState(json) {
      const state = parseStorageState(json) as
        | { cookies: Parameters<typeof context.addCookies>[0] }
        | undefined;
      if (!state?.cookies.length) return false;
      await context.addCookies(state.cookies);
      return true;
    },
    lastUrl() {
      const urls = context
        .pages()
        .map((p) => p.url())
        .filter((u) => /^https?:/.test(u));
      return urls.at(-1);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    },
  };
}
