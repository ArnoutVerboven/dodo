import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Message, ToolSpec } from '../model.ts';
import { CLOUD_ARGS, type Driver, type DriverOptions, INTERACTIVE } from './types.ts';

/**
 * Playwright MCP 0.0.83, the engine dodo uses today, in the ways the bench compares:
 *
 *   dodo-current      dodo's 16 tools as they are: an action returns no page, so the model
 *                     calls browser_snapshot to see what happened (two calls per step)
 *   mcp-inline        each action returns the new page snapshot inline (one call per step)
 *   mcp-inline-pruned as mcp-inline, and older snapshots in the history become one line
 *   mcp-interactive   as mcp-inline-pruned, showing only interactive elements and headings
 *   mcp-find          no page dumps: actions return the page's outline (headings, dialogs)
 *                     and the model searches the page with browser_find
 */
export type McpVariant =
  | 'dodo-current'
  | 'mcp-inline'
  | 'mcp-inline-pruned'
  | 'mcp-interactive'
  | 'mcp-find';

/** dodo's list (packages/agent/src/browser.ts BROWSER_TOOLS), in its order. */
const DODO_TOOLS = [
  'browser_navigate',
  'browser_navigate_back',
  'browser_snapshot',
  'browser_find',
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_press_key',
  'browser_select_option',
  'browser_hover',
  'browser_wait_for',
  'browser_tabs',
  'browser_handle_dialog',
  'browser_file_upload',
  'browser_evaluate',
  'browser_take_screenshot',
];
/** A lean set for the improved variants: what a navigation task needs. */
const LEAN_TOOLS = [
  'browser_navigate',
  'browser_navigate_back',
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_press_key',
  'browser_select_option',
  'browser_wait_for',
  'browser_tabs',
];
const LOOK = new Set([
  'browser_snapshot',
  'browser_find',
  'browser_take_screenshot',
  'browser_tabs',
]);
const MAX_RESULT = 20_000;
const STUB = '[older page snapshot removed]';

function mcpCli(): string {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');
}

export async function mcpDriver(variant: McpVariant, opts: DriverOptions): Promise<Driver> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  let config: string[] = [];
  if (opts.cloud) {
    const file = path.join(opts.workdir, 'mcp-config.json');
    writeFileSync(
      file,
      JSON.stringify({
        browser: {
          browserName: 'chromium',
          launchOptions: { headless: true, args: CLOUD_ARGS, chromiumSandbox: !opts.noSandbox },
          contextOptions: {
            userAgent: opts.cloud.userAgent,
            viewport: { width: 1280, height: 900 },
          },
        },
      }),
    );
    config = ['--config', file];
  }
  const args = [
    mcpCli(),
    ...config,
    '--isolated',
    '--output-dir',
    opts.workdir,
    '--viewport-size',
    '1280,900',
    ...(opts.headed && !opts.cloud ? [] : ['--headless']),
    ...(opts.executablePath && !opts.cloud ? ['--executable-path', opts.executablePath] : []),
    ...(opts.noSandbox ? ['--no-sandbox'] : []),
  ];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    stderr: 'ignore',
    cwd: opts.workdir,
    // The SDK passes only a few variables by default; keep PLAYWRIGHT_BROWSERS_PATH and the rest.
    env: Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
    ),
  });
  const client = new Client({ name: 'dodo-bench', version: '0.1.0' });
  await client.connect(transport);
  const listed = (await client.listTools()).tools;
  const byName = new Map(listed.map((t) => [t.name, t]));
  const wanted =
    variant === 'dodo-current'
      ? DODO_TOOLS
      : variant === 'mcp-find'
        ? [...LEAN_TOOLS, 'browser_find']
        : LEAN_TOOLS;
  const tools: ToolSpec[] = wanted
    .filter((n) => byName.has(n))
    .map((n) => {
      const t = byName.get(n);
      return {
        name: n,
        description: t?.description ?? n,
        parameters: (t?.inputSchema as Record<string, unknown>) ?? { type: 'object' },
      };
    });
  const code: string[] = [];

  const raw = async (name: string, a: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: a })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = (res.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');
    return { text, isError: Boolean(res.isError) };
  };

  /** The snapshot file an action's result links to, read back as YAML. */
  const linkedSnapshot = (text: string): string | undefined => {
    const m = /### Snapshot\n- \[[^\]]*\]\(([^)]+\.yml)\)|### Snapshot\n- (\S+\.yml)/.exec(text);
    const file = m?.[1] ?? m?.[2];
    if (!file) return undefined;
    try {
      return readFileSync(path.resolve(opts.workdir, file), 'utf8');
    } catch {
      return undefined;
    }
  };

  const shape = (name: string, text: string): string => {
    const ran = /### Ran Playwright code\n```js\n([\s\S]*?)```/.exec(text)?.[1];
    if (ran && !LOOK.has(name)) code.push(ran.trim());
    if (variant === 'dodo-current' || LOOK.has(name)) return text;
    const yaml = linkedSnapshot(text);
    if (!yaml) return text;
    const page =
      variant === 'mcp-interactive'
        ? interactiveOnly(yaml)
        : variant === 'mcp-find'
          ? outline(yaml)
          : yaml;
    const label =
      variant === 'mcp-find'
        ? '### Page outline (use browser_find to locate elements and their refs)'
        : '### Snapshot';
    return text.replace(/### Snapshot\n[^\n]*/, `${label}\n\`\`\`yaml\n${page}\n\`\`\``);
  };

  return {
    tools,
    async call(name, a) {
      if (!tools.some((t) => t.name === name))
        return { text: `Unknown tool ${name}`, isError: true };
      const res = await raw(name, a);
      let text = shape(name, res.text);
      if (text.length > MAX_RESULT) text = `${text.slice(0, MAX_RESULT)}\n…(cut)`;
      return { text, isError: res.isError };
    },
    prune:
      variant === 'mcp-inline-pruned' || variant === 'mcp-interactive' || variant === 'mcp-find'
        ? (messages: Message[]) => pruneSnapshots(messages)
        : undefined,
    recorded: () => [...code],
    async finalState() {
      const snap = await raw('browser_snapshot', {});
      const url = /- Page URL: (\S+)/.exec(snap.text)?.[1] ?? '';
      return { url, text: snap.text };
    },
    async close() {
      await client.close().catch(() => {});
    },
  };
}

/** Keep the latest page in full; older tool results lose their snapshot. */
export function pruneSnapshots(messages: Message[]): void {
  const isPage = (c: string) => /```yaml\n/.test(c) && /\[ref=/.test(c);
  let seenLatest = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'tool' || !isPage(m.content)) continue;
    if (!seenLatest) {
      seenLatest = true;
      continue;
    }
    m.content = m.content.replace(/```yaml\n[\s\S]*?```/g, STUB);
  }
}

/** Interactive elements and headings, with the text that names them. */
export function interactiveOnly(yaml: string): string {
  return yaml
    .split('\n')
    .filter((l) => INTERACTIVE.test(l))
    .map((l) => l.replace(/^(\s*)/, (s) => ' '.repeat(Math.min(s.length, 8))))
    .join('\n');
}

/** Headings and dialogs only: the shape of the page, no elements to act on. */
export function outline(yaml: string): string {
  const lines = yaml
    .split('\n')
    .filter((l) =>
      /^\s*- (heading|dialog|alertdialog|alert|main|navigation|banner|form|search)\b/.test(l),
    );
  return lines.length ? lines.join('\n') : '(no headings)';
}
