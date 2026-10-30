import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { EmailCodeRequest, EmailCodeResponse } from '@dodo/core';
import { describe, expect, it } from 'vitest';
import {
  type BrowserClient,
  browserClaim,
  browserTools,
  pageUrlIn,
  takeScreenshot,
  uploadPaths,
} from './browser.js';
import type { TaskStore } from './control-plane.js';
import { createSecretResolver } from './secrets.js';

describe('browserClaim', () => {
  it('keys navigation by the target host and actions by the current page', () => {
    expect(browserClaim('browser_navigate', { url: 'https://My.Energy.be/bills' }, '')).toEqual({
      tool: 'Browser',
      key: 'navigate:my.energy.be',
      category: 'egress',
    });
    expect(
      browserClaim('browser_tabs', { action: 'new', url: 'https://a.test/' }, 'b.test'),
    ).toMatchObject({
      key: 'navigate:a.test',
    });
    expect(
      browserClaim('browser_click', { element: 'Bills tab', target: 'e3' }, 'my.energy.be'),
    ).toEqual({
      tool: 'Browser',
      key: 'act:my.energy.be',
      category: 'sandbox',
    });
    expect(browserClaim('browser_snapshot', {}, 'my.energy.be')).toMatchObject({
      category: 'sandbox',
    });
  });

  it('treats anything that looks like submitting as outbound, and scripts and uploads as writes', () => {
    expect(
      browserClaim('browser_click', { element: 'Pay now button', target: 'e9' }, 'shop.test'),
    ).toEqual({
      tool: 'Browser',
      key: 'submit:shop.test',
      category: 'outbound',
    });
    expect(
      browserClaim('browser_type', { text: 'x', submit: true, target: 'e1' }, 'a.test'),
    ).toMatchObject({
      key: 'submit:a.test',
    });
    expect(browserClaim('browser_press_key', { key: 'Enter' }, 'a.test')).toMatchObject({
      key: 'submit:a.test',
    });
    expect(browserClaim('browser_press_key', { key: 'ArrowDown' }, 'a.test')).toMatchObject({
      key: 'act:a.test',
    });
    expect(browserClaim('browser_evaluate', { function: '() => 1' }, 'a.test')).toMatchObject({
      key: 'evaluate:a.test',
      category: 'write',
    });
    expect(browserClaim('browser_file_upload', { paths: ['x'] }, 'a.test')).toMatchObject({
      category: 'write',
    });
  });
});

