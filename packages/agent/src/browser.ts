import {
  type EmailCodeRequest,
  type EmailCodeResponse,
  emailCodeId,
  hasSecretRefs,
  type ImageUpload,
  sameSite,
  siteOf,
} from '@dodo/core';
import { z } from 'zod';
import { connectMcp } from './mcp.js';
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
  ): Promise<{ text: string; isError: boolean; images?: ImageUpload[] }>;
  close(): Promise<void>;
}

/** Decoded size cap for a screenshot sent with a question (Telegram takes photos up to 10 MB). */
const MAX_IMAGE_BYTES = 6_000_000;

/**
 * A screenshot of the page the agent is on, or of one element (by its snapshot ref), for
 * ask_user. Only the user sees it: it never goes back to the model.
 */
export async function takeScreenshot(
  client: BrowserClient,
  target?: { element: string; ref: string },
): Promise<ImageUpload | undefined> {
  const res = await client.callTool('browser_take_screenshot', {
    type: 'png',
    ...(target ? { element: target.element, ref: target.ref } : {}),
  });
  if (res.isError) return undefined;
  return res.images?.find(
    (i) =>
      ['image/png', 'image/jpeg', 'image/webp'].includes(i.mimeType) &&
      (i.data.length * 3) / 4 <= MAX_IMAGE_BYTES,
  );
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
export async function browserTools(
  client: BrowserClient,
  opts: {
    emailCode?: EmailCodeFetch;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<ToolDef[]> {
  const available = new Map((await client.listTools()).map((t) => [t.name, t]));
  const now = opts.now ?? Date.now;
  let currentHost = '';
  let tainted = false;
  /** When the agent last did something on the page (a click that may have sent a code). */
  let lastActionAt: number | undefined;
  const tools: ToolDef[] = [];
  /** The page's answer to a call: follows the host, cuts and redacts the text. */
  const afterCall = (
    name: string,
    res: { text: string; isError: boolean },
    ctx: ToolContext,
  ): Record<string, unknown> => {
    const url = pageUrlIn(res.text);
    if (url) {
      const host = hostOf(url);
      if (name === 'browser_navigate' || host !== currentHost) tainted = false;
      currentHost = host;
    }
    let text = res.text.length > MAX_RESULT ? `${res.text.slice(0, MAX_RESULT)}\n…(cut)` : res.text;
    if (ctx.secrets) text = ctx.secrets.redact(text);
    return res.isError ? { error: text } : { text };
  };
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
          // A page that just got a vault value may not run arbitrary JavaScript: it could read
          // the field back. Opening another page clears it.
          if (name === 'browser_evaluate' && tainted) {
            return {
              result: {
                error:
                  'JavaScript is disabled on this page because a vault value was typed into it. Navigate first.',
              },
            };
          }
          let callArgs = args;
          if (name === 'browser_type' || name === 'browser_fill_form') {
            const resolved = await resolveVault(name, args, currentHost, ctx);
            if ('error' in resolved) return { result: { error: resolved.error } };
            if (resolved.injected) tainted = true;
            callArgs = resolved.args;
          }
          if (ACTIONS.has(name)) lastActionAt = now();
          const res = await client.callTool(name, callArgs);
          return { result: afterCall(name, res, ctx) };
        },
      }),
    );
  }
  if (opts.emailCode && available.has('browser_type'))
    tools.push(
      emailCodeTool({
        fetch: opts.emailCode,
        host: () => currentHost,
        since: () => lastActionAt,
        now,
        sleep: opts.sleep,
        async type(args, ctx) {
          tainted = true;
          lastActionAt = now();
          return afterCall('browser_type', await client.callTool('browser_type', args), ctx);
        },
      }),
    );
  return tools;
}

/** Calls that may make a site send a code (or a new one). */
const ACTIONS = new Set([
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_press_key',
  'browser_select_option',
]);

/** The control plane's lookup of an emailed code (`runEmailCode`). */
export type EmailCodeFetch = (req: Omit<EmailCodeRequest, 'runId'>) => Promise<EmailCodeResponse>;

const POLL_MS = 5_000;
/** Mail older than this before the agent's last action on the page is not the new code. */
const SLACK_MS = 60_000;
/** Without a recent action (a new run), how far back a code may be. */
const LOOKBACK_MS = 10 * 60_000;

/**
 * Sign-in codes a site emails the user, without asking them: waits for the mail in their Gmail
 * (through the control plane), keeps the code in the run's secrets under `{{answer:mail-…}}`
 * for this site only, and types it into the field when given one. The model sees the mail's
 * sender and subject, never the code. A sender other than the page's own site asks first, so a
 * page cannot have another site's code typed into it.
 */
