import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { AgentBrowser, CommandResult } from './cli.js';
import { findInSnapshot, markFrames, toTarget } from './snapshot.js';

/**
 * dodo's browser tools on agent-browser, under Playwright MCP's names and arguments, so the
 * worker's policy keys, vault and email-code handling work the same on either engine. What
 * differs is what the model gets back: every action answers with the page it led to, showing
 * only the elements one can act on (agent-browser's `snapshot -i -c`), so a step is one call
 * and a small one. browser_snapshot and browser_find read the whole page when the text matters.
 *
 * A result opens with its `### Page` section, before anything the page could have written, so
 * the worker's reading of where the browser is cannot be spoofed by page text.
 */

export interface ToolResult {
  content: Array<
    { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
  >;
  isError?: boolean;
}

export interface ToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const ELEMENT = {
  type: 'string',
  description:
    'Human-readable element description used to obtain permission to interact with the element',
};
const TARGET = {
  type: 'string',
  description:
    'Exact target element reference from the page snapshot (e.g. e12, or f3e12 inside a frame)',
};
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});
const PAGE_NOTE = ' Returns the page afterwards: its URL, title and interactive elements.';

export const TOOLS: ToolInfo[] = [
  {
    name: 'browser_navigate',
    description: `Navigate to a URL.${PAGE_NOTE}`,
    inputSchema: obj({ url: { type: 'string', description: 'The URL to navigate to' } }, ['url']),
  },
  {
    name: 'browser_navigate_back',
    description: `Go back to the previous page in the history.${PAGE_NOTE}`,
    inputSchema: obj({}),
  },
  {
    name: 'browser_snapshot',
    description:
      'The whole current page with its text (headings, paragraphs, prices, messages) and element refs. Actions already return the interactive elements; use this when you need to read the page.',
    inputSchema: obj({}),
  },
  {
    name: 'browser_find',
    description:
      'Search the whole current page (text and elements) for text or a regular expression. Returns the matching lines with their refs and a little context.',
    inputSchema: obj({
      text: { type: 'string', description: 'Plain text to search for (case-insensitive).' },
      regex: {
        type: 'string',
        description: 'Regular expression; wrap in slashes to add flags, e.g. "/error/i".',
      },
    }),
  },
  {
    name: 'browser_click',
    description: `Click an element.${PAGE_NOTE}`,
    inputSchema: obj(
      {
        element: ELEMENT,
        target: TARGET,
        doubleClick: { type: 'boolean', description: 'Double click instead of a single click' },
      },
      ['target'],
    ),
  },
  {
    name: 'browser_type',
    description: `Type text into an editable element (replacing what is there, unless slowly).${PAGE_NOTE}`,
    inputSchema: obj(
      {
        element: ELEMENT,
        target: TARGET,
        text: { type: 'string', description: 'Text to type into the element' },
        submit: { type: 'boolean', description: 'Press Enter afterwards' },
        slowly: {
          type: 'boolean',
          description:
            'Type one character at a time, after what is there (for key handlers and one-box-per-digit codes).',
        },
      },
      ['target', 'text'],
    ),
  },
  {
    name: 'browser_fill_form',
    description: `Fill several form fields at once.${PAGE_NOTE}`,
    inputSchema: obj(
      {
        fields: {
          type: 'array',
          items: obj(
            {
              name: { type: 'string', description: 'Human-readable field name' },
              type: {
                type: 'string',
                enum: ['textbox', 'checkbox', 'radio', 'combobox', 'slider'],
              },
              target: TARGET,
              value: {
                type: 'string',
                description:
                  'The value. For a checkbox "true" or "false"; for a combobox the option label.',
              },
            },
            ['name', 'type', 'target', 'value'],
          ),
        },
      },
      ['fields'],
    ),
  },
  {
    name: 'browser_press_key',
    description: `Press a key, such as Enter, Escape, Tab or ArrowDown.${PAGE_NOTE}`,
    inputSchema: obj({ key: { type: 'string', description: 'Name of the key, or a character' } }, [
      'key',
    ]),
  },
  {
    name: 'browser_select_option',
    description: `Select an option in a dropdown.${PAGE_NOTE}`,
    inputSchema: obj(
      {
        element: ELEMENT,
        target: TARGET,
        values: {
          type: 'array',
          items: { type: 'string' },
          description: 'Option labels or values',
        },
      },
      ['target', 'values'],
    ),
  },
  {
    name: 'browser_hover',
    description: `Hover over an element (opens menus that open on hover).${PAGE_NOTE}`,
    inputSchema: obj({ element: ELEMENT, target: TARGET }, ['target']),
  },
  {
    name: 'browser_wait_for',
    description: `Wait for text to appear or disappear, or for some seconds to pass.${PAGE_NOTE}`,
    inputSchema: obj({
      time: { type: 'number', description: 'Seconds to wait, at most 30' },
      text: { type: 'string', description: 'Text to wait for' },
      textGone: { type: 'string', description: 'Text to wait to disappear' },
    }),
  },
  {
    name: 'browser_tabs',
    description: 'List, open, close or switch to a browser tab.',
    inputSchema: obj(
      {
        action: { type: 'string', enum: ['list', 'new', 'close', 'select'] },
        index: { type: 'number', description: 'Tab index (from list), for close and select' },
        url: { type: 'string', description: 'URL to open in the new tab' },
      },
      ['action'],
    ),
  },
  {
    name: 'browser_handle_dialog',
    description: `Accept or dismiss the open dialog (confirm or prompt).${PAGE_NOTE}`,
    inputSchema: obj(
      {
        accept: { type: 'boolean', description: 'Accept (true) or dismiss (false)' },
        promptText: { type: 'string', description: 'Text for a prompt dialog' },
      },
      ['accept'],
    ),
  },
  {
    name: 'browser_file_upload',
    description: `Upload files to a file input.${PAGE_NOTE}`,
    inputSchema: obj(
      {
        paths: { type: 'array', items: { type: 'string' }, description: 'Files to upload' },
        element: ELEMENT,
        target: {
          ...TARGET,
          description:
            'The file input or its upload button, by ref; without it the first file input on the page.',
        },
      },
      ['paths'],
    ),
  },
  {
    name: 'browser_evaluate',
    description: 'Run JavaScript on the page and return its result.',
    inputSchema: obj({ function: { type: 'string', description: '() => { /* code */ }' } }, [
      'function',
    ]),
  },
  {
    name: 'browser_take_screenshot',
    description:
      'Take a screenshot of the page or of one element. You cannot act on a screenshot; use the snapshot refs for actions.',
    inputSchema: obj({
      element: ELEMENT,
      target: TARGET,
      fullPage: { type: 'boolean', description: 'The whole scrollable page' },
      type: { type: 'string', enum: ['png', 'jpeg'] },
    }),
  },
];

