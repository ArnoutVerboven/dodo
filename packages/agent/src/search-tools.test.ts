import { PolicyEngine } from '@dodo/policy';
import { describe, expect, it, vi } from 'vitest';
import { GatewayBudgetError } from './control-plane.js';
import { runAgent } from './loop.js';
import {
  bingRssSearch,
  duckDuckGoSearch,
  freeSearch,
  parseBingRss,
  parseDuckDuckGo,
  webSearchTool,
} from './search-tools.js';
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

const DDG_PAGE = `
<div class="result results_links results_links_deep result--ad">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=x.com&amp;u3=1">Ad title</a></h2>
  <a class="result__snippet" href="https://duckduckgo.com/y.js?u3=1">Buy now</a>
</div>
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.booking.com%2Fgenius.html&amp;rut=abc">Booking.com <b>Genius</b> loyalty programme</a></h2>
  <a class="result__url" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.booking.com%2Fgenius.html">www.booking.com/genius.html</a>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.booking.com%2Fgenius.html">Check your <b>Genius</b> level &amp; benefits in your account.</a>
</div>
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://example.org/help">Help page</a></h2>
</div>`;

const page = (body: string, status = 200) =>
  (async () =>
    new Response(body, { status, headers: { 'content-type': 'text/html' } })) as typeof fetch;

describe('free web search (Mac)', () => {
  it('reads the organic results from DuckDuckGo and skips ads', () => {
    expect(parseDuckDuckGo(DDG_PAGE)).toEqual([
      {
        title: 'Booking.com Genius loyalty programme',
        url: 'https://www.booking.com/genius.html',
        snippet: 'Check your Genius level & benefits in your account.',
      },
      { title: 'Help page', url: 'https://example.org/help', snippet: '' },
    ]);
  });

  it('posts the query and returns the results at no cost', async () => {
    let sent: { url: string; body: string } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent = { url, body: String(init.body) };
      return new Response(DDG_PAGE, { status: 200 });
    }) as unknown as typeof fetch;
    const r = await duckDuckGoSearch(fetchImpl)('booking genius status');
    expect(sent).toEqual({
      url: 'https://html.duckduckgo.com/html/',
      body: 'q=booking+genius+status',
    });
    expect(r.cost).toBe(0);
    expect(r.sources.map((s) => s.url)).toEqual([
      'https://www.booking.com/genius.html',
      'https://example.org/help',
    ]);
    expect(r.answer).toContain('1. Booking.com Genius loyalty programme');
    expect(r.answer).toContain('https://example.org/help');
  });

  it('throws on a bot check or an error status', async () => {
    await expect(duckDuckGoSearch(page('<div class="anomaly-modal">', 200))('q')).rejects.toThrow(
      /bot check/,
    );
    await expect(duckDuckGoSearch(page('', 202))('q')).rejects.toThrow(/202/);
  });

  it('reads Bing RSS results', async () => {
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Bing</title>
      <item><title>Mijn AH | Albert Heijn</title><link>https://www.ah.be/mijn</link><description>Log in op je account &amp; bekijk je bonus.</description></item>
      <item><title>Bad</title><link>javascript:alert(1)</link><description>x</description></item>
    </channel></rss>`;
    expect(parseBingRss(rss)).toEqual([
      {
        title: 'Mijn AH | Albert Heijn',
        url: 'https://www.ah.be/mijn',
        snippet: 'Log in op je account & bekijk je bonus.',
      },
    ]);
    const r = await bingRssSearch(page(rss))('ah.be login');
    expect(r.cost).toBe(0);
    expect(r.sources).toEqual([{ title: 'Mijn AH | Albert Heijn', url: 'https://www.ah.be/mijn' }]);
    await expect(bingRssSearch(page('<html>captcha</html>'))('q')).rejects.toThrow(/Bing/);
  });

  it('tries the next free engine and never pays', async () => {
    const second = vi.fn(duckDuckGoSearch(page(DDG_PAGE)));
    const r = await freeSearch([duckDuckGoSearch(page('', 403)), second])('a');
    expect(second).toHaveBeenCalledOnce();
    expect(r.cost).toBe(0);
    expect(r.sources).toHaveLength(2);

    const logs: string[] = [];
    const none = await freeSearch(
      [duckDuckGoSearch(page('', 403)), duckDuckGoSearch(page('<html></html>'))],
      (m) => logs.push(m),
    )('albert heijn');
    expect(none.cost).toBe(0);
    expect(none.sources).toEqual([]);
    expect(none.answer).toContain('403; no results');
    expect(none.answer).toContain('https://duckduckgo.com/?q=albert+heijn');
    expect(logs[0]).toContain('403');
  });

  it('tells the model searches are free', () => {
    const search = async () => ({ answer: '', sources: [], queries: [], cost: 0, remaining: 0 });
    expect(webSearchTool(search, { free: true }).description).toContain('free');
    expect(webSearchTool(search).description).toContain('costs about');
  });
});
