import type { McpClient } from '@dodo/agent';
import {
  isDeviceOnline,
  looksLikeAuthError,
  McpServer,
  type McpServerSaveRequest,
  paths,
  type Run,
  type RunToolAccess,
  resolveToolAccess,
  ToolSettings,
  Toolset,
} from '@dodo/core';
import { hostMatches } from '@dodo/policy';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { VaultSecretStore } from './vault.js';

/**
 * The Tools view's server side: remote MCP servers (add, remove, fetch their tool list) and
 * which tools a run gets. A remote server's Authorization header lives in the same Secret
 * Manager secret as the vault, under `mcp:{id}`; it goes to a run (which calls the server) and
 * never back to the browser. Local servers belong to a Mac: added there, fetched there.
 */

export interface McpDeps {
  db: Firestore;
  secrets: VaultSecretStore;
  /** Connect to a remote server (the MCP SDK in production, a fake in tests). */
  connect: (url: string, headers?: Record<string, string>) => Promise<McpClient>;
  now?: () => number;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

export class McpError extends Error {
  constructor(
    readonly code: 'invalid-argument' | 'not-found' | 'failed-precondition' | 'already-exists',
    message: string,
  ) {
    super(message);
  }
}

const secretKey = (id: string) => `mcp:${id}`;
const REFRESH_TIMEOUT_MS = 20_000;

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms)),
  ]);

async function authHeader(deps: Pick<McpDeps, 'secrets'>, id: string) {
  const v = (await deps.secrets.read())[secretKey(id)]?.authorization;
  return v ? { Authorization: v } : undefined;
}

/** Add or change a remote server; fetches its tools right away. */
export async function saveMcpServer(
  deps: McpDeps,
  req: McpServerSaveRequest,
): Promise<{ id: string }> {
  const now = (deps.now ?? Date.now)();
  const id = req.id ?? req.slug;
  if (req.id && req.id !== req.slug)
    throw new McpError('invalid-argument', 'The short name of a server cannot change');
  const ref = deps.db.doc(paths.mcpServer(id));
  const existing = await ref.get();
  if (!req.id && existing.exists)
    throw new McpError('already-exists', `A server named ${req.slug} exists already`);
  if (existing.exists && existing.get('runsOn') === 'local')
    throw new McpError('failed-precondition', 'Local servers are changed on their Mac');

  let hasAuth = existing.exists ? existing.get('hasAuth') === true : false;
  if (req.authorization !== undefined && req.authorization !== '') {
    const values = await deps.secrets.read();
    if (req.authorization === null) delete values[secretKey(id)];
    else values[secretKey(id)] = { authorization: req.authorization };
    await deps.secrets.write(values);
    hasAuth = req.authorization !== null;
  }
  await ref.set(
    {
      name: req.name,
      slug: req.slug,
      runsOn: 'remote',
      transport: 'http',
      url: req.url,
      hasAuth,
      ...(existing.exists ? {} : { enabled: true, disabledTools: [], createdAt: now }),
      updatedAt: now,
    },
    { merge: true },
  );
  deps.log?.('mcp server saved', { id, hasAuth });
  await refreshMcpServer(deps, id).catch(() => undefined);
  return { id };
}

export async function deleteMcpServer(deps: McpDeps, id: string): Promise<void> {
  const ref = deps.db.doc(paths.mcpServer(id));
  const snap = await ref.get();
  if (snap.exists && snap.get('runsOn') === 'local')
    throw new McpError(
      'failed-precondition',
      `Remove it on the Mac: pnpm dodo mcp remove ${String(snap.get('slug'))}`,
    );
  const values = await deps.secrets.read();
  if (secretKey(id) in values) {
    delete values[secretKey(id)];
    await deps.secrets.write(values);
  }
  await ref.delete();
  // Toolsets that named it keep their refs: adding it back under the same name restores them.
  deps.log?.('mcp server deleted', { id });
}

/**
 * Fetch a server's tool list into its document. A remote server is asked from here; for a
 * local one this only records the request, and its Mac does it (when it is online).
 */