/** Calls that change the page: their result includes the page they led to. */
const SETTLE: string[][] = [
  // Let a click or Enter that navigates start, then finish loading, as Playwright MCP does;
  // otherwise the page shown is the old one and its refs go stale.
  ['wait', '300'],
  ['wait', '--load', 'load', '--timeout', '8000'],
];

export interface AgentBrowserToolsOptions {
  /** Screenshots are written here, read back and deleted. */
  outputDir: string;
}

export class AgentBrowserTools {
  private inFrame = new Set<string>();
  private url: string | undefined;

  constructor(
    private ab: AgentBrowser,
    private opts: AgentBrowserToolsOptions,
  ) {
    mkdirSync(opts.outputDir, { recursive: true, mode: 0o700 });
  }

  /** The page the browser was last seen on, by any call. */
  lastUrl(): string | undefined {
    return this.url && /^https?:/.test(this.url) ? this.url : undefined;
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      return await this.dispatch(name, args ?? {});
    } catch (err) {
      return text(`### Error\n${(err as Error).message}`, true);
    }
  }

  private target(args: Record<string, unknown>): string {
    const t = toTarget(args.target ?? args.ref, this.inFrame);
    if ('error' in t) throw new Error(t.error);
    return t.ref;
  }

  private async dispatch(name: string, a: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case 'browser_navigate': {
        const url = String(a.url ?? '');
        if (!/^(https?:|about:blank$)/i.test(url))
          return text('### Error\nOnly http and https addresses can be opened.', true);
        return this.act([['open', url]], 'Opened the page.', false);
      }
      case 'browser_navigate_back':
        return this.act([['back']], 'Went back.');
      case 'browser_snapshot': {
        const page = await this.page(false);
        return text(page.text, !page.ok);
      }
      case 'browser_find': {
        const page = await this.page(false, true);
        if (!page.ok) return text(page.text, true);
        const found = findInSnapshot(page.snapshot, {
          text: typeof a.text === 'string' ? a.text : undefined,
          regex: typeof a.regex === 'string' ? a.regex : undefined,
        });
        return text(`${page.header}\n### Result\n${found}`);
      }
      case 'browser_click':
        return this.act(
          [[a.doubleClick ? 'dblclick' : 'click', this.target(a)]],
          `Clicked ${label(a)}.`,
        );
      case 'browser_type': {
        const ref = this.target(a);
        const cmds = [[a.slowly ? 'type' : 'fill', ref, String(a.text ?? '')]];
        if (a.submit === true) cmds.push(['press', 'Enter']);
        // Never echo what was typed: it may be a vault value.
        return this.act(
          cmds,
          `Typed into ${label(a)}${a.submit === true ? ' and pressed Enter' : ''}.`,
        );
      }
      case 'browser_fill_form': {
        const fields = Array.isArray(a.fields) ? (a.fields as Array<Record<string, unknown>>) : [];
        if (!fields.length) return text('### Error\nfields is empty', true);
        const cmds: string[][] = [];
        for (const f of fields) {
          const ref = this.target(f);
          const value = String(f.value ?? '');
          switch (f.type) {
            case 'checkbox':
              cmds.push([value === 'true' ? 'check' : 'uncheck', ref]);
              break;
            case 'radio':
              cmds.push(['check', ref]);
              break;
            case 'combobox':
              cmds.push(['select', ref, value]);
              break;
            default:
              cmds.push(['fill', ref, value]);
          }
        }
        return this.act(cmds, `Filled ${fields.length} field${fields.length === 1 ? '' : 's'}.`);
      }
      case 'browser_press_key':
        return this.act([['press', String(a.key ?? '')]], `Pressed ${String(a.key ?? '')}.`);
      case 'browser_select_option': {
        const values = Array.isArray(a.values) ? a.values.map(String) : [String(a.values ?? '')];
        return this.act([['select', this.target(a), ...values]], `Selected in ${label(a)}.`);
      }
      case 'browser_hover':
        return this.act([['hover', this.target(a)]], `Hovered ${label(a)}.`);
      case 'browser_wait_for': {
        const cmds: string[][] = [];
        if (typeof a.text === 'string' && a.text)
          cmds.push(['wait', '--text', a.text, '--timeout', '30000']);
        else if (typeof a.textGone === 'string' && a.textGone)
          cmds.push([
            'wait',
            '--fn',
            `!document.body.innerText.includes(${JSON.stringify(a.textGone)})`,
            '--timeout',
            '30000',
          ]);
        else
          cmds.push([
            'wait',
            String(Math.round(Math.min(Math.max(Number(a.time) || 1, 0), 30) * 1000)),
          ]);
        return this.act(cmds, 'Waited.', false);
      }
      case 'browser_tabs':
        return this.tabs(a);
      case 'browser_handle_dialog': {
        const cmd = a.accept === false ? ['dialog', 'dismiss'] : ['dialog', 'accept'];
        if (a.accept !== false && typeof a.promptText === 'string') cmd.push(a.promptText);
        return this.act(
          [cmd],
          a.accept === false ? 'Dismissed the dialog.' : 'Accepted the dialog.',
        );
      }
      case 'browser_file_upload': {
        const paths = Array.isArray(a.paths) ? a.paths.map(String) : [];
        if (!paths.length) return text('### Error\nNo files given.', true);
        const where = a.target ? this.target(a) : 'input[type=file]';
        return this.act([['upload', where, ...paths]], `Uploaded ${paths.length} file(s).`);
      }
      case 'browser_evaluate': {
        const fn = String(a.function ?? '').trim();
        const script = /^(async\s*)?(\([^)]*\)|[a-z_$][\w$]*)\s*=>|^(async\s+)?function\b/i.test(fn)
          ? `(${fn})()`
          : fn;
        const r = await this.ab.one(['eval', '-b', Buffer.from(script).toString('base64')]);
        const header = await this.header();
        if (!r.ok) return text(`${header}\n### Error\n${r.error}`, true);
        return text(`${header}\n### Result\n${JSON.stringify(r.data.result ?? null, null, 2)}`);
      }
      case 'browser_take_screenshot':
        return this.screenshot(a);
      default:
        return text(`### Error\nUnknown tool ${name}`, true);
    }
  }

  /** An action, then the page it led to. Errors still show the page: the model needs it. */
  private async act(cmds: string[][], done: string, settle = true): Promise<ToolResult> {
    const results = await this.ab.batch([...cmds, ...(settle ? SETTLE : [])]);
    const failed = results.slice(0, cmds.length).find((r) => !r.ok);
    const dialog = await this.ab.one(['dialog', 'status']);
    if (dialog.ok && dialog.data.hasDialog) {
      const msg = String(dialog.data.message ?? dialog.data.text ?? '');
      const kind = String(dialog.data.type ?? 'dialog');
      return text(
        `${failed ? `### Error\n${failed.error}\n` : ''}### Result\n${done}\n### Modal state\n- A ${kind} is open${msg ? `: "${msg}"` : ''}. Answer it with browser_handle_dialog.`,
        Boolean(failed),
      );
    }
    const page = await this.page(true);
    const body = failed ? `### Error\n${failed.error}` : `### Result\n${done}`;
    return text(`${page.header}\n${body}${page.body}`, Boolean(failed) || !page.ok);
  }

  /** The URL and title, as the `### Page` section. */
  private async header(): Promise<string> {
    const [url, title] = await this.ab.batch([
      ['get', 'url'],
      ['get', 'title'],
    ]);
    return this.pageSection(url, title);
  }

  private pageSection(url?: CommandResult, title?: CommandResult): string {
    const u = url?.ok ? String(url.data.url ?? '') : '';
    if (u) this.url = u;
    const t = title?.ok ? String(title.data.title ?? '') : '';
    return `### Page\n- Page URL: ${u || 'unknown'}\n- Page Title: ${oneLine(t)}`;
  }

  /** The page: interactive elements only, or everything with its text. */
  private async page(
    interactive: boolean,
    raw = false,
  ): Promise<{ ok: boolean; header: string; body: string; text: string; snapshot: string }> {
    const [url, title, snap] = await this.ab.batch([
      ['get', 'url'],
      ['get', 'title'],
      ['snapshot', ...(interactive ? ['-i'] : []), '-c'],
    ]);
    const header = this.pageSection(url, title);
    if (!snap?.ok) {
      const body = `\n### Error\nCould not read the page: ${snap?.error ?? 'no answer'}`;
      return { ok: false, header, body, text: `${header}${body}`, snapshot: '' };
    }
    const marked = markFrames(String(snap.data.snapshot ?? ''));
    this.inFrame = marked.inFrame;
    const content = marked.text.trim() || '(empty page)';
    const label = interactive ? '### Snapshot (interactive elements)' : '### Snapshot';
    const body = raw ? '' : `\n${label}\n\`\`\`yaml\n${content}\n\`\`\``;
    return { ok: true, header, body, text: `${header}${body}`, snapshot: content };
  }

  private async tabs(a: Record<string, unknown>): Promise<ToolResult> {
    const list = async () => {
      const r = await this.ab.one(['tab', 'list']);
      const tabs = (r.data.tabs as Array<Record<string, unknown>> | undefined) ?? [];
      return { r, tabs };
    };
    const action = String(a.action ?? 'list');
    if (action === 'new') {
      const url = typeof a.url === 'string' && a.url ? a.url : undefined;
      if (url && !/^https?:/i.test(url))
        return text('### Error\nOnly http and https addresses can be opened.', true);
      return this.act([url ? ['tab', 'new', url] : ['tab', 'new']], 'Opened a new tab.');
    }
    if (action === 'close' || action === 'select') {
      const { tabs } = await list();
      const i = a.index === undefined ? undefined : Number(a.index);
      const tab = i === undefined ? undefined : tabs[i];
      if (i !== undefined && !tab) return text(`### Error\nNo tab ${i}.`, true);
      if (action === 'select') {
        if (!tab) return text('### Error\nindex is required to select a tab.', true);
        return this.act([['tab', String(tab.tabId)]], `Switched to tab ${i}.`, false);
      }
      return this.act(
        [tab ? ['tab', 'close', String(tab.tabId)] : ['tab', 'close']],
        'Closed the tab.',
        false,
      );
    }
    const { r, tabs } = await list();
    if (!r.ok) return text(`### Error\n${r.error}`, true);
    const lines = tabs.map(
      (t, i) =>
        `- ${i}:${t.active ? ' (current)' : ''} [${oneLine(String(t.title ?? ''))}](${String(t.url ?? '')})`,
    );
    return text(`${await this.header()}\n### Open tabs\n${lines.join('\n') || '(none)'}`);
  }

  private async screenshot(a: Record<string, unknown>): Promise<ToolResult> {
    const jpeg = a.type === 'jpeg';
    const file = path.join(
      this.opts.outputDir,
      `shot-${Date.now()}-${randomBytes(4).toString('hex')}.${jpeg ? 'jpg' : 'png'}`,
    );
    const cmd = ['screenshot'];
    if (a.target) cmd.push(this.target(a));
    cmd.push(file);
    if (a.fullPage === true) cmd.push('--full');
    const r = await this.ab.one(cmd);
    if (!r.ok) return text(`### Error\n${r.error}`, true);
    try {
      const data = (await readFile(file)).toString('base64');
      return {
        content: [
          { type: 'text', text: `${await this.header()}\n### Result\nTook a screenshot.` },
          { type: 'image', data, mimeType: jpeg ? 'image/jpeg' : 'image/png' },
        ],
      };
    } finally {
      await rm(file, { force: true });
    }
  }
}

const text = (t: string, isError = false): ToolResult => ({
  content: [{ type: 'text', text: t }],
  ...(isError ? { isError: true } : {}),
});

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 200);
const label = (a: Record<string, unknown>) =>
  oneLine(String(a.element ?? a.name ?? a.target ?? 'the element')) || 'the element';