export function emailCodeTool(page: {
  fetch: EmailCodeFetch;
  host: () => string;
  since: () => number | undefined;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  type: (args: Record<string, unknown>, ctx: ToolContext) => Promise<Record<string, unknown>>;
}): ToolDef {
  const now = page.now ?? Date.now;
  const sleep = page.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const used: string[] = [];
  return define({
    name: 'get_email_code',
    description:
      "Get a one-time sign-in or verification code that the site you are on has just emailed to the user, straight from their mailbox, instead of asking them. Call it as soon as the page says it sent a code by email. It waits for the mail (up to wait_seconds), and with ref it types the code into that field itself; without ref it returns a reference to type with browser_type. You never see the code. A code already used in this run is skipped, so after 'resend code' call it again for the new one.",
    schema: z.object({
      element: z
        .string()
        .max(300)
        .optional()
        .describe('The code field, as a human-readable description (as for browser_type).'),
      ref: z
        .string()
        .max(100)
        .optional()
        .describe(
          'The code field (the first box when the code goes into one box per digit) from the page snapshot; the code is typed into it.',
        ),
      sender: z
        .string()
        .max(253)
        .optional()
        .describe(
          'Only when the mail comes from another domain than the page (login.live.com mails from microsoft.com): that domain. Asks the user first.',
        ),
      wait_seconds: z.number().int().min(0).max(180).default(90),
    }),
    policy: ({ sender }) => {
      const host = page.host();
      return sender && !sameSite(sender, host)
        ? { tool: 'EmailCode', key: `${siteOf(sender)}>${siteOf(host)}`, category: 'outbound' }
        : { tool: 'EmailCode', key: siteOf(host), category: 'sandbox' };
    },
    async execute({ element, ref, sender, wait_seconds }, ctx) {
      const host = page.host();
      if (!host) return { result: { error: 'Open the page that asks for the code first.' } };
      if (!ctx.secrets) return { result: { error: 'Codes cannot be typed in this run.' } };
      const started = now();
      const action = page.since();
      const since = action !== undefined ? action - SLACK_MS : started - LOOKBACK_MS;
      const from = siteOf(sender ?? host);
      for (;;) {
        const r = await page.fetch({ host, sender, since, exclude: [...used] });
        if (r.found) {
          used.push(r.id);
          const reference = ctx.secrets.hold(emailCodeId(r.id), r.code, siteOf(host));
          const mail = {
            from: r.from,
            subject: r.subject,
            receivedSecondsAgo: Math.max(0, Math.round((now() - r.receivedAt) / 1000)),
          };
          if (!ref) {
            return {
              result: {
                ok: true,
                reference,
                mail,
                note: `Type it with browser_type, text ${reference} (slowly: true when the code goes into one box per digit).`,
              },
            };
          }
          const typed = await page.type(
            { element: element ?? 'code field', ref, text: r.code, slowly: true },
            ctx,
          );
          return {
            result: {
              ...(typed.error ? { error: typed.error } : { ok: true, typed: reference }),
              mail,
              ...(typed.text ? { text: typed.text } : {}),
            },
          };
        }
        if (r.error) return { result: { error: r.error } };
        if (now() - started >= wait_seconds * 1000)
          return {
            result: {
              error: `No mail with a code from ${from} arrived within ${wait_seconds} s. Check that the page really sent one (or press its resend link) and call again; if the code goes to another address than the user's Gmail, ask the user with ask_user (secret: true).`,
            },
          };
        await sleep(POLL_MS);
      }
    },
  }) as ToolDef;
}

/**
 * Replaces `{{vault:…}}` references in what a type or fill-form call types with the values,
 * for the site the agent is on. The model's arguments (and so the trace) keep the references;
 * only the call to the browser gets the values.
 */
export async function resolveVault(
  name: string,
  args: Record<string, unknown>,
  host: string,
  ctx: ToolContext,
): Promise<{ args: Record<string, unknown>; injected: boolean } | { error: string }> {
  const texts =
    name === 'browser_type'
      ? [String(args.text ?? '')]
      : Array.isArray(args.fields)
        ? (args.fields as Array<Record<string, unknown>>).map((f) => String(f?.value ?? ''))
        : [];
  if (!texts.some(hasSecretRefs)) return { args, injected: false };
  if (!ctx.secrets) return { error: 'The vault is not available in this run.' };
  if (!host) return { error: 'Open the login page first; vault values are typed per site.' };
  try {
    const secrets = ctx.secrets;
    if (name === 'browser_type') {
      return {
        args: { ...args, text: await secrets.resolve(String(args.text ?? ''), host) },
        injected: true,
      };
    }
    const fields = await Promise.all(
      (args.fields as Array<Record<string, unknown>>).map(async (f) =>
        typeof f?.value === 'string' && hasSecretRefs(f.value)
          ? { ...f, value: await secrets.resolve(f.value, host) }
          : f,
      ),
    );
    return { args: { ...args, fields }, injected: true };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** Connect to a Playwright MCP server over streamable HTTP; the worker calls this once per run. */
export async function connectBrowser(url: string): Promise<BrowserClient> {
  return connectMcp(url);
}
