import type { McpClient } from '@dodo/agent';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import {
  deleteMcpServer,
  type McpDeps,
  refreshMcpServer,
  saveMcpServer,
  toolAccessForRun,
} from './mcp.js';
import type { VaultValues } from './vault.js';

/** In-memory Firestore with the calls the MCP functions make. */
function fakeDb(initial: Record<string, Record<string, unknown>> = {}) {
  const docs = new Map(Object.entries(structuredClone(initial)));
  const write = (path: string, data: Record<string, unknown>, merge: boolean) => {
    const cur = merge ? { ...(docs.get(path) ?? {}) } : {};
    for (const [k, v] of Object.entries(data)) {
      if (v instanceof FieldValue && v.isEqual(FieldValue.delete())) delete cur[k];
      else cur[k] = v;
    }
    docs.set(path, cur);
  };
  const snap = (path: string) => ({
    id: path.split('/').pop() as string,
    exists: docs.has(path),
    data: () => docs.get(path),
    get: (k: string) => docs.get(path)?.[k],
  });
  const db = {
    doc: (path: string) => ({
      get: async () => snap(path),
      set: async (d: Record<string, unknown>, o?: { merge?: boolean }) =>
        write(path, d, !!o?.merge),
      update: async (d: Record<string, unknown>) => write(path, d, true),
      delete: async () => void docs.delete(path),
    }),
    collection: (c: string) => ({
      get: async () => ({
        docs: [...docs.keys()]
          .filter((k) => k.startsWith(`${c}/`) && k.split('/').length === 2)
          .map(snap),
      }),
    }),
  };
  return { db: db as unknown as Firestore, docs };
}

function deps(initial: Record<string, Record<string, unknown>> = {}, fail?: string) {
  const { db, docs } = fakeDb(initial);
  let values: VaultValues = { energy: { password: 'x' } };
  const connected: Array<{ url: string; headers?: Record<string, string> }> = [];
  const d: McpDeps = {
    db,
    secrets: {
      read: async () => structuredClone(values),
      write: async (v) => {
        values = v;
      },
    },
    connect: async (url, headers) => {
      connected.push({ url, headers });
      if (fail) throw new Error(fail);
      return {
        listTools: async () => [
          { name: 'list_issues', description: 'List', inputSchema: { type: 'object' } },
        ],
        callTool: async () => ({ text: '', isError: false }),
        close: async () => {},
      } satisfies McpClient;
    },
    now: () => 5000,
  };
  return { deps: d, docs, connected, values: () => values };
}

describe('remote MCP servers', () => {
  it('saves a server, keeps its header in the secret, and loads its tools', async () => {
    const t = deps();
    await saveMcpServer(t.deps, {
      name: 'Linear',
      slug: 'linear',
      url: 'https://mcp.linear.app/mcp',
      authorization: 'Bearer abc',
    });
    const doc = t.docs.get('mcpServers/linear');
    expect(doc).toMatchObject({ runsOn: 'remote', hasAuth: true, enabled: true });
    expect(JSON.stringify(doc)).not.toContain('abc');
    expect(t.values()['mcp:linear']).toEqual({ authorization: 'Bearer abc' });
    // The vault's own entries are untouched.
    expect(t.values().energy).toEqual({ password: 'x' });
    expect(t.connected[0]?.headers).toEqual({ Authorization: 'Bearer abc' });
    expect(doc?.catalog).toEqual({
      tools: [{ name: 'list_issues', description: 'List', inputSchema: { type: 'object' } }],
      fetchedAt: 5000,
      by: 'cloud',
    });
    await expect(
      saveMcpServer(t.deps, { name: 'Again', slug: 'linear', url: 'https://x.dev/mcp' }),
    ).rejects.toThrow(/exists/);
    await deleteMcpServer(t.deps, 'linear');
    expect(t.docs.has('mcpServers/linear')).toBe(false);
    expect(t.values()['mcp:linear']).toBeUndefined();
  });

  it('records a failed refresh and flags a sign-in problem', async () => {
    const t = deps(
      {
        'mcpServers/x': {
          name: 'X',
          slug: 'x',
          runsOn: 'remote',
          transport: 'http',
          url: 'https://x.dev/mcp',
          createdAt: 1,
          updatedAt: 1,
        },
      },
      'HTTP 401 Unauthorized',
    );
    const r = await refreshMcpServer(t.deps, 'x');
    expect(r.state).toBe('failed');
    expect(t.docs.get('mcpServers/x')?.error).toEqual({
      message: 'HTTP 401 Unauthorized',
      at: 5000,
      needsAuth: true,
    });
  });

  it('asks the Mac to refresh a local server and refuses to delete it from the cloud', async () => {
    const local = {
      name: 'Outlook',
      slug: 'outlook',
      runsOn: 'local',
      transport: 'stdio',
      deviceId: 'mac1',
      createdAt: 1,
      updatedAt: 1,
    };
    const t = deps({ 'mcpServers/mac1-outlook': local, 'devices/mac1': { name: 'MacBook' } });
    const r = await refreshMcpServer(t.deps, 'mac1-outlook');
    expect(r).toMatchObject({ state: 'queued', error: expect.stringMatching(/offline/) });
    expect(t.docs.get('mcpServers/mac1-outlook')?.refreshRequestedAt).toBe(5000);
    expect(t.connected).toEqual([]);
    await expect(deleteMcpServer(t.deps, 'mac1-outlook')).rejects.toThrow(/dodo mcp remove/);
  });
});

describe('toolAccessForRun', () => {
  it('uses the task’s toolsets and hands the run the header of the servers it gets', async () => {
    const t = deps({
      'tasks/t1': { ai: { toolsets: ['ts1'] } },
      'projects/p1': { defaults: { toolsets: ['other'] } },
      'settings/global': {},
      'settings/tools': { disabledBuiltins: ['bash'] },
      'toolsets/ts1': { name: 'Issues', tools: ['mcp:linear:*'], createdAt: 1, updatedAt: 1 },
      'mcpServers/linear': {
        name: 'Linear',
        slug: 'linear',
        runsOn: 'remote',
        transport: 'http',
        url: 'https://mcp.linear.app/mcp',
        createdAt: 1,
        updatedAt: 1,
      },
      'mcpServers/notion': {
        name: 'Notion',
        slug: 'notion',
        runsOn: 'remote',
        transport: 'http',
        url: 'https://mcp.notion.com/mcp',
        createdAt: 1,
        updatedAt: 1,
      },
    });
    await t.deps.secrets.write({ 'mcp:linear': { authorization: 'Bearer abc' } });
    const access = await toolAccessForRun(
      t.deps.db,
      { taskId: 't1', projectId: 'p1', device: 'gcp' },
      t.deps.secrets,
    );
    expect(access.toolsets).toEqual(['Issues']);
    expect(access.mcp).toEqual([
      expect.objectContaining({
        slug: 'linear',
        authorization: 'Bearer abc',
        filter: { disabled: [], only: ['*'] },
      }),
    ]);
    expect(access.builtins.disabled).toEqual(['bash']);
  });
});
