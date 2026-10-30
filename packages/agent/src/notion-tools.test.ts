import type { NotionOp } from '@dodo/core';
import { PolicyEngine } from '@dodo/policy';
import { describe, expect, it } from 'vitest';
import { runAgent } from './loop.js';
import { notionTools } from './notion-tools.js';
import { FakeControlPlane, MemoryTaskStore, MemoryTrace, sampleTask } from './testing.js';
import { taskTools } from './tools.js';

const PAGE = 'https://www.notion.so/me/Trip-plan-1a2b3c4d5e6f40718293a4b5c6d7e8f9?pvs=4';
const PAGE_ID = '1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9';

async function setup(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
  respond: (c: NotionOp) => Record<string, unknown>,
  allow: string[] = [],
) {
  const control = new FakeControlPlane([
    ...calls.map((c) => ({ calls: [c] })),
    { calls: [{ name: 'finish', args: { outcome: 'done' } }] },
  ]);
  const store = new MemoryTaskStore(sampleTask());
  const sent: NotionOp[] = [];
  const tools = notionTools(
    async (c) => {
      sent.push(c);
      return respond(c);
    },
    { workspace: 'Home' },
  );
  const run = () =>
    runAgent(
      {
        runId: 'r1',
        task: store.task,
        project: undefined,
        model: 'gemini-2.5-flash',
        trigger: 'new',
        session: [],
      },
      {
        control,
        store,
        trace: new MemoryTrace(),
        tools: [...taskTools, ...tools],
        policy: new PolicyEngine({ profile: 'agent-decides', allow, deny: [] }),
        heartbeatMs: 0,
        notionWorkspace: 'Home',
      },
    );
  return { control, store, sent, run };
}

describe('notion tools', () => {
  it('searches without asking and says in the prompt what it has', async () => {
    const { control, sent, run } = await setup(
      [{ name: 'notion_search', args: { query: 'trip' } }],
      () => ({ results: [{ kind: 'page', id: PAGE_ID, title: 'Trip plan' }] }),
    );
    expect((await run()).reason).toBe('finished');
    expect(sent).toEqual([{ op: 'notion_search', query: 'trip', kind: 'any', max: 15 }]);
    const system = JSON.stringify(control.requests[0]?.systemInstruction ?? '');
    expect(system).toContain('notion_search');
    expect(system).toContain('workspace \\"Home\\"');
  });

  it('reads a page given as a link without asking', async () => {
    const { sent, run } = await setup([{ name: 'notion_read_page', args: { page: PAGE } }], () => ({
      content: '# Trip',
    }));
    expect((await run()).reason).toBe('finished');
    expect(sent).toEqual([{ op: 'notion_read_page', page: PAGE }]);
  });

  it('asks before creating a page, keyed by the parent id', async () => {
    const { control, sent, run } = await setup(
      [{ name: 'notion_create_page', args: { parent: PAGE, title: 'Packing list' } }],
      () => ({ ok: true }),
    );
    expect((await run()).reason).toBe('waiting_input');
    expect(sent).toEqual([]);
    expect(control.inputRequests[0]?.suggestedRule).toBe(`Notion(create:${PAGE_ID})`);
  });

  it('creates with an allow rule and attaches the link', async () => {
    const { store, run } = await setup(
      [{ name: 'notion_create_page', args: { parent: PAGE_ID, title: 'Packing list' } }],
      () => ({ ok: true, page: { title: 'Packing list', url: 'https://www.notion.so/x' } }),
      [`Notion(create:${PAGE_ID})`],
    );
    expect((await run()).reason).toBe('finished');
    expect(store.artifacts[0]).toMatchObject({
      kind: 'link',
      name: 'Notion: Packing list',
      url: 'https://www.notion.so/x',
    });
  });

  it('asks for trash separately from edits', async () => {
    const { control, run } = await setup(
      [{ name: 'notion_update_page', args: { page: PAGE_ID, trash: true } }],
      () => ({ ok: true }),
      [`Notion(edit:${PAGE_ID})`],
    );
    expect((await run()).reason).toBe('waiting_input');
    expect(control.inputRequests[0]?.suggestedRule).toBe(`Notion(trash:${PAGE_ID})`);
  });

  it('asks before appending to a page', async () => {
    const { control, run } = await setup(
      [{ name: 'notion_append_to_page', args: { page: PAGE_ID, content: '- milk' } }],
      () => ({ ok: true }),
    );
    expect((await run()).reason).toBe('waiting_input');
    expect(control.inputRequests[0]?.suggestedRule).toBe(`Notion(edit:${PAGE_ID})`);
  });
});
