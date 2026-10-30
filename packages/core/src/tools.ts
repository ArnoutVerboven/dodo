import { z } from 'zod';
import { catalog } from './builtin-tools.gen.js';
import { HttpUrl, Timestamp } from './model.js';

/**
 * Tools view (Settings › Tools): which tools the agent gets. Three kinds of things:
 *
 *   built-in tools   defined in packages/agent; can be turned off globally (settings/tools)
 *   MCP servers      mcpServers/{id}: remote (HTTP, reachable from the cloud and from a Mac) or
 *                    local (added on a Mac with `dodo mcp add`, run by its daemon); their tool
 *                    lists are fetched once and cached on the document
 *   toolsets         toolsets/{id}: named presets of tools; attached to a task or project they
 *                    narrow what its runs get
 *
 * Tools are referred to by refs: `builtin:bash`, `mcp:outlook:send_mail`, and `*` at the end of
 * a ref for a prefix (`mcp:outlook:*`, `builtin:browser_*`).
 */

/** The tools every run keeps: without them the agent cannot report or stop. */
export const CORE_TOOLS = ['update_summary', 'set_status', 'post_message', 'ask_user', 'finish'];

export const BuiltinGroup = z.enum([
  'core',
  'task',
  'vault',
  'exec',
  'web',
  'google',
  'notion',
  'github',
  'browser',
]);
export type BuiltinGroup = z.infer<typeof BuiltinGroup>;

/**
 * What a group needs before a run gets it, beyond being turned on. Toolsets choose among the
 * `task`, `vault`, `exec`, `web`, `google` and `notion` groups; `github` and `browser` follow the task's Repo and Browser
 * settings, so a toolset does not take them away.
 */
export const GROUPS: Record<BuiltinGroup, { label: string; note: string; toolsets: boolean }> = {
  core: {
    label: 'Task basics',
    note: 'Always on: summary, status, messages, questions and finishing.',
    toolsets: false,
  },
  task: {
    label: 'Task files and info',
    note: 'Attachments and your personal info.',
    toolsets: true,
  },
  vault: { label: 'Vault', note: 'Logins typed into sites, approved per task.', toolsets: true },
  exec: {
    label: 'Shell, files and HTTP',
    note: 'Mac: inside the sandbox, in the task folder. Remote: in the run’s container.',
    toolsets: true,
  },
  web: {
    label: 'Web search',
    note: 'Google Search through Gemini, answered with sources. Each search is charged to the task’s budget (about €0.014 a query).',
    toolsets: true,
  },
  google: {
    label: 'Google',
    note: 'Only when Google is connected (Settings › Integrations). Gmail search and read, your calendar, and Drive; saved files go to your dodo folder. Creating events and changing existing files ask first.',
    toolsets: true,
  },
  notion: {
    label: 'Notion',
    note: 'Only when Notion is connected (Settings › Integrations), and only the pages and databases you shared with the integration. Search and reading are free; new pages, changes and moving to trash ask first.',
    toolsets: true,
  },
  github: {
    label: 'GitHub',
    note: 'Only when the task or project has a repository.',
    toolsets: false,
  },
  browser: {
    label: 'Browser',
    note: 'Follows the task’s Browser setting. Mac: your Chrome window. Remote: headless Chromium.',
    toolsets: false,
  },
};

export const BuiltinTool = z.object({
  name: z.string(),
  group: BuiltinGroup,
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
});
export type BuiltinTool = z.infer<typeof BuiltinTool>;

/**
 * Generated from the agent's own definitions (and Playwright MCP for the browser tools) by
 * `pnpm --filter @dodo/cli catalog`; a test in packages/agent fails when it is stale.
 */
export const BUILTIN_TOOLS: BuiltinTool[] = z.array(BuiltinTool).parse(catalog);

/** MCP's tool hints; `readOnlyHint` decides whether a call needs approval. */
export const McpAnnotations = z.looseObject({
  title: z.string().optional(),
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});
export type McpAnnotations = z.infer<typeof McpAnnotations>;

