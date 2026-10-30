import {
  NOTION_TEXT_MAX_CHARS,
  NOTION_VERSION,
  NotionConnection,
  type NotionOp,
  notionClaim,
  notionId,
  paths,
  type Run,
  type RunNotionAccess,
} from '@dodo/core';
import { ruleFor } from '@dodo/policy';
import type { Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { googleGranted } from './google-tools.js';
import {
  blocksToMarkdown,
  type Json,
  markdownToBlocks,
  type NotionBlock,
  PropertyError,
  propertiesIn,
  propertiesOut,
  schemaOut,
  titleOf,
} from './notion-markdown.js';
import type { VaultSecretStore } from './vault.js';

/**
 * Notion for the agent (packages/agent/src/notion-tools.ts), run here with the integration
 * token from Settings › Integrations. The token sits in the vault's Secret Manager secret under
 * `integration:notion` (readable by dodo-gateway only); the web app sees `connectors/notion`
 * (workspace, status), and a run only ever gets results. Writes are checked against your
 * approval for the task again here, as Google's are.
 */
export interface NotionDeps {
  db: Firestore;
  secrets: VaultSecretStore;
  fetch?: typeof fetch;
  now?: () => number;
  /** Where the Notion API is (tests point it at a fake). */
  baseUrl?: string;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

const SECRET_KEY = 'integration:notion';
const API = 'https://api.notion.com/v1';
/** Blocks Notion takes per request. */
const BLOCKS_PER_CALL = 100;
/** Requests one page read may make for nested blocks. */
const READ_REQUESTS = 40;

export class NotionApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** A small Notion REST client. */
export class NotionApi {
  constructor(
    private readonly token: string,
    private readonly f: typeof fetch = fetch,
    private readonly base = API,
  ) {}

  async request<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.f(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Notion-Version': NOTION_VERSION,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (res.status === 429 && attempt < 2) {
        const wait = Math.min(10, Number(res.headers.get('retry-after') ?? 1) || 1);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      const data = (await res.json().catch(() => ({}))) as Json;
      if (!res.ok)
        throw new NotionApiError(
          res.status,
          String(data.code ?? 'error'),
          String(data.message ?? `Notion answered ${res.status}`),
        );
      return data as T;
    }
  }
  get = <T = Json>(path: string) => this.request<T>('GET', path);
  post = <T = Json>(path: string, body: unknown) => this.request<T>('POST', path, body);
  patch = <T = Json>(path: string, body: unknown) => this.request<T>('PATCH', path, body);
}

/* ------------------------------ connection ------------------------------ */

async function readToken(deps: Pick<NotionDeps, 'secrets'>): Promise<string | undefined> {
  return (await deps.secrets.read())[SECRET_KEY]?.token;
}

async function connection(db: Firestore): Promise<NotionConnection | undefined> {
  const snap = await db.doc(paths.notion()).get();
  if (!snap.exists) return undefined;
  const p = NotionConnection.safeParse({ id: snap.id, ...snap.data() });
  return p.success ? p.data : undefined;
}

/**
 * Settings › Integrations › Notion: check a token with Notion and keep it, or forget it (null).
 * A token Notion refuses is not kept.
 */
export async function connectNotion(
  deps: NotionDeps,
  token: string | null,
): Promise<{ workspace?: string; bot?: string }> {
  const now = (deps.now ?? Date.now)();
  const ref = deps.db.doc(paths.notion());
  const values = await deps.secrets.read();
  if (token === null) {
    if (SECRET_KEY in values) {
      delete values[SECRET_KEY];
      await deps.secrets.write(values);
    }
    await ref.set({ status: 'disconnected', updatedAt: now });
    deps.log?.('notion disconnected');
    return {};
  }
  let me: Json;
  try {
    me = await new NotionApi(token, deps.fetch, deps.baseUrl).get('/users/me');
  } catch (err) {
    if (err instanceof NotionApiError && err.status === 401)
      throw new HttpsError('invalid-argument', 'Notion does not accept this token. Copy it again.');
    throw new HttpsError('unavailable', `Could not reach Notion: ${(err as Error).message}`);
  }
  const bot = (me.bot ?? {}) as Json;
  const workspace = typeof bot.workspace_name === 'string' ? bot.workspace_name : undefined;
  const name = typeof me.name === 'string' ? me.name : undefined;
  values[SECRET_KEY] = { token };
  await deps.secrets.write(values);
  await ref.set({
    status: 'connected',
    ...(workspace ? { workspace } : {}),
    ...(name ? { bot: name } : {}),
    connectedAt: now,
    updatedAt: now,
  });
  deps.log?.('notion connected', { workspace });
  return { workspace, bot: name };
}

/** What runStart tells a run about Notion: absent when it is not connected. */
export async function notionAccessForRun(db: Firestore): Promise<RunNotionAccess | undefined> {
  const c = await connection(db);
  if (c?.status !== 'connected') return undefined;
  return c.workspace ? { workspace: c.workspace } : {};
}

/* ------------------------------ operations ------------------------------ */

const pageOut = (p: Json) => ({
  id: p.id as string,
  title: titleOf(p),
  url: p.url as string | undefined,
  lastEdited: p.last_edited_time as string | undefined,
  ...(p.in_trash || p.archived ? { inTrash: true } : {}),
});

/** One operation for a run. Throws HttpsError with a message the agent can act on. */
export async function runNotionTool(
  deps: NotionDeps,
  run: Run,
  call: NotionOp,
): Promise<Record<string, unknown>> {
  const c = await connection(deps.db);
  const token = c?.status === 'connected' ? await readToken(deps) : undefined;
  if (!token)
    throw new HttpsError(
      'failed-precondition',
      'Notion is not connected. The user can connect it in Settings › Integrations.',
    );
  const claim = notionClaim(call);
  if (claim.category === 'write' && !(await googleGranted(deps.db, run, claim.tool, claim.key)))
    throw new HttpsError(
      'permission-denied',
      `Not approved for this task: ask for ${ruleFor(claim.tool, claim.key)} first.`,
    );
  const api = new NotionApi(token, deps.fetch, deps.baseUrl);
  try {
    return await dispatch(deps, run, api, call);
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    if (err instanceof PropertyError) throw new HttpsError('invalid-argument', err.message);
    if (err instanceof NotionApiError) {
      if (err.status === 401) {
        await deps.db.doc(paths.notion()).set(
          {
            status: 'error',
            error: 'Notion no longer accepts the token. Paste a new one.',
            updatedAt: (deps.now ?? Date.now)(),
          },
          { merge: true },
        );
        throw new HttpsError(
          'failed-precondition',
          'Notion no longer accepts the token. The user can paste a new one in Settings › Integrations.',
        );
      }
      if (err.status === 404)
        throw new HttpsError(
          'not-found',
          `${err.message} If it exists, the user has to share it with the dodo integration in Notion (••• › Connections).`,
        );
      if (err.status === 403)
        throw new HttpsError(
          'permission-denied',
          `${err.message} The integration may lack that capability (Notion › Integrations › Capabilities).`,
        );
      if (err.status === 429) throw new HttpsError('resource-exhausted', err.message);
      throw new HttpsError(err.status === 400 ? 'invalid-argument' : 'unknown', err.message);
    }
    throw err;
  }
}

async function dispatch(
  deps: NotionDeps,
  run: Run,
  api: NotionApi,
  call: NotionOp,
): Promise<Record<string, unknown>> {
  switch (call.op) {
    case 'notion_search': {
      const r = await api.post<{ results: Json[] }>('/search', {
        ...(call.query ? { query: call.query } : {}),
        ...(call.kind !== 'any'
          ? {
              filter: {
                property: 'object',
                value: call.kind === 'database' ? 'data_source' : 'page',
              },
            }
          : {}),
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
        page_size: call.max,
      });
      return {
        results: r.results.map((o) =>
          o.object === 'page'
            ? { kind: 'page', ...pageOut(o), parent: parentOut(o.parent) }
            : {
                kind: 'database',
                id: o.id,
                title: titleOf(o),
                url: o.url,
                ...(o.parent ? { parent: parentOut(o.parent) } : {}),
              },
        ),
      };
    }
    case 'notion_read_page': {
      const id = notionId(call.page);
      const page = await api.get(`/pages/${id}`);
      const budget = { left: READ_REQUESTS, truncated: false };
      const blocks = await children(api, id, 0, budget);
      let markdown = blocksToMarkdown(blocks);
      const total = markdown.length;
      if (total > NOTION_TEXT_MAX_CHARS) markdown = markdown.slice(0, NOTION_TEXT_MAX_CHARS);
      return {
        page: { ...pageOut(page), parent: parentOut(page.parent) },
        properties: propertiesOut(page.properties),
        content: markdown,
        ...(total > NOTION_TEXT_MAX_CHARS || budget.truncated
          ? { truncated: true, note: 'The page is long; this is its first part.' }
          : {}),
      };
    }
    case 'notion_query_database': {
      const ds = await dataSource(api, call.database);
      const r = await api.post<{ results: Json[]; has_more?: boolean }>(
        `/data_sources/${ds.id}/query`,
        {
          ...(call.filter ? { filter: call.filter } : {}),
          ...(call.sorts ? { sorts: call.sorts } : {}),
          page_size: call.max,
        },
      );
      return {
        database: { id: ds.id, title: titleOf(ds), ...(ds.url ? { url: ds.url } : {}) },
        properties: schemaOut(ds.properties),
        entries: r.results.map((p) => ({ ...pageOut(p), properties: propertiesOut(p.properties) })),
        ...(r.has_more ? { hasMore: true } : {}),
      };
    }
    case 'notion_create_page': {
      const ds = await dataSource(api, call.parent).catch((err) => {
        if (err instanceof NotionApiError && (err.status === 404 || err.status === 400))
          return undefined;
        throw err;
      });
      let parent: Json;
      let properties: Json;
      if (ds) {
        parent = { type: 'data_source_id', data_source_id: ds.id };
        properties = propertiesIn(typesOf(ds.properties), call.properties, call.title, notionId);
      } else {
        if (call.properties && Object.keys(call.properties).length)
          throw new HttpsError(
            'invalid-argument',
            'A page under a page has only a title; properties are for database entries.',
          );
        parent = { type: 'page_id', page_id: notionId(call.parent) };
        properties = propertiesIn({ title: 'title' }, undefined, call.title ?? '', notionId);
      }
      const blocks = call.content ? markdownToBlocks(call.content) : [];
      const page = await api.post('/pages', {
        parent,
        properties,
        ...(blocks.length ? { children: blocks.slice(0, BLOCKS_PER_CALL) } : {}),
      });
      await appendBlocks(api, page.id as string, blocks.slice(BLOCKS_PER_CALL));
      deps.log?.('notion page created', { runId: run.id, pageId: page.id });
      return { ok: true, page: pageOut(page) };
    }
    case 'notion_update_page': {
      const id = notionId(call.page);
      const body: Json = {};
      if (call.title !== undefined || call.properties) {
        const current = await api.get(`/pages/${id}`);
        body.properties = propertiesIn(
          typesOf(current.properties),
          call.properties,
          call.title,
          notionId,
        );
      }
      if (call.trash !== undefined) body.in_trash = call.trash;
      const page = await api.patch(`/pages/${id}`, body);
      deps.log?.('notion page updated', { runId: run.id, pageId: id, trash: call.trash });
      return { ok: true, page: pageOut(page), properties: propertiesOut(page.properties) };
    }
    case 'notion_append': {
      const id = notionId(call.page);
      const blocks = markdownToBlocks(call.content);
      if (!blocks.length) throw new HttpsError('invalid-argument', 'Nothing to add');
      await appendBlocks(api, id, blocks);
      deps.log?.('notion page appended', { runId: run.id, pageId: id, blocks: blocks.length });
      return { ok: true, added: blocks.length };
    }
  }
}

const typesOf = (props: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries((props ?? {}) as Record<string, Json>).map(([k, p]) => [k, String(p.type)]),
  );

function parentOut(parent: unknown) {
  const p = (parent ?? {}) as Json;
  switch (p.type) {
    case 'page_id':
      return { page: p.page_id };
    case 'database_id':
      return { database: p.database_id };
    case 'data_source_id':
      return { database: p.data_source_id };
    case 'workspace':
      return 'workspace';
    default:
      return undefined;
  }
}

/**
 * The data source a database ref means: a data source id as it is, or a database (id or
 * link, as Notion's own UI gives) by its first data source.
 */
async function dataSource(api: NotionApi, ref: string): Promise<Json> {
  const id = notionId(ref);
  try {
    return await api.get(`/data_sources/${id}`);
  } catch (err) {
    if (!(err instanceof NotionApiError) || (err.status !== 404 && err.status !== 400)) throw err;
  }
  const db = await api.get(`/databases/${id}`);
  const first = (db.data_sources as Array<{ id: string }> | undefined)?.[0];
  if (!first) throw new NotionApiError(404, 'object_not_found', 'That database has no data');
  const ds = await api.get(`/data_sources/${first.id}`);
  return { ...ds, url: ds.url ?? db.url };
}

async function children(
  api: NotionApi,
  id: string,
  depth: number,
  budget: { left: number; truncated: boolean },
): Promise<NotionBlock[]> {
  const out: NotionBlock[] = [];
  let cursor: string | undefined;
  do {
    if (budget.left-- <= 0) {
      budget.truncated = true;
      break;
    }
    const r = await api.get<{ results: NotionBlock[]; has_more: boolean; next_cursor?: string }>(
      `/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`,
    );
    out.push(...r.results);
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  for (const b of out) {
    // Child pages and databases are listed, not read; the agent opens them by id.
    if (!b.has_children || b.type === 'child_page' || b.type === 'child_database') continue;
    if (depth >= 3) {
      budget.truncated = true;
      continue;
    }
    b.children = await children(api, b.id, depth + 1, budget);
  }
  return out;
}

async function appendBlocks(api: NotionApi, id: string, blocks: Json[]): Promise<void> {
  for (let i = 0; i < blocks.length; i += BLOCKS_PER_CALL)
    await api.patch(`/blocks/${id}/children`, { children: blocks.slice(i, i + BLOCKS_PER_CALL) });
}
