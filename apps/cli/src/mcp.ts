import { randomBytes } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { looksLikeAuthError, type McpToolInfo, paths } from '@dodo/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  type Firestore,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';

/**
 * Local MCP servers: the ones you add on this Mac (`dodo mcp add`), for tools that live here,
 * such as Outlook or a local database. They are configured on the Mac on purpose: the cloud
 * can turn a server or its tools off, but it can never make your Mac run a new command.
 *
 * The daemon runs them outside the sandbox, as you, so they can reach their own APIs and keep
 * their sign-in where they always do (Keychain, their config folder); env values you give them
 * stay in ~/.dodo/config.json. The worker inside the sandbox reaches them through one small
 * MCP proxy on localhost, behind a random path, that only forwards listing and calling tools.
 */

export interface LocalMcpConfig {
  /** Lowercase short name: tool names (`mcp__outlook__…`) and rules (`Mcp(outlook:…)`). */
  slug: string;
  name?: string;
  /** stdio: the command and its arguments. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Or a server already listening on this Mac. */
  url?: string;
  headers?: Record<string, string>;
}

export const serverId = (deviceId: string, slug: string) => `${deviceId}-${slug}`;
const displayName = (s: LocalMcpConfig) => s.name ?? s.slug;

type Log = (message: string) => void;

/** Lines a server prints while it waits for you to sign in (device code, browser consent). */
export const SIGN_IN =
  /devicelogin|device code|verification|enter (the )?code|sign[ -]?in|log[ -]?in|authori[sz]e|consent/i;

/** Connect to one local server; its stderr goes to `onStderr` (the daemon log). */
export async function connectLocal(
  s: LocalMcpConfig,
  onStderr: (line: string) => void,
): Promise<Client> {
  const client = new Client({ name: 'dodo-daemon', version: '0.1.0' });
  if (s.url) {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(s.url), {
        requestInit: s.headers ? { headers: s.headers } : undefined,
      }),
    );
    return client;
  }
  if (!s.command) throw new Error(`${s.slug} has neither a command nor a url`);
  const transport = new StdioClientTransport({
    command: s.command,
    args: s.args ?? [],
    // launchd gives the daemon a short PATH; keep the one you set up the daemon with.
    env: { ...getDefaultEnvironment(), PATH: process.env.PATH ?? '', ...(s.env ?? {}) },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) if (line.trim()) onStderr(line.trim());
  });
  await client.connect(transport);
  return client;
}

/** All of a server's tools (paged), in the shape the Tools view caches. */
export async function listAll(client: Client): Promise<McpToolInfo[]> {
  const out: McpToolInfo[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20 && out.length < 500; page++) {
    const r = await client.listTools(cursor ? { cursor } : undefined);
    for (const t of r.tools)
      out.push(
        JSON.parse(
          JSON.stringify({
            name: t.name,
            title: t.title,
            description: t.description ?? '',
            inputSchema: t.inputSchema,
            annotations: t.annotations,
          }),
        ),
      );
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  return out;
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms)),
  ]);

const CONNECT_TIMEOUT_MS = 60_000;

/** The server documents this Mac owns, kept in step with its config. */
export async function syncServers(db: Firestore, deviceId: string, servers: LocalMcpConfig[]) {
  const mine = await getDocs(
    query(collection(db, paths.mcpServers()), where('deviceId', '==', deviceId)),
  );
  const wanted = new Set(servers.map((s) => serverId(deviceId, s.slug)));
  for (const d of mine.docs) if (!wanted.has(d.id)) await deleteDoc(d.ref);
  const now = Date.now();
  for (const s of servers) {
    const ref = doc(db, paths.mcpServer(serverId(deviceId, s.slug)));
    const fields = JSON.parse(
      JSON.stringify({
        name: displayName(s),
        transport: s.url ? 'http' : 'stdio',
        url: s.url,
        command: s.command,
        args: s.args ?? [],
        updatedAt: now,
      }),
    );
    const existing = mine.docs.find((d) => d.id === ref.id);
    if (existing) await updateDoc(ref, fields);
    else
      await setDoc(ref, {
        ...fields,
        slug: s.slug,
        runsOn: 'local',
        deviceId,
        enabled: true,
        disabledTools: [],
        createdAt: now,
      });
  }
}

/** Fetch one server's tools and write them, or the error, to its document. */
export async function refreshServer(
  db: Firestore,
  deviceId: string,
  s: LocalMcpConfig,
  client: Client,
): Promise<number> {
  const ref = doc(db, paths.mcpServer(serverId(deviceId, s.slug)));
  const tools = await withTimeout(listAll(client), CONNECT_TIMEOUT_MS, 'Listing tools');
  const snap = await getDoc(ref);
  const info = client.getServerVersion();
  await updateDoc(ref, {
    catalog: JSON.parse(
      JSON.stringify({
        tools,
        fetchedAt: Date.now(),
        by: `mac:${deviceId}`,
        server: info ? { name: info.name, version: info.version } : undefined,
      }),
    ),
    ...(snap.get('error') ? { error: deleteField() } : {}),
    updatedAt: Date.now(),
  });
  return tools.length;
}

export async function reportError(
  db: Firestore,
  deviceId: string,
  slug: string,
  message: string,
  needsAuth = looksLikeAuthError(message),
) {
  try {
    await updateDoc(doc(db, paths.mcpServer(serverId(deviceId, slug))), {
      error: { message: message.slice(0, 500), at: Date.now(), needsAuth },
      updatedAt: Date.now(),
    });
  } catch {
    // Best effort: the daemon log has the line too.
  }
}

/**
 * The daemon's side: the servers stay running between runs (a sign-in or a warm cache
 * survives), refresh requests from the Tools view are answered, and each run gets the URLs of
 * the enabled ones.
 */
