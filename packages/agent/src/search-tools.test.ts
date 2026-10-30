import { PolicyEngine } from '@dodo/policy';
import { describe, expect, it } from 'vitest';
import { GatewayBudgetError } from './control-plane.js';
import { runAgent } from './loop.js';
import { webSearchTool } from './search-tools.js';
import { FakeControlPlane, MemoryTaskStore, MemoryTrace, sampleTask } from './testing.js';
import { taskTools } from './tools.js';

function setup(search: Parameters<typeof webSearchTool>[0], profile = 'agent-decides' as const) {
  const control = new FakeControlPlane([
    { calls: [{ name: 'web_search', args: { query: 'opening hours Atomium' } }] },
    { calls: [{ name: 'finish', args: { outcome: 'done' } }] },
  ]);
  const store = new MemoryTaskStore(sampleTask());
  const trace = new MemoryTrace();
  const policy = new PolicyEngine({ profile, allow: [], deny: [] });
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
        trace,
        tools: [...taskTools, webSearchTool(search)],
        policy,
        heartbeatMs: 0,
      },
    );
  return { control, trace, run };
}

describe('web_search', () => {
  it('returns the answer and sources, and puts its cost on the trace', async () => {
    const queries: string[] = [];
    const { control, trace, run } = setup(async (q) => {
      queries.push(q);
      return {
        answer: 'Open daily 10:00–18:00.',
        sources: [{ title: 'atomium.be', url: 'https://atomium.be/hours' }],
        queries: [q],
        cost: 14_100,
        remaining: 900_000,
      };
    });
    const result = await run();
    expect(result.reason).toBe('finished');
    expect(queries).toEqual(['opening hours Atomium']);
    const done = trace.events.find(
      (e) => e.type === 'tool_result' && (e.data as { name?: string }).name === 'web_search',
    );
    expect(done?.cost).toBe(14_100);
    const response = control.requests[1]?.contents
      .flatMap((c) => c.parts)
      .find((p) => p.functionResponse?.name === 'web_search')?.functionResponse?.response;
    expect(response).toMatchObject({
      answer: 'Open daily 10:00–18:00.',
      sources: [{ url: 'https://atomium.be/hours' }],
    });
  });

  it('ends the run for a top-up when the budget refuses the search', async () => {
    const { control, run } = setup(async () => {
      throw new GatewayBudgetError("budget_exhausted(task): the task's budget has €0.01 left");
    });
    const result = await run();
    expect(result.reason).toBe('budget_exhausted');
    expect(control.finishes[0]?.error).toContain('budget_exhausted(task)');
    // The call has its answer in the stored session, so a resume continues cleanly.
    const last = control.finishes[0]?.session.at(-1);
    expect(last?.parts[0]?.functionResponse?.name).toBe('web_search');
  });

  it('asks first in the untrusted profile', async () => {
    let ran = false;
    const { control, run } = setup(async () => {
      ran = true;
      throw new Error('not reached');
    }, 'untrusted' as 'agent-decides');
    const result = await run();
    expect(result.reason).toBe('waiting_input');
    expect(ran).toBe(false);
    expect(control.inputRequests[0]?.suggestedRule).toBe('WebSearch(opening hours Atomium)');
  });
});
