import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CdpBridge, launchChromeBridge } from './cdp-bridge.js';
import { AgentBrowser } from './cli.js';
import { type LiveFrame, LiveScreen } from './live.js';

/**
 * The live view against real Chromium, the way the cloud worker runs it: agent-browser drives
 * the page over the bridge while the worker's own line streams it and replays a person's input.
 * Skipped where Playwright's Chromium is not installed.
 */
function findChromium(): string | undefined {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  if (!existsSync(root)) return undefined;
  for (const d of readdirSync(root).sort().reverse()) {
    for (const p of [
      path.join(root, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
      path.join(root, d, 'chrome-linux64', 'chrome'),
    ])
      if (existsSync(p)) return p;
  }
  return undefined;
}
const chromium = findChromium();

const PAGES: Record<string, string> = {
  '/': `<title>Check</title><body style="margin:0;font:16px sans-serif">
    <input id="code" style="position:absolute;left:20px;top:20px;width:200px;height:30px">
    <button id="go" style="position:absolute;left:20px;top:80px;width:120px;height:40px"
      onclick="document.title='clicked '+document.getElementById('code').value">Go</button>
    <iframe src="${'OTHER'}/box" style="position:absolute;left:20px;top:150px;width:300px;height:80px;border:0"></iframe>
    <div style="height:3000px"></div>
    <a id="pop" href="/popup" target="_blank" style="position:absolute;left:300px;top:20px">Popup</a></body>`,
  '/box': `<body style="margin:0"><input type="checkbox" id="cb" style="width:30px;height:30px;margin:10px"
    onchange="parent.postMessage('cb:'+event.isTrusted,'*')"></body>`,
  '/popup': '<title>Popup</title><h1>Sign in</h1>',
};

const until = async (check: () => boolean | Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

describe.skipIf(!chromium)('live view (cloud bridge)', () => {
  let site: Server;
  let other: Server;
  let base: string;
  let bridge: CdpBridge;
  let ab: AgentBrowser;
  let dir: string;
  let live: LiveScreen;
  const frames: LiveFrame[] = [];
  const evalText = async (js: string) => {
    const r = await ab.one(['eval', js]);
    return String((r.data as { result?: unknown }).result ?? '');
  };

  beforeAll(async () => {
    other = createServer((req, res) =>
      res.writeHead(200, { 'content-type': 'text/html' }).end(PAGES[req.url ?? ''] ?? ''),
    );
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    const otherBase = `http://localhost:${(other.address() as AddressInfo).port}`;
    site = createServer((req, res) =>
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end((PAGES[req.url ?? '/'] ?? '').replace('OTHER', otherBase)),
    );
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    dir = mkdtempSync(path.join(os.tmpdir(), 'dodo-live-'));
    bridge = await launchChromeBridge({
      executablePath: chromium as string,
      args: [
        '--headless',
        '--no-sandbox',
        `--user-data-dir=${path.join(dir, 'profile')}`,
        '--window-size=800,600',
        'about:blank',
      ],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir },
    });
    ab = new AgentBrowser({
      session: `live${process.pid}`,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: dir,
        AGENT_BROWSER_SOCKET_DIR: path.join(dir, 'sock'),
        AGENT_BROWSER_CDP: bridge.wsUrl,
        AGENT_BROWSER_NO_VERSION_CHECK: '1',
      },
    });
    await ab.start();
    await ab.one(['open', `${base}/`]);
    await ab.one([
      'eval',
      "window.addEventListener('message', e => { document.body.dataset.msg = e.data })",
    ]);
    live = new LiveScreen(bridge, {
      onFrame: (f) => frames.push(f),
      preferUrl: () => `${base}/`,
      watchMs: 200,
    });
  }, 60_000);

  afterAll(async () => {
    await live?.stop();
    await ab?.one(['close']).catch(() => {});
    await bridge?.close();
    site?.close();
    other?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('shows the agent’s page at once, as JPEG frames with the viewport size', async () => {
    await live.start();
    expect(live.active).toBe(true);
    expect(await until(() => frames.length > 0)).toBe(true);
    const f = frames[0] as LiveFrame;
    expect(f.jpeg.subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(f.width).toBeGreaterThan(100);
    expect(f.height).toBeGreaterThan(100);
    expect(f.url).toBe(`${base}/`);
  });

  it('replays clicks and typing as real input', async () => {
    await live.input({ type: 'click', x: 100, y: 35 });
    await live.input({ type: 'text', text: '4821' });
    await live.input({ type: 'click', x: 60, y: 100 });
    expect(await until(async () => (await evalText('document.title')) === 'clicked 4821')).toBe(
      true,
    );
  });

  it('clicks into a cross-origin frame (a CAPTCHA box) as a trusted click', async () => {
    await live.input({ type: 'click', x: 45, y: 175 });
    expect(
      await until(async () => (await evalText('document.body.dataset.msg')) === 'cb:true'),
    ).toBe(true);
  });

  it('presses keys and scrolls', async () => {
    await live.input({ type: 'click', x: 100, y: 35 });
    await live.input({ type: 'key', key: 'Backspace' });
    expect(await until(async () => (await evalText('code.value')) === '482')).toBe(true);
    await live.input({ type: 'scroll', x: 200, y: 300, dy: 500 });
    expect(await until(async () => Number(await evalText('window.scrollY')) > 0)).toBe(true);
  });

  it('follows a sign-in popup to its new tab', async () => {
    await live.input({ type: 'scroll', x: 200, y: 300, dy: -5000 });
    await until(async () => Number(await evalText('window.scrollY')) === 0);
    await live.input({ type: 'click', x: 320, y: 28 });
    expect(await until(() => frames.at(-1)?.url === `${base}/popup`)).toBe(true);
  });

  it('stops and lets go of the page', async () => {
    await live.stop();
    expect(live.active).toBe(false);
    const n = frames.length;
    await new Promise((r) => setTimeout(r, 500));
    expect(frames.length).toBe(n);
    // agent-browser still drives the browser: the live view never took its session.
    expect((await ab.one(['eval', '1 + 1'])).ok).toBe(true);
    const still = await ab.one(['get', 'url']);
    expect(still.error).toBeUndefined();
    expect(still.ok).toBe(true);
  });
});