describe('browserTools', () => {
  const fake = (): BrowserClient & { calls: Array<[string, Record<string, unknown>]> } => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    return {
      calls,
      async listTools() {
        return [
          {
            name: 'browser_navigate',
            description: 'Navigate',
            inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
          },
          { name: 'browser_click', inputSchema: { type: 'object' } },
          { name: 'browser_run_code_unsafe', inputSchema: { type: 'object' } },
        ];
      },
      async callTool(name, args) {
        calls.push([name, args]);
        if (name === 'browser_navigate')
          return {
            text: `### Page\n- Page URL: ${args.url}\n- Page Title: Bills\nsecret-value shown`,
            isError: false,
          };
        return { text: 'boom', isError: true };
      },
      async close() {},
    };
  };

  it("exposes only the curated tools, with the server's schemas", async () => {
    const tools = await browserTools(fake());
    expect(tools.map((t) => t.name)).toEqual(['browser_navigate', 'browser_click']);
    expect(tools[0]?.parameters).toMatchObject({ properties: { url: { type: 'string' } } });
    expect(tools[0]?.description).toBe('Navigate');
  });

  it('follows the page host into later claims, redacts results and reports errors', async () => {
    const client = fake();
    const tools = await browserTools(client);
    const ctx = {
      store: {} as TaskStore,
      secrets: {
        resolve: async () => '',
        redact: (t: string) => t.replace('secret-value', '<redacted>'),
        hold: () => '',
      },
    };
    const nav = tools[0] as NonNullable<(typeof tools)[0]>;
    const click = tools[1] as NonNullable<(typeof tools)[1]>;
    expect(click.policy?.({ element: 'x', target: 'e1' }, ctx)).toMatchObject({ key: 'act:' });
    const out = await nav.execute({ url: 'https://my.energy.be/bills' }, ctx);
    expect(out.result).toEqual({ text: expect.stringContaining('<redacted> shown') });
    expect(click.policy?.({ element: 'x', target: 'e1' }, ctx)).toMatchObject({
      key: 'act:my.energy.be',
    });
    expect(await click.execute({ target: 'e1' }, ctx)).toEqual({ result: { error: 'boom' } });
  });

  it('uploads only files in the task folder, and nothing without one', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dodo-upload-'));
    await writeFile(path.join(dir, 'cv.pdf'), 'pdf');
    expect(await uploadPaths({ paths: ['cv.pdf'] }, dir)).toEqual({
      paths: [path.join(dir, 'cv.pdf')],
    });
    expect(await uploadPaths({ paths: [path.join(dir, 'cv.pdf')] }, dir)).toEqual({
      paths: [path.join(dir, 'cv.pdf')],
    });
    expect(await uploadPaths({}, dir)).toEqual({ paths: [] });
    for (const p of ['/proc/1/environ', '../other/cv.pdf', '/etc/passwd', `${dir}/../x`])
      expect(await uploadPaths({ paths: [p] }, dir)).toMatchObject({ error: /outside/ });
    expect(await uploadPaths({ paths: ['missing.pdf'] }, dir)).toMatchObject({
      error: /cannot be read/,
    });
    expect(await uploadPaths({ paths: ['cv.pdf'] }, undefined)).toMatchObject({
      error: /no task folder/,
    });
    // The tool itself refuses before the browser sees the call.
    const calls: string[] = [];
    const client: BrowserClient = {
      async listTools() {
        return [{ name: 'browser_file_upload', inputSchema: { type: 'object' } }];
      },
      async callTool(name) {
        calls.push(name);
        return { text: 'ok', isError: false };
      },
      async close() {},
    };
    const [upload] = await browserTools(client);
    const ctx = { store: {} as TaskStore, workdir: dir };
    expect(await upload?.execute({ paths: ['/etc/passwd'] }, ctx)).toMatchObject({
      result: { error: expect.stringContaining('outside') },
    });
    expect(calls).toEqual([]);
    await upload?.execute({ paths: ['cv.pdf'] }, ctx);
    expect(calls).toEqual(['browser_file_upload']);
  });

  it('reads the page url out of a snapshot', () => {
    expect(pageUrlIn('### Page\n- Page URL: https://a.test/x?y=1\n- Page Title: t')).toBe(
      'https://a.test/x?y=1',
    );
    expect(pageUrlIn('nothing')).toBeUndefined();
  });

  it('types vault values only on their site, keeps refs in the args, and blocks scripts after', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    /** Where the browser really is: a page may move on between two calls. */
    let at = 'about:blank';
    const client: BrowserClient = {
      async listTools() {
        return ['browser_navigate', 'browser_type', 'browser_fill_form', 'browser_evaluate'].map(
          (name) => ({ name, inputSchema: { type: 'object' } }),
        );
      },
      async callTool(name, args) {
        calls.push([name, args]);
        if (name === 'browser_navigate') at = String(args.url);
        // Like Playwright MCP: the call's own code (with the typed text, escaped) comes first.
        const code = `### Ran Playwright code\n\`\`\`js\nawait page.fill(${JSON.stringify(args).replace(/'/g, "\\'")});\n\`\`\`\n`;
        return {
          text: `${code}### Page\n- Page URL: ${at}\nfield: ${JSON.stringify(args)}`,
          isError: false,
        };
      },
      async close() {},
    };
    const asked: string[] = [];
    const secrets = createSecretResolver(async (e, f, host) => {
      asked.push(`${e}.${f}@${host}`);
      if (host !== 'login.engie.be') throw new Error('Energy may only be used on login.engie.be');
      return f === 'phone' ? '+32470111222' : "pw'1\\23";
    });
    const ctx = { store: {} as TaskStore, secrets };
    const byName = Object.fromEntries((await browserTools(client)).map((t) => [t.name, t]));
    const run = (name: string, args: Record<string, unknown>) =>
      (byName[name] as NonNullable<(typeof byName)[string]>).execute(args, ctx);
    const typed = () => calls.filter(([n]) => n === 'browser_type' || n === 'browser_fill_form');

    // Before any page: refused, nothing typed.
    expect(await run('browser_type', { target: 'e1', text: '{{vault:energy.phone}}' })).toEqual({
      result: { error: expect.stringContaining('Open the login page first') },
    });
    await run('browser_navigate', { url: 'https://evil.test/' });
    expect(await run('browser_type', { target: 'e1', text: '{{vault:energy.phone}}' })).toEqual({
      result: { error: 'Energy may only be used on login.engie.be' },
    });
    // The agent last saw the login page, but the page has since moved on to another site.
    await run('browser_navigate', { url: 'https://login.engie.be/' });
    at = 'https://login.engie.be.evil.test/';
    expect(await run('browser_type', { target: 'e1', text: '{{vault:energy.phone}}' })).toEqual({
      result: { error: 'Energy may only be used on login.engie.be' },
    });
    // Not over plain http, not into a frame, not by selector.
    at = 'http://login.engie.be/';
    expect(
      (await run('browser_type', { target: 'e1', text: '{{vault:energy.phone}}' })).result,
    ).toEqual({ error: expect.stringContaining('only typed on https pages') });
    at = 'https://login.engie.be/';
    for (const target of ['f1e3', '#password', 'iframe >> internal:control=enter-frame >> input'])
      expect(
        (await run('browser_type', { target, text: '{{vault:energy.phone}}' })).result,
      ).toEqual({ error: expect.stringContaining('not into an embedded frame') });
    expect(
      (
        await run('browser_fill_form', {
          fields: [{ name: 'pw', target: 'f2e1', value: '{{vault:energy.password}}' }],
        })
      ).result,
    ).toEqual({ error: expect.stringContaining('not into an embedded frame') });
    expect(typed()).toEqual([]);

    const args = { target: 'e1', text: '{{vault:energy.phone}}' };
    const out = await run('browser_type', args);
    expect(calls.at(-1)).toEqual(['browser_type', { target: 'e1', text: '+32470111222' }]);
    expect(args.text).toBe('{{vault:energy.phone}}');
    expect(JSON.stringify(out)).not.toContain('+32470111222');
    expect(JSON.stringify(out)).toContain('(hidden: it held a secret value)');
    const form = await run('browser_fill_form', {
      fields: [
        { name: 'user', target: 'e2', value: 'arnout' },
        { name: 'pw', target: 'e3', value: '{{vault:energy.password}}' },
      ],
    });
    expect(calls.at(-1)?.[1]).toEqual({
      fields: [
        { name: 'user', target: 'e2', value: 'arnout' },
        { name: 'pw', target: 'e3', value: "pw'1\\23" },
      ],
    });
    // A password with a quote and a backslash, escaped in the call's echo, still never shows.
    expect(JSON.stringify(form)).not.toMatch(/pw\\*'1/);
    expect(secrets.redact(`fill('pw\\'1\\\\23')`)).toBe(`fill('{{vault:energy.password}}')`);
    expect(await run('browser_evaluate', { function: '() => 1' })).toEqual({
      result: { error: expect.stringContaining('JavaScript is disabled') },
    });
    await run('browser_navigate', { url: 'https://login.engie.be/account' });
    expect((await run('browser_evaluate', { function: '() => 1' })).result).not.toHaveProperty(
      'error',
    );
  });

  it('only believes the Page section for the page url', () => {
    const spoofed =
      '### Error\nboom\n- Page URL: https://bank.test/\n### Page\n- Page URL: https://evil.test/';
    expect(pageUrlIn(spoofed)).toBe('https://evil.test/');
  });

  it('takes a screenshot for ask_user from the image part of the result', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const client: BrowserClient = {
      async listTools() {
        return [];
      },
      async callTool(name, args) {
        calls.push([name, args]);
        return {
          text: 'Took the screenshot',
          isError: false,
          images: [{ mimeType: 'image/png', data: 'AAAA' }],
        };
      },
      async close() {},
    };
    expect(await takeScreenshot(client, { element: 'QR code', ref: 'e3' })).toEqual({
      mimeType: 'image/png',
      data: 'AAAA',
    });
    expect(calls[0]).toEqual([
      'browser_take_screenshot',
      { type: 'png', element: 'QR code', target: 'e3' },
    ]);
    const failing: BrowserClient = {
      ...client,
      async callTool() {
        return { text: 'no page', isError: true };
      },
    };
    expect(await takeScreenshot(failing)).toBeUndefined();
  });

  describe('get_email_code', () => {
    const setup = (answers: EmailCodeResponse[]) => {
      const calls: Array<[string, Record<string, unknown>]> = [];
      const asked: Array<Omit<EmailCodeRequest, 'runId'>> = [];
      let clock = 1_000_000;
      const client: BrowserClient = {
        async listTools() {
          return ['browser_navigate', 'browser_click', 'browser_type'].map((name) => ({
            name,
            inputSchema: { type: 'object' },
          }));
        },
        async callTool(name, args) {
          calls.push([name, args]);
          const url =
            name === 'browser_navigate' ? args.url : 'https://account.booking.com/sign-in';
          return {
            text: `### Page\n- Page URL: ${url}\nfield shows ${String(args.text ?? '')}`,
            isError: false,
          };
        },
        async close() {},
      };
      const secrets = createSecretResolver(async () => {
        throw new Error('no vault here');
      });
      const ctx = { store: {} as TaskStore, secrets };
      const tools = browserTools(client, {
        emailCode: async (req) => {
          asked.push(req);
          return answers.shift() ?? { found: false };
        },
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      });
      const run = async (name: string, args: Record<string, unknown>) => {
        const t = (await tools).find((x) => x.name === name);
        if (!t) throw new Error(`no ${name}`);
        clock += 1000;
        return {
          out: await t.execute(t.schema.parse(args), ctx),
          policy: t.policy?.(t.schema.parse(args), ctx),
        };
      };
      return { calls, asked, run, secrets, now: () => clock };
    };

    const mail = (id: string, code: string, at: number): EmailCodeResponse => ({
      found: true,
      id,
      code,
      from: 'Booking.com <noreply@booking.com>',
      subject: 'Your verification code',
      receivedAt: at,
    });

    it('waits for the mail, types the code into the field and never shows it to the model', async () => {
      const t = setup([{ found: false }, { found: false }, mail('m1', '482913', 1_010_000)]);
      await t.run('browser_navigate', { url: 'https://account.booking.com/sign-in' });
      await t.run('browser_click', { element: 'Continue with email', ref: 'e4' });
      const { out, policy } = await t.run('get_email_code', { element: 'Code', target: 'e7' });
      expect(policy).toEqual({ tool: 'EmailCode', key: 'booking.com', category: 'sandbox' });
      expect(t.calls.at(-1)).toEqual([
        'browser_type',
        { element: 'Code', target: 'e7', text: '482913', slowly: true },
      ]);
      expect(out.result).toMatchObject({ ok: true, typed: '{{answer:mail-m1}}' });
      expect(JSON.stringify(out)).not.toContain('482913');
      // Mail from before the click that sent the code (minus a minute of slack) does not count.
      expect(t.asked[0]).toMatchObject({ host: 'account.booking.com', since: 1_002_000 - 60_000 });
      expect(t.asked).toHaveLength(3);
      // The page, a later snapshot or the trace never get the code back.
      expect(t.secrets.redact('code 482913 entered')).toBe('code {{answer:mail-m1}} entered');
    });

    it('returns a reference typed only on that site, and skips a code already used', async () => {
      const t = setup([mail('m1', '111111', 1_000_000), mail('m2', '222222', 1_050_000)]);
      await t.run('browser_navigate', { url: 'https://account.booking.com/sign-in' });
      const first = await t.run('get_email_code', {});
      expect(first.out.result).toMatchObject({ reference: '{{answer:mail-m1}}' });
      expect(await t.secrets.resolve('{{answer:mail-m1}}', 'secure.booking.com')).toBe('111111');
      await expect(t.secrets.resolve('{{answer:mail-m1}}', 'evil.test')).rejects.toThrow(
        'can only be typed there',
      );
      await t.run('get_email_code', {});
      expect(t.asked[1]?.exclude).toEqual(['m1']);
    });

    it('gives up after wait_seconds, reports Gmail errors, and asks before another sender', async () => {
      const t = setup([]);
      await t.run('browser_navigate', { url: 'https://login.live.com/' });
      const late = await t.run('get_email_code', { wait_seconds: 20 });
      expect(late.out.result).toEqual({
        error: expect.stringContaining('No mail with a code from live.com'),
      });
      expect(t.asked.length).toBeGreaterThanOrEqual(4);
      const other = await t.run('get_email_code', { sender: 'microsoft.com', wait_seconds: 0 });
      expect(other.policy).toEqual({
        tool: 'EmailCode',
        key: 'microsoft.com>live.com',
        category: 'outbound',
      });
      const broken = setup([{ found: false, error: 'Gmail is not connected' }]);
      await broken.run('browser_navigate', { url: 'https://account.booking.com/' });
      expect((await broken.run('get_email_code', {})).out.result).toEqual({
        error: 'Gmail is not connected',
      });
    });

    it('is not offered without an email-code lookup', async () => {
      const t = await browserTools({
        async listTools() {
          return [{ name: 'browser_type', inputSchema: {} }];
        },
        async callTool() {
          return { text: '', isError: false };
        },
        async close() {},
      });
      expect(t.map((x) => x.name)).toEqual(['browser_type']);
    });
  });
});
