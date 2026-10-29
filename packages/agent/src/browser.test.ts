import { describe, expect, it } from 'vitest';
import {
  type BrowserClient,
  browserClaim,
  browserTools,
  pageUrlIn,
  takeScreenshot,
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

  it('reads the page url out of a snapshot', () => {
    expect(pageUrlIn('### Page\n- Page URL: https://a.test/x?y=1\n- Page Title: t')).toBe(
      'https://a.test/x?y=1',
    );
    expect(pageUrlIn('nothing')).toBeUndefined();
  });

  it('types vault values only on their site, keeps refs in the args, and blocks scripts after', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const client: BrowserClient = {
      async listTools() {
        return ['browser_navigate', 'browser_type', 'browser_fill_form', 'browser_evaluate'].map(
          (name) => ({ name, inputSchema: { type: 'object' } }),
        );
      },
      async callTool(name, args) {
        calls.push([name, args]);
        const url = name === 'browser_navigate' ? args.url : 'https://login.engie.be/';
        return { text: `- Page URL: ${url}\nfield: ${JSON.stringify(args)}`, isError: false };
      },
      async close() {},
    };
    const asked: string[] = [];
    const secrets = createSecretResolver(async (e, f, host) => {
      asked.push(`${e}.${f}@${host}`);
      if (host !== 'login.engie.be') throw new Error('Energy may only be used on login.engie.be');
      return f === 'phone' ? '+32470111222' : 'pw-123';
    });
    const ctx = { store: {} as TaskStore, secrets };
    const byName = Object.fromEntries((await browserTools(client)).map((t) => [t.name, t]));
    const run = (name: string, args: Record<string, unknown>) =>
      (byName[name] as NonNullable<(typeof byName)[string]>).execute(args, ctx);

    // Before any page: refused, nothing typed.
    expect(await run('browser_type', { target: 'e1', text: '{{vault:energy.phone}}' })).toEqual({
      result: { error: expect.stringContaining('Open the login page first') },
    });
    await run('browser_navigate', { url: 'https://evil.test/' });
    expect(await run('browser_type', { target: 'e1', text: '{{vault:energy.phone}}' })).toEqual({
      result: { error: 'Energy may only be used on login.engie.be' },
    });
    await run('browser_navigate', { url: 'https://login.engie.be/' });
    const args = { target: 'e1', text: '{{vault:energy.phone}}' };
    const typed = await run('browser_type', args);
    expect(calls.at(-1)).toEqual(['browser_type', { target: 'e1', text: '+32470111222' }]);
    expect(args.text).toBe('{{vault:energy.phone}}');
    expect(JSON.stringify(typed)).not.toContain('+32470111222');
    await run('browser_fill_form', {
      fields: [
        { name: 'user', value: 'arnout' },
        { name: 'pw', value: '{{vault:energy.password}}' },
      ],
    });
    expect(calls.at(-1)?.[1]).toEqual({
      fields: [
        { name: 'user', value: 'arnout' },
        { name: 'pw', value: 'pw-123' },
      ],
    });
    expect(await run('browser_evaluate', { function: '() => 1' })).toEqual({
      result: { error: expect.stringContaining('JavaScript is disabled') },
    });
    await run('browser_navigate', { url: 'https://login.engie.be/account' });
    expect((await run('browser_evaluate', { function: '() => 1' })).result).not.toHaveProperty(
      'error',
    );
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
      { type: 'png', element: 'QR code', ref: 'e3' },
    ]);
    const failing: BrowserClient = {
      ...client,
      async callTool() {
        return { text: 'no page', isError: true };
      },
    };
    expect(await takeScreenshot(failing)).toBeUndefined();
  });
});
