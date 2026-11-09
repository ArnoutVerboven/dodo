import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserCookies, type CdpBridge, launchChromeBridge, restoreState } from './cdp-bridge.js';
import { AgentBrowser } from './cli.js';
import { AgentBrowserTools } from './tools.js';

/**
 * The engine against real Chromium, the way the cloud worker runs it (Chrome on a pipe behind
 * the bridge). Runs where Playwright's Chromium is installed (PLAYWRIGHT_BROWSERS_PATH or
 * /opt/pw-browsers); skipped elsewhere.
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
  '/': `<title>Shop</title><h1>Shop</h1><p>Welcome to the shop, prices from €5.</p>
    <a href="/b">Next page</a>
    <label>Email <input id="em"></label>
    <label>Password <input id="pw" type="password"></label>
    <button onclick="document.title = confirm('Sure?') ? 'yes' : 'no'">Delete</button>
    <iframe srcdoc="<label>Code <input id=code></label>"></iframe>`,
  '/b': '<title>B</title><h1>Page B</h1>',
};

describe.skipIf(!chromium)('agent-browser engine (cloud bridge)', () => {
  let site: Server;
  let base: string;
  let bridge: CdpBridge;
  let ab: AgentBrowser;
  let tools: AgentBrowserTools;
  let dir: string;
  const text = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await tools.call(name, args);
    const t = r.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
    return { text: t, isError: r.isError === true, content: r.content };
  };
  const refOf = (snapshot: string, label: string) =>
    new RegExp(`"${label}\\s*"[^\\n]*\\bref=(f?\\d*e\\d+)`).exec(snapshot)?.[1];

  beforeAll(async () => {
    site = createServer((req, res) => {
      const body = PAGES[req.url ?? '/'];
      res
        .writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
        .end(body ?? 'no');
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    dir = mkdtempSync(path.join(os.tmpdir(), 'dodo-ab-'));
    bridge = await launchChromeBridge({
      executablePath: chromium as string,
      args: [
        '--headless',
        '--no-sandbox',
        `--user-data-dir=${path.join(dir, 'profile')}`,
        'about:blank',
      ],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir },
    });
    await restoreState(bridge, {
      cookies: [{ name: 'sess', value: 'abc', domain: '127.0.0.1', path: '/', expires: -1 }],
      origins: [{ origin: base, localStorage: [{ name: 'k', value: 'v' }] }],
    });
    ab = new AgentBrowser({
      session: `test${process.pid}`,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: dir,
        AGENT_BROWSER_SOCKET_DIR: path.join(dir, 'sock'),
        AGENT_BROWSER_CDP: bridge.wsUrl,
        AGENT_BROWSER_NO_VERSION_CHECK: '1',
      },
    });
    await ab.start();
    tools = new AgentBrowserTools(ab, { outputDir: path.join(dir, 'out') });
  }, 60_000);

  afterAll(async () => {
    await ab?.one(['close']).catch(() => {});
    await bridge?.close();
    site?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('navigates and answers with the page first, then the interactive elements', async () => {
    const r = await text('browser_navigate', { url: `${base}/` });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(
      /^### Page\n- Page URL: http:\/\/127\.0\.0\.1:\d+\/\n- Page Title: Shop/,
    );
    expect(r.text).toContain('link "Next page"');
    expect(r.text).not.toContain('Welcome to the shop');
    expect(tools.lastUrl()).toBe(`${base}/`);
  }, 30_000);

  it('restored the logins before the agent got the browser', async () => {
    const r = await text('browser_evaluate', {
      function: "() => document.cookie + '|' + localStorage.getItem('k')",
    });
    expect(r.text).toContain('sess=abc|v');
  }, 30_000);

  it('reads the whole page with browser_snapshot and searches it with browser_find', async () => {
    expect((await text('browser_snapshot')).text).toContain('Welcome to the shop');
    const found = await text('browser_find', { text: 'prices' });
    expect(found.text).toContain('1 match');
  }, 30_000);

  it('marks frame content and refuses its plain ref', async () => {
    const snap = (await text('browser_snapshot')).text;
    const code = refOf(snap, 'Code');
    expect(code).toMatch(/^f\d+e\d+$/);
    const plain = code?.replace(/^f\d+/, '') as string;
    const refused = await text('browser_type', { target: plain, text: '1' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('inside a frame');
    const typed = await text('browser_type', { target: code, text: '123456' });
    expect(typed.isError).toBe(false);
    expect(typed.text).toContain('### Result\nTyped into f');
  }, 30_000);

  it('types without echoing the text, values that look like flags included', async () => {
    const snap = (await text('browser_snapshot')).text;
    const r = await text('browser_type', { target: refOf(snap, 'Email'), text: '--headed s3cret' });
    expect(r.text).toContain('### Result\nTyped into');
    const v = await text('browser_evaluate', {
      function: "() => document.getElementById('em').value",
    });
    expect(v.text).toContain('--headed s3cret');
  }, 30_000);

  it('never shows what is in a password field', async () => {
    const snap = (await text('browser_snapshot')).text;
    const r = await text('browser_type', { target: refOf(snap, 'Password'), text: 'hunter22' });
    expect(r.isError).toBe(false);
    expect(r.text).not.toContain('hunter22');
    expect((await text('browser_snapshot')).text).not.toContain('hunter22');
  }, 30_000);

  it('stops at a confirm dialog until it is answered', async () => {
    const snap = (await text('browser_snapshot')).text;
    const r = await text('browser_click', { element: 'Delete', target: refOf(snap, 'Delete') });
    expect(r.text).toContain('### Modal state');
    const answered = await text('browser_handle_dialog', { accept: false });
    expect(answered.text).toContain('Page Title: no');
  }, 30_000);

  it('clicks through to another page and back', async () => {
    const snap = (await text('browser_snapshot')).text;
    const r = await text('browser_click', { target: refOf(snap, 'Next page') });
    expect(r.text).toContain('Page Title: B');
    const back = await text('browser_navigate_back');
    expect(back.text).toContain('Page Title:');
  }, 30_000);

  it('takes screenshots as images and lists tabs', async () => {
    const shot = await text('browser_take_screenshot');
    expect(shot.content.some((c) => c.type === 'image')).toBe(true);
    const tabs = await text('browser_tabs', { action: 'list' });
    expect(tabs.text).toContain('### Open tabs\n- 0: (current)');
  }, 30_000);

  it('reads the cookies back over the worker’s own line', async () => {
    const cookies = await browserCookies(bridge);
    expect(cookies.find((c) => c.name === 'sess')?.value).toBe('abc');
  }, 30_000);

  it('refuses a second client on the bridge and a wrong path', async () => {
    const { WebSocket } = await import('ws');
    const tryOpen = (url: string) =>
      new Promise<boolean>((resolve) => {
        const ws = new WebSocket(url);
        ws.on('open', () => {
          ws.close();
          resolve(true);
        });
        ws.on('error', () => resolve(false));
      });
    expect(await tryOpen(bridge.wsUrl.replace(/\/[^/]+$/, '/wrong'))).toBe(false);
    expect(await tryOpen(bridge.wsUrl)).toBe(false);
  }, 30_000);
});
