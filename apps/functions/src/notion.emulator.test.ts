import { randomUUID } from 'node:crypto';
import { paths, type Run } from '@dodo/core';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { afterAll, describe, expect, it } from 'vitest';
import { connectNotion, notionAccessForRun, runNotionTool } from './notion.js';
import type { VaultValues } from './vault.js';

const enabled = !!process.env.FIRESTORE_EMULATOR_HOST;
const app = enabled ? initializeApp({ projectId: 'demo-dodo' }, 'notion-test') : undefined;
const db = app ? getFirestore(app) : undefined;

afterAll(async () => {
  if (app) await deleteApp(app);
});

const PAGE = '1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9';
const DB = '2b3c4d5e-6f70-4182-93a4-b5c6d7e8f901';
const DS = '3c4d5e6f-7081-4293-a4b5-c6d7e8f90123';

const memorySecrets = () => {
  let values: VaultValues = {};
  return {
    read: async () => structuredClone(values),
    write: async (v: VaultValues) => {
      values = structuredClone(v);
    },
    peek: () => values,
  };
};

/** A fake Notion API; records every call. */
function fakeNotion(route: (method: string, path: string, body: unknown) => unknown) {
  const calls: Array<{ method: string; path: string; body?: unknown; auth?: string }> = [];
  const f = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const path = url.pathname.replace(/^\/v1/, '') + url.search;
    calls.push({
      method,
      path,
      body,
      auth: (init.headers as Record<string, string>).Authorization,
    });
    const out = route(method, path, body);
    return out instanceof Response ? out : Response.json(out);
  }) as typeof fetch;
  return { f, calls };
}

const missing = () =>
  Response.json({ code: 'object_not_found', message: 'Could not find it.' }, { status: 404 });

const title = (t: string) => ({ type: 'title', title: [{ plain_text: t }] });

async function setup(route: Parameters<typeof fakeNotion>[0], allowRules: string[] = []) {
  const d = db as NonNullable<typeof db>;
  const notion = fakeNotion((m, p, b) =>
    p === '/users/me' ? { name: 'dodo', bot: { workspace_name: 'Home' } } : route(m, p, b),
  );
  const secrets = memorySecrets();
  const deps = { db: d, secrets, fetch: notion.f, baseUrl: 'https://api.test/v1' };
  await connectNotion(deps, 'ntn_abcdefghijklmnopqrstuvwxyz');
  const taskId = `t-${randomUUID()}`;
  await d.doc(paths.task(taskId)).set({ title: 'Plan trip', allowRules });
  const run = { id: `r-${randomUUID()}`, taskId } as Run;
  return { d, deps, run, notion, secrets };
}

