import { mkdirSync } from 'node:fs';
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

  // The container runs the worker as an unprivileged user without user namespaces.
  const browser = await chromium.launch({ headless: true, chromiumSandbox: false });
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
