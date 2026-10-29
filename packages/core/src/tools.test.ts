import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TOOLS,
  type McpServer,
  mcpToolName,
  refMatches,
  resolveToolAccess,
  type Toolset,
  toolAllowed,
} from './tools.js';

const server = (over: Partial<McpServer>): McpServer => ({
  id: over.slug ?? 'linear',
  name: 'Linear',
  slug: 'linear',
  runsOn: 'remote',
  transport: 'http',
  url: 'https://mcp.linear.app/mcp',
  enabled: true,
  disabledTools: [],
  hasAuth: false,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});
const toolset = (tools: string[]): Toolset => ({
  id: 'ts',
  name: 'Mail',
  description: '',
  tools,
  createdAt: 1,
  updatedAt: 1,
});
const outlook = server({
  id: 'mac1-outlook',
  name: 'Outlook',
  slug: 'outlook',
  runsOn: 'local',
  transport: 'stdio',
  url: undefined,
  deviceId: 'mac1',
  catalog: {
    tools: [
      { name: 'list_mail', description: '', inputSchema: {} },
      { name: 'list_events', description: '', inputSchema: {} },
      { name: 'send_mail', description: '', inputSchema: {} },
    ],
    fetchedAt: 1,
    by: 'mac:mac1',
  },
});

describe('resolveToolAccess', () => {
  it('gives every enabled tool when no toolset is attached', () => {
    const r = resolveToolAccess({
      settings: { disabledBuiltins: ['bash', 'finish'] },
      servers: [server({}), server({ slug: 'off', enabled: false }), outlook],
      toolsets: [],
      device: 'gcp',
    });
    // finish is a core tool: it cannot be turned off.
    expect(r.builtins).toEqual({ disabled: ['bash'] });
    expect(toolAllowed(r.builtins, 'http_fetch')).toBe(true);
    // Local servers only on their own Mac; disabled servers never.
    expect(r.mcp.map((s) => s.slug)).toEqual(['linear']);
    const onMac = resolveToolAccess({
      settings: { disabledBuiltins: [] },
      servers: [server({}), outlook],
      toolsets: [],
      device: 'mac:mac1',
    });
    expect(onMac.mcp.map((s) => s.slug)).toEqual(['linear', 'outlook']);
    expect(
      resolveToolAccess({
        settings: { disabledBuiltins: [] },
        servers: [outlook],
        toolsets: [],
        device: 'mac:other',
      }).mcp,
    ).toEqual([]);
  });

  it('narrows to the toolsets: core, github and browser stay, the rest is picked', () => {
    const r = resolveToolAccess({
      settings: { disabledBuiltins: ['read_file'] },
      servers: [server({}), outlook],
      toolsets: [toolset(['builtin:http_fetch', 'builtin:read_file', 'mcp:outlook:list_*'])],
      device: 'mac:mac1',
    });
    const allowed = BUILTIN_TOOLS.map((t) => t.name).filter((n) => toolAllowed(r.builtins, n));
    expect(allowed).toContain('ask_user');
    expect(allowed).toContain('http_fetch');
    expect(allowed).toContain('open_pull_request');
    expect(allowed).toContain('browser_navigate');
    expect(allowed).not.toContain('bash');
    expect(allowed).not.toContain('list_vault');
    // Turned off globally wins over a toolset.
    expect(allowed).not.toContain('read_file');
    // linear is in no toolset: not connected at all. outlook: the prefix expands.
    expect(r.mcp.map((s) => s.slug)).toEqual(['outlook']);
    expect(r.mcp[0]?.filter.only).toEqual(['list_mail', 'list_events']);
    expect(r.toolsets).toEqual(['Mail']);
  });

  it('takes a whole server with server:*, minus its disabled tools', () => {
    const r = resolveToolAccess({
      settings: { disabledBuiltins: [] },
      servers: [{ ...outlook, disabledTools: ['send_mail'] }],
      toolsets: [toolset(['mcp:outlook:*'])],
      device: 'mac:mac1',
    });
    const f = r.mcp[0]?.filter;
    expect(f && toolAllowed(f, 'list_mail')).toBe(true);
    expect(f && toolAllowed(f, 'something_new')).toBe(true);
    expect(f && toolAllowed(f, 'send_mail')).toBe(false);
  });
});

describe('tool refs and names', () => {
  it('matches exact refs and prefixes', () => {
    expect(refMatches('mcp:outlook:*', 'mcp:outlook:send')).toBe(true);
    expect(refMatches('mcp:outlook:send', 'mcp:outlook:send_all')).toBe(false);
  });
  it('makes function names Gemini accepts', () => {
    expect(mcpToolName('my-db', 'run query!')).toBe('mcp__my_db__run_query_');
    expect(mcpToolName('x', 'a'.repeat(100))).toHaveLength(64);
  });
  it('ships a catalog with every core tool', () => {
    for (const n of ['update_summary', 'ask_user', 'finish', 'bash', 'browser_navigate'])
      expect(BUILTIN_TOOLS.some((t) => t.name === n)).toBe(true);
  });
});
