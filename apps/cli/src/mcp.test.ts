import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Firestore } from 'firebase/firestore';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalMcpHost, SIGN_IN } from './mcp.js';

/** A tiny stdio MCP server: one tool that echoes, and a sign-in line on stderr. */
function fixture(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dodo-mcp-'));
  const file = path.join(dir, 'server.mjs');
  // vitest has no import.meta.resolve: the SDK's ESM build, by path.
  const sdk = new URL('../node_modules/@modelcontextprotocol/sdk/dist/esm/', import.meta.url).href;
  const server = `${sdk}server/index.js`;
  const stdio = `${sdk}server/stdio.js`;
  const types = `${sdk}types.js`;
  writeFileSync(
    file,
    `import { Server } from '${server}';
import { StdioServerTransport } from '${stdio}';
import { CallToolRequestSchema, ListToolsRequestSchema } from '${types}';
const s = new Server({ name: 'fixture', version: '1.2.3' }, { capabilities: { tools: {} } });
s.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'echo', description: 'Echo back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, annotations: { readOnlyHint: true } }],
}));
s.setRequestHandler(CallToolRequestSchema, async (r) => ({
  content: [{ type: 'text', text: 'echo: ' + r.params.arguments.text + ' ' + (process.env.FIXTURE_ENV ?? '') }],
}));
process.stderr.write('To sign in, open https://microsoft.com/devicelogin and enter the code ABC123\\n');
await s.connect(new StdioServerTransport());
`,
  );
  return file;
}

describe('LocalMcpHost', () => {
  const host = new LocalMcpHost(
    {} as Firestore,
    'mac1',
    [
      {
        slug: 'echo',
        command: process.execPath,
        args: [fixture()],
        env: { FIXTURE_ENV: 'from-mac' },
      },
    ],
    () => {},
  );
  afterAll(() => host.stop());

  it('serves a stdio server to the worker through a localhost proxy behind a token', async () => {
    const urls = await host.urlsForRun();
    const url = urls['mac1-echo'];
    expect(url).toMatch(/^http:\/\/localhost:\d+\/[\w-]+\/echo$/);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url as string)));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo']);
    expect(tools[0]?.annotations?.readOnlyHint).toBe(true);
    const res = (await client.callTool({ name: 'echo', arguments: { text: 'hi' } })) as {
      content: Array<{ text: string }>;
    };
    expect(res.content[0]?.text).toBe('echo: hi from-mac');
    await client.close();

    // Without the token in the path there is nothing there.
    const wrong = (url as string).replace(/\/[\w-]+\/echo$/, '/nope/echo');
    expect((await fetch(wrong, { method: 'POST' })).status).toBe(404);
  });

  it('recognises a sign-in prompt a server prints', () => {
    expect(
      SIGN_IN.test('To sign in, open https://microsoft.com/devicelogin and enter the code ABC123'),
    ).toBe(true);
    expect(SIGN_IN.test('listening on stdio')).toBe(false);
  });
});