describe.skipIf(!enabled)('notionTool', () => {
  it('keeps a checked token server-side and tells runs the workspace', async () => {
    const { d, secrets, notion } = await setup(() => ({}));
    expect(secrets.peek()['integration:notion']).toEqual({
      token: 'ntn_abcdefghijklmnopqrstuvwxyz',
    });
    expect(notion.calls[0]?.auth).toBe('Bearer ntn_abcdefghijklmnopqrstuvwxyz');
    const doc = (await d.doc(paths.notion()).get()).data();
    expect(doc).toMatchObject({ status: 'connected', workspace: 'Home', bot: 'dodo' });
    expect(JSON.stringify(doc)).not.toContain('ntn_');
    expect(await notionAccessForRun(d)).toEqual({ workspace: 'Home' });
  });

  it('reads a page as properties and Markdown, nested blocks included', async () => {
    const { deps, run } = await setup((_m, p) => {
      if (p === `/pages/${PAGE}`)
        return {
          object: 'page',
          id: PAGE,
          url: 'https://www.notion.so/Trip',
          parent: { type: 'workspace' },
          properties: { title: title('Trip') },
        };
      if (p.startsWith(`/blocks/${PAGE}/children`))
        return {
          has_more: false,
          results: [
            {
              id: 'b1',
              type: 'bulleted_list_item',
              has_children: true,
              bulleted_list_item: { rich_text: [{ plain_text: 'Pack' }] },
            },
          ],
        };
      if (p.startsWith('/blocks/b1/children'))
        return {
          has_more: false,
          results: [
            {
              id: 'b2',
              type: 'to_do',
              to_do: { rich_text: [{ plain_text: 'socks' }], checked: false },
            },
          ],
        };
      return missing();
    });
    const r = await runNotionTool(deps, run, {
      op: 'notion_read_page',
      page: `https://www.notion.so/me/Trip-${PAGE.replace(/-/g, '')}`,
    });
    expect(r).toMatchObject({
      page: { id: PAGE, title: 'Trip', parent: 'workspace' },
      properties: { title: 'Trip' },
      content: '- Pack\n  - [ ] socks',
    });
  });

  it('queries a database by its id through its first data source', async () => {
    const { deps, run, notion } = await setup((m, p) => {
      if (p === `/data_sources/${DB}`) return missing();
      if (p === `/databases/${DB}`)
        return { id: DB, url: 'https://www.notion.so/db', data_sources: [{ id: DS }] };
      if (p === `/data_sources/${DS}`)
        return {
          id: DS,
          title: [{ plain_text: 'Trips' }],
          properties: { Name: { type: 'title', title: {} } },
        };
      if (m === 'POST' && p === `/data_sources/${DS}/query`)
        return { results: [{ id: PAGE, properties: { Name: title('Paris') } }], has_more: true };
      return missing();
    });
    const r = await runNotionTool(deps, run, {
      op: 'notion_query_database',
      database: DB,
      filter: { property: 'Name', title: { contains: 'P' } },
      max: 5,
    });
    expect(r).toMatchObject({
      database: { id: DS, title: 'Trips', url: 'https://www.notion.so/db' },
      properties: { Name: 'title' },
      entries: [{ id: PAGE, properties: { Name: 'Paris' } }],
      hasMore: true,
    });
    expect(notion.calls.at(-1)?.body).toEqual({
      filter: { property: 'Name', title: { contains: 'P' } },
      page_size: 5,
    });
  });

  it('refuses a write without approval, before calling Notion', async () => {
    const { deps, run, notion } = await setup(() => ({}));
    const before = notion.calls.length;
    await expect(
      runNotionTool(deps, run, { op: 'notion_append', page: PAGE, content: '- milk' }),
    ).rejects.toThrow(/Notion\(edit:/);
    expect(notion.calls.length).toBe(before);
  });

  it('adds a database entry with plain property values once allowed', async () => {
    const { deps, run, notion } = await setup(
      (m, p) => {
        if (p === `/data_sources/${DS}`)
          return {
            id: DS,
            properties: {
              Name: { type: 'title', title: {} },
              Status: { type: 'status', status: {} },
            },
          };
        if (m === 'POST' && p === '/pages')
          return {
            id: PAGE,
            url: 'https://www.notion.so/new',
            properties: { Name: title('Rome') },
          };
        return missing();
      },
      [`Notion(create:${DS})`],
    );
    const r = await runNotionTool(deps, run, {
      op: 'notion_create_page',
      parent: DS,
      title: 'Rome',
      properties: { Status: 'Planned' },
      content: '## Ideas\n- Colosseum',
    });
    expect(r).toMatchObject({ ok: true, page: { id: PAGE, title: 'Rome' } });
    const created = notion.calls.find((c) => c.path === '/pages')?.body as Record<string, unknown>;
    expect(created.parent).toEqual({ type: 'data_source_id', data_source_id: DS });
    expect(created.properties).toEqual({
      Status: { status: { name: 'Planned' } },
      Name: { title: [{ type: 'text', text: { content: 'Rome' } }] },
    });
    expect((created.children as Array<{ type: string }>).map((c) => c.type)).toEqual([
      'heading_2',
      'bulleted_list_item',
    ]);
  });

  it('marks the connection broken when Notion stops accepting the token', async () => {
    const { d, deps, run } = await setup(() =>
      Response.json({ code: 'unauthorized', message: 'API token is invalid.' }, { status: 401 }),
    );
    await expect(
      runNotionTool(deps, run, { op: 'notion_search', query: '', kind: 'any', max: 5 }),
    ).rejects.toThrow(/paste a new one/);
    expect((await d.doc(paths.notion()).get()).get('status')).toBe('error');
    expect(await notionAccessForRun(d)).toBeUndefined();
  });

  it('forgets the token on disconnect', async () => {
    const { d, deps, secrets } = await setup(() => ({}));
    await connectNotion(deps, null);
    expect(secrets.peek()['integration:notion']).toBeUndefined();
    expect((await d.doc(paths.notion()).get()).get('status')).toBe('disconnected');
  });
});