export const McpToolInfo = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().default(''),
  inputSchema: z.record(z.string(), z.unknown()).default({ type: 'object' }),
  annotations: McpAnnotations.optional(),
});
export type McpToolInfo = z.infer<typeof McpToolInfo>;

/** The cached tool list of a server: fetched once, refreshed by hand. */
export const McpCatalog = z.object({
  tools: z.array(McpToolInfo),
  fetchedAt: Timestamp,
  /** Who fetched it: `cloud`, or `mac:{deviceId}`. */
  by: z.string(),
  server: z.object({ name: z.string(), version: z.string().optional() }).optional(),
});
export type McpCatalog = z.infer<typeof McpCatalog>;

/** Lowercase name used in tool names (`mcp__outlook__send_mail`) and rules (`Mcp(outlook:…)`). */
export const McpSlug = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,23}$/, 'Lowercase letters, digits and dashes, starting with a letter');

export const McpServer = z.object({
  id: z.string(),
  name: z.string().min(1).max(60),
  slug: McpSlug,
  /** remote: an HTTP server the cloud can reach; local: run by a Mac's daemon. */
  runsOn: z.enum(['remote', 'local']),
  transport: z.enum(['http', 'stdio']),
  url: HttpUrl.optional(),
  /** Local only, as the Mac reports it (no env values: those stay on the Mac). */
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  deviceId: z.string().optional(),
  enabled: z.boolean().default(true),
  /** Tools of this server the agent never gets. */
  disabledTools: z.array(z.string()).default([]),
  /** Remote: an Authorization header is stored (Secret Manager), never shown again. */
  hasAuth: z.boolean().default(false),
  catalog: McpCatalog.optional(),
  /** The last refresh failed; `needsAuth` when the server wants a sign-in. */
  error: z
    .object({ message: z.string(), at: Timestamp, needsAuth: z.boolean().optional() })
    .optional(),
  /** Set by Refresh; the Mac that runs a local server fetches its tools when it sees it. */
  refreshRequestedAt: Timestamp.optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type McpServer = z.infer<typeof McpServer>;

export const Toolset = z.object({
  id: z.string(),
  name: z.string().min(1).max(60),
  description: z.string().max(500).default(''),
  tools: z.array(z.string()).default([]),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Toolset = z.infer<typeof Toolset>;

/** settings/tools */
export const ToolSettings = z.object({
  disabledBuiltins: z.array(z.string()).default([]),
});
export type ToolSettings = z.infer<typeof ToolSettings>;

/** Remote server add/edit (callable `mcpServerSave`): the header goes to Secret Manager. */
export const McpServerSaveRequest = z.object({
  id: McpSlug.optional(),
  name: z.string().trim().min(1).max(60),
  slug: McpSlug,
  url: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//.test(u), 'An http(s) URL'),
  /** e.g. `Bearer abc`; empty keeps the stored one, `null` removes it. */
  authorization: z.string().max(4000).nullable().optional(),
});
export type McpServerSaveRequest = z.infer<typeof McpServerSaveRequest>;

export const McpServerIdRequest = z.object({ id: z.string().min(1).max(200) });

export const builtinRef = (name: string) => `builtin:${name}`;
export const mcpRef = (slug: string, tool: string) => `mcp:${slug}:${tool}`;

/** `ref` names `target` exactly, or as a prefix when it ends in `*`. */
export function refMatches(ref: string, target: string): boolean {
  return ref.endsWith('*') ? target.startsWith(ref.slice(0, -1)) : ref === target;
}

/** Which tools of one source a run gets: everything not disabled, or only the listed ones. */
export interface ToolFilter {
  disabled: string[];
  /** Absent: every tool not disabled. */
  only?: string[];
}

export const toolAllowed = (f: ToolFilter, name: string) =>
  !f.disabled.includes(name) && (!f.only || f.only.includes(name) || f.only.includes('*'));

/** An MCP server as a run sees it (runStart): where to reach it and which tools to take. */
export interface RunMcpServer {
  id: string;
  slug: string;
  name: string;
  runsOn: 'remote' | 'local';
  url?: string;
  /** Remote only: the stored Authorization header. */
  authorization?: string;
  filter: ToolFilter;
}

export interface RunToolAccess {
  builtins: ToolFilter;
  mcp: RunMcpServer[];
  /** Names of the toolsets that narrowed this run, for the trace. */
  toolsets: string[];
}

/**
 * The tools one run gets. Turned off globally always wins. Without toolsets: every enabled
 * tool. With toolsets: the core tools, the github and browser groups (they follow the task's
 * own settings), and the union of what the toolsets name. Local servers only on their own Mac.
 */
export function resolveToolAccess(input: {
  settings: ToolSettings;
  servers: McpServer[];
  toolsets: Toolset[];
  /** The run's device: `gcp` or `mac:{id}`. */
  device: string;
}): Omit<RunToolAccess, 'mcp'> & { mcp: Omit<RunMcpServer, 'authorization'>[] } {
  const narrowed = input.toolsets.length > 0;
  const refs = input.toolsets.flatMap((t) => t.tools);
  const picks = (target: string) => refs.some((r) => refMatches(r, target));
  const builtins: ToolFilter = {
    disabled: input.settings.disabledBuiltins.filter((n) => !CORE_TOOLS.includes(n)),
  };
  if (narrowed) {
    builtins.only = BUILTIN_TOOLS.filter(
      (t) => !GROUPS[t.group].toolsets || picks(builtinRef(t.name)),
    ).map((t) => t.name);
    // A tool newer than the catalog still counts when a toolset names it.
    for (const r of refs)
      if (r.startsWith('builtin:') && !r.endsWith('*')) builtins.only.push(r.slice(8));
  }
  const mac = input.device.startsWith('mac:') ? input.device.slice(4) : undefined;
  const mcp = input.servers
    .filter((s) => s.enabled)
    .filter((s) => (s.runsOn === 'local' ? !!mac && s.deviceId === mac : !!s.url))
    .flatMap((s) => {
      const filter: ToolFilter = { disabled: s.disabledTools };
      if (narrowed) {
        const prefix = `mcp:${s.slug}:`;
        // `mcp:outlook:*` (or a shorter prefix) takes the whole server.
        const whole = refs.some((r) => r.endsWith('*') && prefix.startsWith(r.slice(0, -1)));
        if (whole) filter.only = ['*'];
        else {
          const mine = refs.filter((r) => r.startsWith(prefix));
          if (mine.length === 0) return [];
          // A prefix within the server (`mcp:outlook:list_*`) expands against the cached list.
          const names = s.catalog?.tools.map((t) => t.name) ?? [];
          filter.only = [
            ...new Set(
              mine.flatMap((r) => {
                const n = r.slice(prefix.length);
                return n.endsWith('*') ? names.filter((x) => refMatches(n, x)) : [n];
              }),
            ),
          ];
        }
      }
      return [
        {
          id: s.id,
          slug: s.slug,
          name: s.name,
          runsOn: s.runsOn,
          ...(s.url ? { url: s.url } : {}),
          filter,
        },
      ];
    });
  return { builtins, mcp, toolsets: input.toolsets.map((t) => t.name) };
}

/** The function name the model sees for an MCP tool: Gemini allows [A-Za-z0-9_.-], 64 chars. */
export function mcpToolName(slug: string, tool: string): string {
  const clean = tool.replace(/[^A-Za-z0-9_.-]/g, '_');
  return `mcp__${slug.replace(/-/g, '_')}__${clean}`.slice(0, 64);
}

/** Error text that reads like the server wants you to sign in (HTTP 401, OAuth, expired token). */
export function looksLikeAuthError(message: string): boolean {
  return /\b(401|403|unauthori[sz]ed|forbidden|invalid[_ ]token|expired|sign[ -]?in|log[ -]?in|authenticat|oauth|consent)\b/i.test(
    message,
  );
}