export async function refreshMcpServer(
  deps: McpDeps,
  id: string,
): Promise<{ state: 'fetched' | 'failed' | 'queued'; tools?: number; error?: string }> {
  const now = (deps.now ?? Date.now)();
  const ref = deps.db.doc(paths.mcpServer(id));
  const snap = await ref.get();
  if (!snap.exists) throw new McpError('not-found', `No server ${id}`);
  const server = McpServer.parse({ id, ...snap.data() });
  if (server.runsOn === 'local') {
    await ref.update({ refreshRequestedAt: now });
    const device = server.deviceId
      ? (await deps.db.doc(paths.device(server.deviceId)).get()).data()
      : undefined;
    return {
      state: 'queued',
      ...(isDeviceOnline(device?.lastSeen as number | undefined, now)
        ? {}
        : { error: 'Its Mac is offline; the tools refresh when it is back.' }),
    };
  }
  if (!server.url) throw new McpError('failed-precondition', 'The server has no URL');
  let client: McpClient | undefined;
  try {
    client = await withTimeout(
      deps.connect(server.url, await authHeader(deps, id)),
      REFRESH_TIMEOUT_MS,
      'Connecting',
    );
    const tools = await withTimeout(client.listTools(), REFRESH_TIMEOUT_MS, 'Listing tools');
    await ref.update({
      catalog: JSON.parse(JSON.stringify({ tools, fetchedAt: now, by: 'cloud' })),
      error: FieldValue.delete(),
      updatedAt: now,
    });
    deps.log?.('mcp tools fetched', { id, tools: tools.length });
    return { state: 'fetched', tools: tools.length };
  } catch (err) {
    const message = String((err as Error).message ?? err).slice(0, 500);
    await ref.update({
      error: { message, at: now, needsAuth: looksLikeAuthError(message) },
      updatedAt: now,
    });
    deps.log?.('mcp refresh failed', { id, message });
    return { state: 'failed', error: message };
  } finally {
    await client?.close();
  }
}

/** The toolsets in effect for a run: the task's, else the project's, else the global default. */
function toolsetIds(
  task: Record<string, unknown>,
  project: Record<string, unknown> | undefined,
  settings: Record<string, unknown>,
): string[] {
  const layers = [
    (settings.defaults as Record<string, unknown> | undefined)?.toolsets,
    (project?.defaults as Record<string, unknown> | undefined)?.toolsets,
    (task.ai as Record<string, unknown> | undefined)?.toolsets,
  ];
  let ids: unknown;
  for (const l of layers) if (l !== undefined) ids = l;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * The tools a run gets (packages/core resolveToolAccess), with remote servers' headers when
 * `secrets` is given. Decided here, by trusted code, from the current settings.
 */
export async function toolAccessForRun(
  db: Firestore,
  run: Pick<Run, 'taskId' | 'projectId' | 'device'>,
  secrets?: Pick<VaultSecretStore, 'read'>,
): Promise<RunToolAccess> {
  const [task, project, settings, toolSettings, servers] = await Promise.all([
    db.doc(paths.task(run.taskId)).get(),
    run.projectId ? db.doc(paths.project(run.projectId)).get() : undefined,
    db.doc(paths.settings()).get(),
    db.doc(paths.toolSettings()).get(),
    db.collection(paths.mcpServers()).get(),
  ]);
  const ids = toolsetIds(task.data() ?? {}, project?.data(), settings.data() ?? {});
  const toolsets = (await Promise.all(ids.map((id) => db.doc(paths.toolset(id)).get()))).flatMap(
    (s) => {
      const p = s.exists ? Toolset.safeParse({ id: s.id, ...s.data() }) : undefined;
      return p?.success ? [p.data] : [];
    },
  );
  const access = resolveToolAccess({
    settings: ToolSettings.parse(toolSettings.data() ?? {}),
    servers: servers.docs.flatMap((d) => {
      const p = McpServer.safeParse({ id: d.id, ...d.data() });
      return p.success ? [p.data] : [];
    }),
    toolsets,
    device: run.device,
  });
  if (!secrets) return access;
  const values = access.mcp.some((s) => s.runsOn === 'remote') ? await secrets.read() : {};
  return {
    ...access,
    mcp: access.mcp.map((s) => {
      const authorization = values[secretKey(s.id)]?.authorization;
      return authorization ? { ...s, authorization } : s;
    }),
  };
}

/** The Mac sandbox lets a run reach the remote MCP servers it was given, and nothing more. */
export async function mcpHostAllowed(
  db: Firestore,
  run: Pick<Run, 'taskId' | 'projectId' | 'device'>,
  host: string,
): Promise<string | undefined> {
  const access = await toolAccessForRun(db, run);
  const server = access.mcp.find(
    (s) => s.runsOn === 'remote' && s.url && hostMatches(host, [new URL(s.url).hostname]),
  );
  return server ? `MCP server ${server.name}` : undefined;
}
