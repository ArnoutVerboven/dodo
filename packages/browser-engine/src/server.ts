import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { type AgentBrowserTools, TOOLS } from './tools.js';

/** An MCP server over the tools: the worker connects to it like to Playwright MCP. */
export function mcpServer(tools: AgentBrowserTools): Server {
  const server = new Server(
    { name: 'dodo-agent-browser', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const res = await tools.call(
      req.params.name,
      (req.params.arguments ?? {}) as Record<string, unknown>,
    );
    return res as unknown as Record<string, unknown> & { content: unknown[] };
  });
  return server;
}

export interface HttpMcp {
  /** The endpoint, on localhost, behind a random path. */
  url: string;
  close(): Promise<void>;
}

/**
 * The same server over streamable HTTP on a free localhost port (the Mac daemon's, for the
 * sandboxed worker). Each connection gets its own MCP session on the one browser. The path
 * carries a random token and only localhost Host headers are taken, so neither another local
 * program guessing the port nor a web page rebinding a name to 127.0.0.1 reaches it.
 */
export async function serveHttp(tools: AgentBrowserTools): Promise<HttpMcp> {
  const token = randomBytes(16).toString('hex');
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  let port = 0;
  const http: HttpServer = createServer(async (req, res) => {
    try {
      if (!req.url?.startsWith(`/${token}/mcp`)) {
        res.writeHead(404).end();
        return;
      }
      const sid = req.headers['mcp-session-id'];
      let transport = typeof sid === 'string' ? sessions.get(sid) : undefined;
      if (!transport) {
        if (req.method !== 'POST' || sid) {
          res.writeHead(sid ? 404 : 400).end();
          return;
        }
        const t: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableDnsRebindingProtection: true,
          allowedHosts: [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`],
          onsessioninitialized: (id) => {
            sessions.set(id, t);
          },
        });
        t.onclose = () => {
          if (t.sessionId) sessions.delete(t.sessionId);
        };
        await mcpServer(tools).connect(t);
        transport = t;
      }
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500).end(String((err as Error).message));
    }
  });
  await new Promise<void>((resolve) => http.listen(0, 'localhost', resolve));
  port = (http.address() as AddressInfo).port;
  return {
    url: `http://localhost:${port}/${token}/mcp`,
    async close() {
      for (const t of sessions.values()) await t.close().catch(() => {});
      sessions.clear();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
