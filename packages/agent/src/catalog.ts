import type { BuiltinGroup, BuiltinTool } from '@dodo/core';
import { BROWSER_TOOLS, emailCodeTool } from './browser.js';
import { execTools } from './exec-tools.js';
import { githubTools } from './github-tools.js';
import { webSearchTool } from './search-tools.js';
import {
  requestBrowserTool,
  requestDeviceTool,
  type ToolDef,
  taskTools,
  toDeclarations,
} from './tools.js';

const GROUP_OF: Record<string, BuiltinGroup> = {
  update_summary: 'core',
  set_status: 'core',
  post_message: 'core',
  ask_user: 'core',
  finish: 'core',
  list_vault: 'vault',
  request_vault_access: 'vault',
  request_browser: 'browser',
};

/**
 * The built-in tools as the Tools view shows them: name, group, the description and the
 * parameters the model sees. The browser tools come from Playwright MCP and are added by the
 * generator (`pnpm --filter @dodo/cli catalog`), which writes packages/core's catalog.
 */
export function builtinCatalog(): BuiltinTool[] {
  const github = githubTools({
    repo: '<repo>',
    writeToken: async () => '',
    openPullRequest: async () => ({ url: '', number: 0, existing: false }),
  });
  const entries: Array<[ToolDef[], BuiltinGroup]> = [
    [taskTools, 'task'],
    [execTools, 'exec'],
    [
      [
        webSearchTool(async () => ({
          answer: '',
          sources: [],
          queries: [],
          cost: 0,
          remaining: 0,
        })),
      ],
      'web',
    ],
    [github, 'github'],
    [
      [
        requestBrowserTool as ToolDef,
        requestDeviceTool as ToolDef,
        emailCodeTool({
          fetch: async () => ({ found: false }),
          host: () => '',
          since: () => undefined,
          type: async () => ({}),
        }),
      ],
      'browser',
    ],
  ];
  return entries.flatMap(([tools, group]) =>
    toDeclarations(tools).map((d) => ({
      name: d.name,
      group: GROUP_OF[d.name] ?? group,
      description: d.description,
      inputSchema: (d.parameters ?? {}) as Record<string, unknown>,
    })),
  );
}

/** Browser tools from a Playwright MCP tool list, in the order the agent gets them. */
export function browserCatalog(
  tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>,
): BuiltinTool[] {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return BROWSER_TOOLS.flatMap((name) => {
    const t = byName.get(name);
    if (!t) return [];
    const { $schema: _s, ...inputSchema } = t.inputSchema;
    return [{ name, group: 'browser' as const, description: t.description ?? name, inputSchema }];
  });
}
