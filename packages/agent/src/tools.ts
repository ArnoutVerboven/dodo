import type { FunctionDeclaration, ImageUpload } from '@dodo/core';
import { vaultRef, vaultRule } from '@dodo/core';
import type { ActionCategory, PolicyEngine } from '@dodo/policy';
import { z } from 'zod';
import type { TaskStore } from './control-plane.js';
import type { SecretResolver } from './secrets.js';

/**
 * Tools are defined once in our own format and converted per adapter. Phase 2 ships only
 * the task tools: they cannot reach the network or the filesystem, so they need no policy
 * decision. Every later tool (bash, http, browser) goes through the policy engine first.
 */
export interface ToolContext {
  store: TaskStore;
  /** Decides allow / ask / deny for tools that declare a policy. Absent: only task tools run. */
  policy?: PolicyEngine;
  /** The run's task folder; exec tools are confined to it. */
  workdir?: string;
  /** Vault values for tools that type into a site; absent when the run has no such tool. */
  secrets?: SecretResolver;
  /** A screenshot of the browser page (or one element on it); absent when the run has no browser. */
  screenshot?: (target?: { element: string; ref: string }) => Promise<ImageUpload | undefined>;
}

/** What a call does, for the policy engine: the rule tool name, the key rules match, the category. */
export interface PolicyClaim {
  tool: string;
  key: string;
  category: ActionCategory;
}

/** What a tool returns to the model, plus control-flow signals for the loop. */
export type ToolOutcome =
  | { result: Record<string, unknown> }
  | {
      result: Record<string, unknown>;
      /** Ends the run and asks the user; the loop stores the session and exits. */
      askUser: {
        kind: 'text' | 'choice' | 'approval';
        prompt: string;
        options?: string[];
        suggestedRule?: string;
        /** Shown with the question in the app and sent as a photo on Telegram. */
        image?: ImageUpload;
      };
    }
  | { result: Record<string, unknown>; finish: { outcome: 'done' | 'review' | 'blocked' } }
  /** Ends the run so it restarts with a browser, same session (request_browser). */
  | { result: Record<string, unknown>; needsBrowser: true };

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  /** The JSON schema the model sees, when it is not the zod schema's (tools proxied from MCP). */
  parameters?: Record<string, unknown>;
  /** A full JSON schema the model sees as is (MCP servers' tools; Gemini's parametersJsonSchema). */
  jsonSchema?: Record<string, unknown>;
  /** Absent for task tools: they cannot reach anything outside the task. */
  policy?: (args: z.infer<S>, ctx: ToolContext) => PolicyClaim;
  execute(args: z.infer<S>, ctx: ToolContext): Promise<ToolOutcome>;
}

export const define = <S extends z.ZodType>(t: ToolDef<S>): ToolDef<S> => t;

/**
 * Offered when the task's browser setting is `auto` and this run got none: the agent found
 * out it needs one after all. The run ends and a new one with a browser continues the session.
 */
export const requestBrowserTool = define({
  name: 'request_browser',
  description:
    'Ask for a web browser when the task turns out to need one: a site to log in to, click through or fill in, a JavaScript app that an HTTP fetch cannot read, or something you must look at. The run restarts with the browser_* tools and your conversation so far; nothing else changes. Not for pages the http tool reads fine.',
  schema: z.object({
    reason: z.string().min(1).max(500).describe('What you need the browser for, in one line.'),
  }),
  async execute({ reason }) {
    return {
      result: {
        ok: true,
        note: `Restarting with a browser (${reason}). The browser_* tools are available from your next step; continue the task there.`,
      },
      needsBrowser: true,
    };
  },
});