export class LocalMcpHost {
  private clients = new Map<string, Promise<Client>>();
  private enabled = new Map<string, boolean>();
  private http?: { server: HttpServer; port: number; token: string };
  private unsubscribe?: () => void;
  private refreshing = new Set<string>();

  constructor(
    private db: Firestore,
    private deviceId: string,
    private servers: LocalMcpConfig[],
    private log: Log,
  ) {}

  get count() {
    return this.servers.length;
  }

  async start(): Promise<void> {
    if (this.servers.length === 0) {
      await syncServers(this.db, this.deviceId, []).catch(() => undefined);
      return;
    }
    await syncServers(this.db, this.deviceId, this.servers);
    this.unsubscribe = onSnapshot(
      query(collection(this.db, paths.mcpServers()), where('deviceId', '==', this.deviceId)),
      (snap) => {
        for (const d of snap.docs) {
          const s = this.servers.find((x) => serverId(this.deviceId, x.slug) === d.id);
          if (!s) continue;
          this.enabled.set(s.slug, d.get('enabled') !== false);
          const asked = Number(d.get('refreshRequestedAt') ?? 0);
          const fetched = Number(d.get('catalog.fetchedAt') ?? 0);
          const failed = Number(d.get('error.at') ?? 0);
          // Never fetched, or Refresh pressed since the last answer.
          if ((!d.get('catalog') && !failed) || asked > Math.max(fetched, failed))
            void this.refresh(s);
        }
      },
      (err) => this.log(`mcp: cannot watch servers: ${err.message}`),
    );
  }

  private client(s: LocalMcpConfig): Promise<Client> {
    let c = this.clients.get(s.slug);
    if (!c) {
      c = withTimeout(
        connectLocal(s, (line) => {
          this.log(`mcp ${s.slug}: ${line}`);
          // A server waiting for a sign-in prints how: show that line in the Tools view.
          if (SIGN_IN.test(line) && /https?:\/\//.test(line))
            void reportError(this.db, this.deviceId, s.slug, `Sign-in needed: ${line}`, true);
        }),
        CONNECT_TIMEOUT_MS,
        'Starting the server',
      ).then((client) => {
        client.onclose = () => {
          if (this.clients.get(s.slug) === c) this.clients.delete(s.slug);
        };
        return client;
      });
      c.catch(() => this.clients.delete(s.slug));
      this.clients.set(s.slug, c);
    }
    return c;
  }

  async refresh(s: LocalMcpConfig): Promise<void> {
    if (this.refreshing.has(s.slug)) return;
    this.refreshing.add(s.slug);
    try {
      const n = await refreshServer(this.db, this.deviceId, s, await this.client(s));
      this.log(`mcp ${s.slug}: ${n} tools`);
    } catch (err) {
      const message = (err as Error).message;
      this.log(`mcp ${s.slug}: ${message}`);
      await reportError(this.db, this.deviceId, s.slug, message);
    } finally {
      this.refreshing.delete(s.slug);
    }
  }

  /** The proxy endpoints for one run: enabled servers only, keyed by server id. */
  async urlsForRun(): Promise<Record<string, string>> {
    const live = this.servers.filter((s) => this.enabled.get(s.slug) !== false);
    if (live.length === 0) return {};
    const http = await this.listen();
    // Start them now so the worker's first call does not wait on `npx`.
    await Promise.all(live.map((s) => this.client(s).catch(() => undefined)));
    return Object.fromEntries(
      live.map((s) => [
        serverId(this.deviceId, s.slug),
        `http://localhost:${http.port}/${http.token}/${s.slug}`,
      ]),
    );
  }

  private async listen() {
    if (this.http) return this.http;
    const token = randomBytes(18).toString('base64url');
    const server = createServer((req, res) => {
      const [, key, slug] = (req.url ?? '').split('?')[0]?.split('/') ?? [];
      const s = this.servers.find((x) => x.slug === slug);
      if (key !== token || !s || this.enabled.get(s.slug) === false) {
        res.writeHead(404).end();
        return;
      }
      void this.forward(s, req, res).catch((err) => {
        this.log(`mcp ${s.slug}: proxy failed: ${(err as Error).message}`);
        if (!res.headersSent) res.writeHead(502).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
    this.http = { server, port: (server.address() as AddressInfo).port, token };
    return this.http;
  }

  /** One request from the worker, answered by a stateless MCP server that asks upstream. */
  private async forward(
    s: LocalMcpConfig,
    req: Parameters<StreamableHTTPServerTransport['handleRequest']>[0],
    res: Parameters<StreamableHTTPServerTransport['handleRequest']>[1],
  ) {
    const upstream = await this.client(s);
    const proxy = new Server(
      { name: `dodo-${s.slug}`, version: '0.1.0' },
      { capabilities: { tools: {} } },
    );
    proxy.setRequestHandler(ListToolsRequestSchema, (r) => upstream.listTools(r.params));
    proxy.setRequestHandler(CallToolRequestSchema, async (r) => {
      try {
        return (await upstream.callTool(r.params)) as never;
      } catch (err) {
        const message = (err as Error).message;
        if (looksLikeAuthError(message))
          await reportError(this.db, this.deviceId, s.slug, message, true);
        throw err;
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void proxy.close();
    });
    await proxy.connect(transport);
    await transport.handleRequest(req, res);
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    await Promise.all(
      [...this.clients.values()].map((c) => c.then((x) => x.close()).catch(() => undefined)),
    );
    this.clients.clear();
    await new Promise<void>((resolve) =>
      this.http ? this.http.server.close(() => resolve()) : resolve(),
    );
    this.http = undefined;
  }
}
