import { BUILTIN_TOOLS } from '@dodo/core';
import { PolicyEngine } from '@dodo/policy';
import { describe, expect, it } from 'vitest';
import { builtinCatalog } from './catalog.js';
import { type McpClient, mcpTools } from './mcp.js';
import { toDeclarations } from './tools.js';

const client = (calls: Array<[string, unknown]> = []): McpClient => ({
  listTools: async () => [
    {
      name: 'list_mail',
      description: 'List messages',
      inputSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { folder: { type: 'string' } },
      },
      annotations: { readOnlyHint: true },
    },
    { name: 'send_mail', description: 'Send a message', inputSchema: { type: 'object' } },
    { name: 'delete_all', description: 'Nope', inputSchema: { type: 'object' } },
  ],
  callTool: async (name, args) => {
    calls.push([name, args]);
    return { text: `called ${name} secret-123`, isError: false };
  },
  close: async () => {},
});

describe('mcpTools', () => {
  it('offers the allowed tools under prefixed names with the server schema', async () => {
    const tools = await mcpTools(client(), {
      slug: 'outlook',
      name: 'Outlook',
      filter: { disabled: ['delete_all'] },
    });
    expect(tools.map((t) => t.name)).toEqual([
      'mcp__outlook__list_mail',
      'mcp__outlook__send_mail',
    ]);
    const [decl] = toDeclarations(tools);
    expect(decl?.description).toBe('[Outlook] List messages');
    expect(decl?.parametersJsonSchema).toEqual({
      type: 'object',
      properties: { folder: { type: 'string' } },
    });
    expect(decl?.parameters).toBeUndefined();
  });

  it('runs read-only tools freely and asks for the rest, keyed Mcp(server:tool)', async () => {
    const tools = await mcpTools(client(), {
      slug: 'outlook',
      name: 'Outlook',
      filter: { disabled: [] },
    });
    const policy = new PolicyEngine({ profile: 'agent-decides', allow: [], deny: [] });
    const ctx = { store: {} as never };
    const decide = (i: number) => {
      const t = tools[i];
      const claim = t?.policy?.({}, ctx);
      return claim ? policy.decide(claim) : undefined;
    };
    expect(decide(0)).toEqual({ kind: 'allow' });
    expect(decide(1)).toMatchObject({ kind: 'ask', suggestedRule: 'Mcp(outlook:send_mail)' });
    const allowed = new PolicyEngine({
      profile: 'agent-decides',
      allow: ['Mcp(outlook:*)'],
      deny: [],
    });
    const claim = tools[1]?.policy?.({}, ctx);
    expect(claim && allowed.decide(claim).kind).toBe('allow');
  });

  it('calls the server with the arguments and redacts the result', async () => {
    const calls: Array<[string, unknown]> = [];
    const [tool] = await mcpTools(client(calls), {
      slug: 'outlook',
      name: 'Outlook',
      filter: { disabled: [], only: ['list_mail'] },
    });
    const out = await tool?.execute(
      { folder: 'inbox' },
      {
        store: {} as never,
        secrets: { redact: (s: string) => s.replace('secret-123', '***'), resolve: async (s) => s },
      },
    );
    expect(calls).toEqual([['list_mail', { folder: 'inbox' }]]);
    expect(out?.result).toEqual({ text: 'called list_mail ***' });
  });
});

describe('builtin catalog', () => {
  it('matches the agent’s own tools (regenerate: pnpm --filter @dodo/cli catalog)', () => {
    const generated = BUILTIN_TOOLS.filter(
      (t) =>
        t.group !== 'browser' ||
        ['request_browser', 'request_device', 'get_email_code', 'use_google_session'].includes(
          t.name,
        ),
    );
    expect(generated).toEqual(builtinCatalog());
  });
});
