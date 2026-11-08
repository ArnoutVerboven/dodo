import { execFile } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Message, ToolSpec } from '../model.ts';
import { pruneSnapshots } from './mcp.ts';
import type { Driver, DriverOptions } from './types.ts';

/**
 * Vercel's agent-browser (Rust CLI over CDP), wrapped as tools the same way dodo would wrap
 * it. Every action returns the new page as `snapshot -i -c` (interactive elements only,
 * compact), and older snapshots are pruned like mcp-inline-pruned, so the difference to that
 * variant is agent-browser's page format and engine, not the loop.
 */

function binary(): string {
  const require = createRequire(import.meta.url);
  const dir = path.dirname(require.resolve('agent-browser/package.json'));
  const os = process.platform === 'win32' ? 'win32' : process.platform;
  const file = path.join(
    dir,
    'bin',
    `agent-browser-${os}-${process.arch}${os === 'win32' ? '.exe' : ''}`,
  );
  try {
    chmodSync(file, 0o755);
  } catch {}
  return file;
}

const ref = (r: unknown) => {
  const s = String(r ?? '').trim();
  return /^e\d+$/.test(s) ? `@${s}` : s;
};

const tool = (
  name: string,
  description: string,
  props: Record<string, unknown>,
  required: string[],
): ToolSpec => ({
  name,
  description,
  parameters: { type: 'object', properties: props, required },
});

const REF = { type: 'string', description: 'Element ref from the page snapshot, e.g. e12' };

export async function agentBrowserDriver(opts: DriverOptions): Promise<Driver> {
  const bin = binary();
  const session = `bench-${process.pid}-${Date.now().toString(36)}`;
  // Every command must carry the same launch options, or the daemon relaunches the browser.
  const base = [
    '--session',
    session,
    ...(opts.headed ? ['--headed'] : []),
    ...(opts.executablePath ? ['--executable-path', opts.executablePath] : []),
    ...(opts.noSandbox ? ['--args', '--no-sandbox'] : []),
  ];
  const run = (args: string[], timeoutMs = 45_000) =>
    new Promise<{ text: string; isError: boolean }>((resolve) => {
      execFile(
        bin,
        [...base, ...args],
        { timeout: timeoutMs, maxBuffer: 20_000_000 },
        (err, out, errOut) => {
          const text = `${out}${errOut ? `\n${errOut}` : ''}`.trim();
          resolve({
            text: text || (err ? String(err.message) : ''),
            isError: Boolean(err) || /^✗/m.test(text),
          });
        },
      );
    });
  const page = async () => {
    // Let a click or Enter that navigates finish first, as Playwright MCP does, or the
    // snapshot shows the old page and its refs go stale.
    await new Promise((r) => setTimeout(r, 300));
    await run(['wait', '--load', 'load'], 8_000);
    // One command at a time: two at once on a fresh session race to start its daemon.
    const url = await run(['get', 'url']);
    const snap = await run(['snapshot', '-i', '-c']);
    return `Page URL: ${url.text}\n\`\`\`yaml\n${snap.text}\n\`\`\``;
  };
  const act = async (args: string[]) => {
    const res = await run(args);
    return { text: `${res.text}\n${await page()}`, isError: res.isError };
  };

  const tools: ToolSpec[] = [
    tool('open', 'Open a URL in the browser. Returns the page.', { url: { type: 'string' } }, [
      'url',
    ]),
    tool('back', 'Go back to the previous page. Returns the page.', {}, []),
    tool('click', 'Click an element by its ref. Returns the page after the click.', { ref: REF }, [
      'ref',
    ]),
    tool(
      'fill',
      'Clear a text field and type text into it; set submit to press Enter afterwards. Returns the page.',
      { ref: REF, text: { type: 'string' }, submit: { type: 'boolean' } },
      ['ref', 'text'],
    ),
    tool(
      'press',
      'Press a key, e.g. Enter, Escape, Tab. Returns the page.',
      { key: { type: 'string' } },
      ['key'],
    ),
    tool(
      'select',
      'Pick an option in a dropdown by its visible label. Returns the page.',
      { ref: REF, value: { type: 'string' } },
      ['ref', 'value'],
    ),
    tool(
      'wait',
      'Wait a number of milliseconds for the page to settle. Returns the page.',
      { ms: { type: 'number' } },
      ['ms'],
    ),
  ];

  return {
    tools,
    async call(name, a) {
      switch (name) {
        case 'open':
          return act(['open', String(a.url ?? '')]);
        case 'back':
          return act(['back']);
        case 'click':
          return act(['click', ref(a.ref ?? a.target)]);
        case 'fill': {
          const res = await run(['fill', ref(a.ref ?? a.target), String(a.text ?? '')]);
          if (a.submit && !res.isError) await run(['press', 'Enter']);
          return { text: `${res.text}\n${await page()}`, isError: res.isError };
        }
        case 'press':
          return act(['press', String(a.key ?? 'Enter')]);
        case 'select':
          return act(['select', ref(a.ref), String(a.value ?? '')]);
        case 'wait':
          return act(['wait', String(Math.min(Number(a.ms) || 1000, 10_000))]);
        default:
          return { text: `Unknown tool ${name}`, isError: true };
      }
    },
    prune: (messages: Message[]) => pruneSnapshots(messages),
    async finalState() {
      const url = await run(['get', 'url']);
      const snap = await run(['snapshot']);
      return { url: url.text.trim(), text: snap.text };
    },
    async close() {
      await run(['close']);
    },
  };
}
