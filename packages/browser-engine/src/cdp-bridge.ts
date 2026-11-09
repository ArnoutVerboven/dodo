import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { type WebSocket, WebSocketServer } from 'ws';

/**
 * Chrome for agent-browser where other users share the machine (the cloud worker, where the
 * agent's own commands run as another user). agent-browser would launch Chrome with a DevTools
 * port on localhost, and anything on the machine that can reach localhost could then drive the
 * browser and read its cookies past every policy. Here the worker launches Chrome itself with
 * DevTools on a pipe only it holds, and hands agent-browser a WebSocket on localhost behind a
 * random path that only the worker knows (given to agent-browser in its environment, which
 * other users cannot read). One client at a time.
 *
 * The worker keeps a line of its own on the same pipe (`call`), for what agent-browser does
 * not do over CDP: restoring the task's logins at the start and adding cookies mid-run.
 */

const OWN_ID_BASE = 1_000_000_000;

export interface ChromeLaunch {
  /** Chrome, or a wrapper that runs it as another user. */
  executablePath: string;
  args: string[];
  env: Record<string, string>;
}

export interface CdpBridge {
  /** For AGENT_BROWSER_CDP. Holds the secret path: never log it. */
  wsUrl: string;
  call(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  /** Events of the worker's own sessions. */
  onEvent(fn: (method: string, params: Record<string, unknown>, sessionId?: string) => void): void;
  exited(): boolean;
  close(): Promise<void>;
}

export async function launchChromeBridge(launch: ChromeLaunch): Promise<CdpBridge> {
  const child: ChildProcess = spawn(
    launch.executablePath,
    [...launch.args, '--remote-debugging-pipe'],
    { env: launch.env, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr?.on('data', (c: Buffer) => {
    if (stderr.length < 8000) stderr += c.toString('utf8');
  });
  const toChrome = child.stdio[3] as Writable;
  const fromChrome = child.stdio[4] as Readable;
  toChrome.on('error', () => {});

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const ownSessions = new Set<string>();
  const listeners: Array<(m: string, p: Record<string, unknown>, s?: string) => void> = [];
  let nextId = OWN_ID_BASE;
  let client: WebSocket | undefined;
  let gone = false;

  const send = (msg: string) => {
    if (!gone) toChrome.write(`${msg}\0`);
  };
  let buf = '';
  fromChrome.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    for (let i = buf.indexOf('\0'); i >= 0; i = buf.indexOf('\0')) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let msg: {
        id?: number;
        sessionId?: string;
        method?: string;
        params?: unknown;
        error?: { message?: string };
        result?: unknown;
      };
      try {
        msg = JSON.parse(raw);
      } catch {
        continue;
      }
      if (typeof msg.id === 'number' && msg.id >= OWN_ID_BASE) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(msg.error.message ?? 'CDP error'));
        else p?.resolve(msg.result);
        continue;
      }
      if (msg.method && msg.sessionId && ownSessions.has(msg.sessionId)) {
        for (const l of listeners)
          l(msg.method, (msg.params ?? {}) as Record<string, unknown>, msg.sessionId);
        continue;
      }
      if (msg.method === 'Target.detachedFromTarget') {
        const sid = (msg.params as { sessionId?: string } | undefined)?.sessionId;
        if (sid && ownSessions.delete(sid)) continue;
      }
      client?.send(raw);
    }
  });

  const exit = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.once('exit', () => {
    gone = true;
    for (const p of pending.values()) p.reject(new Error('the browser exited'));
    pending.clear();
    client?.close();
  });

  const call = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<unknown>((resolve, reject) => {
      if (gone) return reject(new Error('the browser exited'));
      const id = nextId++;
      pending.set(id, {
        resolve: (v) => {
          if (method === 'Target.attachToTarget') {
            const sid = (v as { sessionId?: string }).sessionId;
            if (sid) ownSessions.add(sid);
          }
          resolve(v);
        },
        reject,
      });
      send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  // Chrome is up when it answers on the pipe; one that cannot start (no sandbox) exits first.
  const ready = await Promise.race([
    call('Browser.getVersion').then(
      () => true,
      () => false,
    ),
    exit.then(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(false), 20_000)),
  ]);
  if (!ready) {
    child.kill('SIGKILL');
    throw new Error(
      `Chromium did not start: ${stderr.trim().split('\n').slice(-3).join(' ') || 'no answer'}`,
    );
  }

  const secret = randomBytes(24).toString('hex');
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });
  const http: HttpServer = createServer((_req, res) => res.writeHead(404).end());
  http.on('upgrade', (req, socket, head) => {
    if (req.url !== `/${secret}` || client || gone) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      client = ws;
      ws.on('message', (data) => send(data.toString()));
      ws.on('close', () => {
        if (client === ws) client = undefined;
      });
      ws.on('error', () => {});
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as AddressInfo).port;

  return {
    wsUrl: `ws://127.0.0.1:${port}/${secret}`,
    call,
    onEvent: (fn) => listeners.push(fn),
    exited: () => gone,
    async close() {
      client?.close();
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      if (!gone) {
        child.kill('SIGTERM');
        const t = setTimeout(() => child.kill('SIGKILL'), 3000);
        await exit;
        clearTimeout(t);
      }
    },
  };
}