export const taskTools = [
  define({
    name: 'update_summary',
    description:
      'Replace the task Summary: the top-down, always-current picture of what has been done, what was found and what the result is. Markdown. Rewrite it whole each time; the user reads this first.',
    schema: z.object({ markdown: z.string().min(1).max(8000) }),
    async execute({ markdown }, { store }) {
      await store.updateSummary(markdown);
      return { result: { ok: true } };
    },
  }),
  define({
    name: 'set_status',
    description:
      'Set the one-line Status shown on the board: what you are doing now and the next action. Keep it under 120 characters. Set needsYou when you are blocked on the user.',
    schema: z.object({
      text: z.string().min(1).max(200),
      nextAction: z.string().max(200).optional(),
      needsYou: z.boolean().default(false),
    }),
    async execute(line, { store }) {
      await store.setStatus(line);
      return { result: { ok: true } };
    },
  }),
  define({
    name: 'post_message',
    description:
      'Post a message in the task thread for the user to read later. Use it for findings, results and decisions you made. Not for questions: use ask_user for those.',
    schema: z.object({ body: z.string().min(1).max(20000) }),
    async execute({ body }, { store }) {
      await store.postMessage(body);
      return { result: { ok: true } };
    },
  }),
  define({
    name: 'ask_user',
    description:
      'Ask the user and stop until they answer. Use it when a short answer saves a lot of work or rework (inputs only they know, a choice that changes the outcome) or for an approval; otherwise make your best assumption, say so, and keep going. Ask everything you will need for the rest of the task in this one call, as a short numbered list with your best guess for each, then finish the task yourself once they answer. Lead with what you need from them. The run pauses after this call and continues with the answer. Set screenshot to attach a picture of the browser page when the user has to see it to answer, e.g. the code or the icon to pick in their phone app, or a QR code (which they must scan from another screen); they may be answering from their phone.',
    schema: z.object({
      kind: z.enum(['text', 'choice', 'approval']),
      prompt: z.string().min(1).max(4000),
      options: z.array(z.string().min(1)).min(2).max(6).optional(),
      /** For approvals: the permission rule "Always allow" would add, e.g. Bash(git push:*). */
      suggestedRule: z.string().optional(),
      screenshot: z
        .boolean()
        .optional()
        .describe('Attach a screenshot of the current browser page to the question.'),
      screenshotElement: z
        .string()
        .optional()
        .describe(
          'With screenshotRef: only this element (e.g. "QR code"), described for the user.',
        ),
      screenshotRef: z
        .string()
        .optional()
        .describe('The element ref from the page snapshot, to crop the screenshot to it.'),
    }),
    async execute({ screenshot, screenshotElement, screenshotRef, ...question }, ctx) {
      let image: ImageUpload | undefined;
      let note = 'The run pauses here until the user answers.';
      if (screenshot) {
        const target =
          screenshotRef && screenshotElement
            ? { element: screenshotElement, ref: screenshotRef }
            : undefined;
        image = await ctx.screenshot?.(target).catch(() => undefined);
        // A crop that failed (stale ref) still beats no picture: fall back to the whole page.
        if (!image && target) image = await ctx.screenshot?.().catch(() => undefined);
        if (!image) note += ' No screenshot could be taken, so the question was sent without it.';
      }
      return {
        result: { ok: true, note, ...(image ? { screenshot: 'attached' } : {}) },
        askUser: { ...question, ...(image ? { image } : {}) },
      };
    },
  }),
  define({
    name: 'list_artifacts',
    description: 'List the files, links and notes attached to the task.',
    schema: z.object({}),
    async execute(_, { store }) {
      const artifacts = await store.listArtifacts();
      return {
        result: {
          artifacts: artifacts.map((a) => ({
            id: a.id,
            kind: a.kind,
            role: a.role,
            name: a.name,
            url: a.url,
          })),
        },
      };
    },
  }),
  define({
    name: 'read_artifact',
    description:
      'Read the text content of an attached artifact (text files, notes, fetched links).',
    schema: z.object({ id: z.string() }),
    async execute({ id }, { store }) {
      return { result: { text: await store.readArtifact(id) } };
    },
  }),
  define({
    name: 'add_artifact',
    description: 'Attach an output to the task: a link, or a text/markdown document you produced.',
    schema: z.object({
      kind: z.enum(['link', 'text']),
      name: z.string().min(1).max(200),
      url: z.string().url().optional(),
      text: z.string().max(200000).optional(),
    }),
    async execute(args, { store }) {
      if (args.kind === 'link' && !args.url) return { result: { error: 'A link needs a url' } };
      if (args.kind === 'text' && !args.text)
        return { result: { error: 'A text artifact needs text' } };
      return { result: { id: await store.addArtifact(args) } };
    },
  }),
  define({
    name: 'get_personal_info',
    description:
      "The user's personal details for forms, sign-ups and scheduling: name, email, phone, address, birth date, language, time zone, other details and notes (e.g. when they work). Use these instead of asking. Empty fields are unknown.",
    schema: z.object({}),
    async execute(_, { store }) {
      const info = await store.getPersonalInfo();
      if (!info) return { result: { info: {}, note: 'The user has not filled in personal info.' } };
      const { updatedAt: _u, ...rest } = info;
      return { result: { info: rest } };
    },
  }),
  define({
    name: 'list_vault',
    description:
      "The user's vault: logins and other secret values (passwords, usernames, phone numbers for itsme) you can type into a site without seeing them. Returns each entry's id, name, the sites it may be used on, its fields and a login hint, never the values. Refer to a value as {{vault:<id>.<field>}} in a tool that types into a page; a task must be approved for an entry first (request_vault_access).",
    schema: z.object({}),
    async execute(_, { store }) {
      const entries = await store.listVault();
      return {
        result: {
          entries: entries.map((e) => ({
            id: e.id,
            name: e.name,
            sites: e.domains,
            hint: e.hint || undefined,
            fields: e.fields.map((f) => ({
              field: f.key,
              label: f.label,
              ref: vaultRef(e.id, f.key),
            })),
          })),
        },
      };
    },
  }),
  define({
    name: 'request_vault_access',
    description:
      'Ask the user to approve using one vault entry in this task. The run pauses until they answer; once approved, the entry stays usable in this task on its own sites only.',
    schema: z.object({
      entryId: z.string().min(1),
      reason: z.string().min(1).max(500),
    }),
    async execute({ entryId, reason }, { store }) {
      const entry = (await store.listVault()).find((e) => e.id === entryId);
      if (!entry) return { result: { error: `No vault entry ${entryId}; see list_vault.` } };
      const fields = entry.fields.map((f) => f.label.toLowerCase()).join(', ');
      return {
        result: { ok: true, note: 'The run pauses here until the user answers.' },
        askUser: {
          kind: 'approval',
          prompt: `Use your vault entry "${entry.name}" (${fields}) on ${entry.domains.join(', ')} for this task? ${reason}`,
          suggestedRule: vaultRule(entry.id),
        },
      };
    },
  }),
  define({
    name: 'finish',
    description:
      'End the work on this task. outcome: "done" when the task is complete, "review" when the user should check the result or take a decision, "blocked" when you cannot continue and asking the user would not help. If the user could unblock you with an answer, use ask_user instead. Update the Summary and Status before calling this.',
    schema: z.object({ outcome: z.enum(['done', 'review', 'blocked']) }),
    async execute(args) {
      return { result: { ok: true }, finish: args };
    },
  }),
] as ToolDef[];

export function toDeclarations(tools: ToolDef[]): FunctionDeclaration[] {
  return tools.map((t) => {
    if (t.jsonSchema) {
      const { $schema: _s, ...schema } = t.jsonSchema;
      return { name: t.name, description: t.description, parametersJsonSchema: schema };
    }
    if (t.parameters) return { name: t.name, description: t.description, parameters: t.parameters };
    const schema = z.toJSONSchema(t.schema, { target: 'openapi-3.0', io: 'input' }) as Record<
      string,
      unknown
    >;
    // Gemini wants a bare object schema without $schema / additionalProperties noise.
    delete schema.$schema;
    delete schema.additionalProperties;
    return { name: t.name, description: t.description, parameters: schema };
  });
}

export function findTool(tools: ToolDef[], name: string): ToolDef | undefined {
  return tools.find((t) => t.name === name);
}
