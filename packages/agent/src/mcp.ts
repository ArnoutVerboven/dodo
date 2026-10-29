import {
  type ImageUpload,
  type McpToolInfo,
  mcpToolName,
  type RunMcpServer,
  toolAllowed,
} from '@dodo/core';
import { z } from 'zod';
import { define, type PolicyClaim, type ToolDef } from './tools.js';

/**
 * MCP servers you added in the Tools view. The worker connects to each one the run may use
 * (remote servers directly, a Mac's local servers through its daemon) and offers their tools
 * as `mcp__<server>__<tool>`. Every call is a policy decision first: a tool the server marks
 * read-only runs freely, anything else asks, with `Mcp(<server>:<tool>)` as the rule
 * "Allow always" adds.
 */

export interface McpClient {
  listTools(): Promise<McpToolInfo[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean; images?: ImageUpload[] }>;
  close(): Promise<void>;
}

const MAX_RESULT = 20_000;

/** Connect to an MCP server over streamable HTTP, with optional headers (Authorization). */
export async function connectMcp(
  url: string,
  opts: { headers?: Record<string, string>; name?: string } = {},
): Promise<McpClient> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/streamableHttp.js'
  );
  const client = new Client({ name: opts.name ?? 'dodo-worker', version: '0.1.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: opts.headers ? { headers: opts.headers } : undefined,
    }),
  );
  return wrapClient(client);
}

type SdkClient = {
  listTools(params?: { cursor?: string }): Promise<{
    tools: Array<{
      name: string;
      title?: string;
      description?: string;
      inputSchema: unknown;
      annotations?: unknown;
    }>;
    nextCursor?: string;
  }>;
  callTool(req: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
};

/** The SDK client behind our small interface; also used by the daemon for stdio servers. */
export function wrapClient(client: SdkClient): McpClient {
  return {
    async listTools() {
      const out: McpToolInfo[] = [];
      let cursor: string | undefined;
      // Paged; a server with hundreds of tools is cut at 500.
      for (let page = 0; page < 20 && out.length < 500; page++) {
        const r = await client.listTools(cursor ? { cursor } : undefined);
        for (const t of r.tools) {
          out.push({
            name: t.name,
            ...(t.title ? { title: t.title } : {}),
            description: t.description ?? '',
            inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object' },
            ...(t.annotations ? { annotations: t.annotations as McpToolInfo['annotations'] } : {}),
          });
        }
        cursor = r.nextCursor;
        if (!cursor) break;
      }
      return out;
    },
    async callTool(name, args) {
      const res = (await client.callTool({ name, arguments: args })) as {
        content?: Array<{
          type: string;
          text?: string;
          data?: string;
          mimeType?: string;
          resource?: { text?: string; uri?: string };
        }>;
        structuredContent?: unknown;
        isError?: boolean;
      };
      const content = res.content ?? [];
      let text = content
        .map((c) =>
          c.type === 'text'
            ? (c.text ?? '')
            : c.type === 'resource'
              ? (c.resource?.text ?? `[resource ${c.resource?.uri ?? ''}]`)
              : `[${c.type}]`,
        )
        .join('\n');
      if (!text && res.structuredContent !== undefined)
        text = JSON.stringify(res.structuredContent);
      const images = content
        .filter((c) => c.type === 'image' && c.data && c.mimeType)
        .map((c) => ({ data: c.data, mimeType: c.mimeType }) as ImageUpload);
      return { text, isError: res.isError === true, ...(images.length ? { images } : {}) };
    },
    async close() {
      await client.close().catch(() => {});
    },
  };
}

/** What a call of an MCP tool is for the policy engine. */
export function mcpClaim(slug: string, tool: McpToolInfo): PolicyClaim {
  return {
    tool: 'Mcp',
    key: `${slug}:${tool.name}`,
    category: tool.annotations?.readOnlyHint === true ? 'sandbox' : 'outbound',
  };
}

/** The tool definitions for one server, filtered to what the run may use. */
export async function mcpTools(
  client: McpClient,
  server: Pick<RunMcpServer, 'slug' | 'name' | 'filter'>,
  taken: Set<string> = new Set(),
): Promise<ToolDef[]> {
  const tools: ToolDef[] = [];
  for (const t of await client.listTools()) {
    if (!toolAllowed(server.filter, t.name)) continue;
    const name = mcpToolName(server.slug, t.name);
    if (taken.has(name)) continue;
    taken.add(name);
    const summary = (t.description || t.title || t.name).trim();
    tools.push(
      define({
        name,
        description: `[${server.name}] ${summary}`.slice(0, 4000),
        schema: z.record(z.string(), z.unknown()),
        jsonSchema: t.inputSchema,
        policy: () => mcpClaim(server.slug, t),
        async execute(args, ctx) {
          const res = await client.callTool(t.name, args);
          let text =
            res.text.length > MAX_RESULT ? `${res.text.slice(0, MAX_RESULT)}\n…(cut)` : res.text;
          if (ctx.secrets) text = ctx.secrets.redact(text);
          return { result: res.isError ? { error: text } : { text } };
        },
      }),
    );
  }
  return tools;
}
