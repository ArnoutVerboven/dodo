import type { FunctionDeclaration } from '@dodo/core';
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
      };
    }
  | { result: Record<string, unknown>; finish: { outcome: 'done' | 'review' | 'blocked' } };

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  /** The JSON schema the model sees, when it is not the zod schema's (tools proxied from MCP). */
  parameters?: Record<string, unknown>;
  /** Absent for task tools: they cannot reach anything outside the task. */
  policy?: (args: z.infer<S>, ctx: ToolContext) => PolicyClaim;
  execute(args: z.infer<S>, ctx: ToolContext): Promise<ToolOutcome>;
}

export const define = <S extends z.ZodType>(t: ToolDef<S>): ToolDef<S> => t;

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
      'Ask the user a question and stop until they answer. Use only for real decisions, missing information or approvals; make your best assumption otherwise and say so. The run ends after this call; the answer arrives with the next run.',
    schema: z.object({
      kind: z.enum(['text', 'choice', 'approval']),
      prompt: z.string().min(1).max(4000),
      options: z.array(z.string().min(1)).min(2).max(6).optional(),
      /** For approvals: the permission rule "Always allow" would add, e.g. Bash(git push:*). */
      suggestedRule: z.string().optional(),
    }),
    async execute(args) {
      return {
        result: { ok: true, note: 'The run pauses here until the user answers.' },
        askUser: args,
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
      'End the work on this task. outcome: "done" when the task is complete, "review" when the user should check the result, "blocked" when you cannot continue. Update the Summary and Status before calling this.',
    schema: z.object({ outcome: z.enum(['done', 'review', 'blocked']) }),
    async execute(args) {
      return { result: { ok: true }, finish: args };
    },
  }),
] as ToolDef[];

export function toDeclarations(tools: ToolDef[]): FunctionDeclaration[] {
  return tools.map((t) => {
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
