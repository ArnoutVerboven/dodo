import { z } from 'zod';
import { define, type PolicyClaim, type ToolContext, type ToolDef } from './tools.js';

/**
 * The browser tools: a curated subset of Playwright MCP, reached over MCP at an endpoint the
 * worker is handed (on a Mac, the daemon's server attached to your own Chrome). Each call is
 * a policy decision first, keyed by what it does on which site:
 *
 *   Browser(navigate:host)   opening a site: egress, so allowed hosts and allow rules apply
 *   Browser(act:host)        reading the page, clicking, typing, filling: allowed on an open site
 *   Browser(submit:host)     a click, Enter or typed submit on something that reads like submit,
 *                            pay, order, confirm, send, delete or sign: outbound, always asks
 *   Browser(evaluate:host)   arbitrary JavaScript on the page: asks
 *   Browser(upload:host)     handing files to the page: asks
 *
 * Results are text (accessibility snapshots), cut to a fixed size; the page's URL in them keeps
 * the host the next claims are keyed by. The vault (#25) plugs in through the tool context's
 * redaction, so nothing a page echoes back reaches the model unfiltered.
 */

export interface BrowserTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface BrowserClient {
  listTools(): Promise<BrowserTool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

/** The MCP tools the agent gets, in the order the model sees them. */
export const BROWSER_TOOLS = [
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
] as const;

const SUBMIT =
  /\b(submit|pay|purchase|buy|order|checkout|confirm|send|post|publish|delete|remove|sign|accept|agree|transfer|book|apply)\b/i;
const MAX_RESULT = 20_000;

export const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
};

/** The page the MCP result says the agent is on, from its `- Page URL:` line. */
export function pageUrlIn(text: string): string | undefined {
  return /^- Page URL: (\S+)/m.exec(text)?.[1];
}

/** Which policy key a call gets, given the host the agent is on and the call's arguments. */
export function browserClaim(
  name: string,
  args: Record<string, unknown>,
  currentHost: string,
): PolicyClaim {
  const at = (action: string, host = currentHost): PolicyClaim => ({
    tool: 'Browser',
    key: `${action}:${host}`,
    category:
      action === 'navigate'
        ? 'egress'
        : action === 'submit'
          ? 'outbound'
          : action === 'act'
            ? 'sandbox'
            : 'write',
  });
  switch (name) {
    case 'browser_navigate':
      return at('navigate', hostOf(String(args.url ?? '')));
    case 'browser_tabs':
      return args.action === 'new' && args.url
        ? at('navigate', hostOf(String(args.url)))
        : at('act');
    case 'browser_click':
      return SUBMIT.test(String(args.element ?? '')) ? at('submit') : at('act');
    case 'browser_type':
      return args.submit === true ? at('submit') : at('act');
    case 'browser_press_key':
      return /^(Enter|NumpadEnter)$/i.test(String(args.key ?? '')) ? at('submit') : at('act');
    case 'browser_evaluate':
      return at('evaluate');
    case 'browser_file_upload':
      return at('upload');
    default:
      return at('act');
  }
}

/**
 * The tool definitions for one browser client. Schemas come from the MCP server itself, so the
 * model sees Playwright's own argument descriptions; validation of the arguments is the
 * server's, this side only checks for an object.
 */
export async function browserTools(client: BrowserClient): Promise<ToolDef[]> {
  const available = new Map((await client.listTools()).map((t) => [t.name, t]));
  let currentHost = '';
  const tools: ToolDef[] = [];
  for (const name of BROWSER_TOOLS) {
    const mcp = available.get(name);
    if (!mcp) continue;
    tools.push(
      define({
        name,
        description: mcp.description ?? name,
        schema: z.record(z.string(), z.unknown()),
        parameters: mcp.inputSchema,
        policy: (args) => browserClaim(name, args, currentHost),
        async execute(args, ctx: ToolContext) {
          const res = await client.callTool(name, args);
          const url = pageUrlIn(res.text);
          if (url) currentHost = hostOf(url);
          let text =
            res.text.length > MAX_RESULT ? `${res.text.slice(0, MAX_RESULT)}\n…(cut)` : res.text;
          if (ctx.secrets) text = ctx.secrets.redact(text);
          return { result: res.isError ? { error: text } : { text } };
        },
      }),
    );
  }
  return tools;
}

/** Connect to a Playwright MCP server over streamable HTTP; the worker calls this once per run. */
export async function connectBrowser(url: string): Promise<BrowserClient> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/streamableHttp.js'
  );
  const client = new Client({ name: 'dodo-worker', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return {
    async listTools() {
      const { tools } = await client.listTools();
      return tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>,
      }));
    },
    async callTool(name, args) {
      const res = (await client.callTool({ name, arguments: args })) as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      const text = (res.content ?? [])
        .map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type}]`))
        .join('\n');
      return { text, isError: res.isError === true };
    },
    async close() {
      await client.close().catch(() => {});
    },
  };
}