/** Playwright's storageState shape. */
export interface StorageState {
  cookies: Array<Record<string, unknown>>;
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}

/** Playwright cookies as CDP's Network.CookieParam. */
export function cdpCookies(cookies: Array<Record<string, unknown>>) {
  return cookies
    .filter((c) => typeof c.name === 'string' && typeof c.value === 'string')
    .map((c) => {
      const expires = Number(c.expires);
      const sameSite =
        c.sameSite === 'Strict' || c.sameSite === 'Lax' || c.sameSite === 'None'
          ? c.sameSite
          : undefined;
      return {
        name: c.name,
        value: c.value,
        ...(typeof c.domain === 'string' ? { domain: c.domain } : {}),
        ...(typeof c.path === 'string' ? { path: c.path } : {}),
        ...(Number.isFinite(expires) && expires > 0 ? { expires } : {}),
        ...(c.httpOnly ? { httpOnly: true } : {}),
        ...(c.secure ? { secure: true } : {}),
        ...(sameSite ? { sameSite } : {}),
      };
    });
}

/**
 * Restores a storageState into a fresh browser: cookies straight away, local storage by opening
 * each origin in a hidden tab whose requests are answered with an empty page (nothing goes to
 * the site), the way Playwright does it.
 */
export async function restoreState(bridge: CdpBridge, state: StorageState): Promise<void> {
  const cookies = cdpCookies(state.cookies);
  if (cookies.length) await bridge.call('Storage.setCookies', { cookies });
  const origins = state.origins.filter(
    (o) => /^https?:\/\//.test(o.origin) && o.localStorage?.length,
  );
  if (!origins.length) return;
  const { targetId } = (await bridge.call('Target.createTarget', { url: 'about:blank' })) as {
    targetId: string;
  };
  try {
    const { sessionId } = (await bridge.call('Target.attachToTarget', {
      targetId,
      flatten: true,
    })) as {
      sessionId: string;
    };
    bridge.onEvent((method, params, sid) => {
      if (sid !== sessionId || method !== 'Fetch.requestPaused') return;
      void bridge
        .call(
          'Fetch.fulfillRequest',
          {
            requestId: params.requestId,
            responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
            body: '',
          },
          sessionId,
        )
        .catch(() => {});
    });
    await bridge.call('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sessionId);
    for (const o of origins) {
      await bridge.call('Page.navigate', { url: o.origin }, sessionId);
      await bridge.call(
        'Runtime.evaluate',
        {
          expression: `(() => { for (const [k, v] of ${JSON.stringify(o.localStorage.map((i) => [i.name, i.value]))}) localStorage.setItem(k, v); })()`,
          awaitPromise: false,
        },
        sessionId,
      );
    }
  } finally {
    await bridge.call('Target.closeTarget', { targetId }).catch(() => {});
  }
}

/** All cookies of the browser, as Playwright writes them. */
export async function browserCookies(bridge: CdpBridge): Promise<Array<Record<string, unknown>>> {
  const { cookies } = (await bridge.call('Storage.getCookies')) as {
    cookies: Array<Record<string, unknown>>;
  };
  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.session ? -1 : c.expires,
    httpOnly: Boolean(c.httpOnly),
    secure: Boolean(c.secure),
    sameSite: c.sameSite ?? 'Lax',
  }));
}
