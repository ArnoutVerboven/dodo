import { describe, expect, it } from 'vitest';
import { type BrowserClient, browserClaim, browserTools, pageUrlIn } from './browser.js';
import type { TaskStore } from './control-plane.js';

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
});
