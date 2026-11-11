import { FREE_SEARCH_HOST, type SearchResponse, type SearchSource } from '@dodo/core';
import { z } from 'zod';
import { htmlToText } from './exec-tools.js';
import { define, type ToolDef } from './tools.js';

/**
 * Web search (#13): Gemini grounding with Google Search, run by the control plane so it is
 * billed under the same GCP project and cap, needs no key, and is paid per query from the
 * task's budget (TOOL_PRICES.web_search, #15). The worker only sends the query. On a Mac the
 * search runs free instead, from the user's own connection (duckDuckGoSearch), and the paid
 * search is only the fallback when that fails (freeFirst).
 *
 * A search is a read: it runs freely under the agent-decides profile and asks in the
 * untrusted one (`WebSearch(<query>)`, or `WebSearch(*)` for every search).
 */
export type WebSearch = (query: string) => Promise<SearchResponse>;

const PAID_DESCRIPTION =
  'Search the web (Google) and get a short answer with its sources. Use it to find facts, current information, prices, opening hours, documentation or the right page to open; then http_fetch or the browser to read a source in full. One focused question per call; each search costs about €0.01–0.07 from the task budget, so do not repeat a search that already answered.';

const FREE_DESCRIPTION =
  'Search the web and get the top results (title, link and snippet each). Use it to find facts, current information, prices, opening hours, documentation or the right page to open; then http_fetch or the browser to read a result in full. Searches on this machine are free, so search again with other words when the results miss; use search terms rather than long questions.';

/** `free`: the search runs on this machine at no cost (freeFirst over duckDuckGoSearch). */
export function webSearchTool(search: WebSearch, opts: { free?: boolean } = {}): ToolDef {
  return define({
    name: 'web_search',
    description: opts.free ? FREE_DESCRIPTION : PAID_DESCRIPTION,
    schema: z.object({
      query: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe(
          'What to find, as a question or search terms. Include place and date if they matter.',
        ),
    }),
    policy: ({ query }) => ({ tool: 'WebSearch', key: query, category: 'sandbox' }),
    async execute({ query }) {
      const r = await search(query);
      return {
        result: {
          answer: r.answer,
          sources: r.sources,
          ...(r.sources.length === 0 ? { note: 'No web sources were found for this query.' } : {}),
        },
        cost: r.cost,
      };
    },
  }) as ToolDef;
}

const MAX_RESULTS = 8;
const SEARCH_TIMEOUT_MS = 15_000;
// DuckDuckGo turns away clients that do not look like a browser.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * A free web search on a Mac: DuckDuckGo's HTML results page, fetched from the user's own
 * connection, no key and no cost. The results come back as the answer text (title, snippet,
 * link) and as sources. Throws when DuckDuckGo refuses (a bot check) or does not answer.
 */
export function duckDuckGoSearch(fetchImpl: typeof fetch = fetch): WebSearch {
  return async (query) => {
    const res = await fetchImpl(`https://${FREE_SEARCH_HOST}/html/`, {
      method: 'POST',
      body: new URLSearchParams({ q: query }).toString(),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': BROWSER_UA,
        accept: 'text/html',
        'accept-language': 'en;q=0.9',
      },
    });
    const html = await res.text();
    if (!res.ok || res.status === 202) throw new Error(`DuckDuckGo answered ${res.status}`);
    const results = parseDuckDuckGo(html);
    if (results.length === 0 && /anomaly|captcha|challenge/i.test(html))
      throw new Error('DuckDuckGo asked for a bot check');
    const answer = results.length
      ? results
          .map((r, i) => `${i + 1}. ${r.title}\n${r.snippet ? `   ${r.snippet}\n` : ''}   ${r.url}`)
          .join('\n')
      : '';
    return {
      answer,
      sources: results.map(({ title, url }) => ({ title, url })),
      queries: [query],
      cost: 0,
      remaining: 0,
    };
  };
}

export interface FreeSearchResult extends SearchSource {
  snippet: string;
}

/** The organic results on DuckDuckGo's HTML page, in order; ads and its own links left out. */
export function parseDuckDuckGo(html: string): FreeSearchResult[] {
  const results: FreeSearchResult[] = [];
  let current: FreeSearchResult | undefined;
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = m[1] ?? '';
    const cls = /\bclass="([^"]*)"/i.exec(attrs)?.[1] ?? '';
    const href = /\bhref="([^"]*)"/i.exec(attrs)?.[1] ?? '';
    if (/\bresult__a\b/.test(cls)) {
      current = undefined;
      const url = resultUrl(href);
      if (!url || results.length >= MAX_RESULTS) continue;
      current = { title: htmlToText(m[2] ?? ''), url, snippet: '' };
      if (current.title) results.push(current);
    } else if (/\bresult__snippet\b/.test(cls) && current) {
      current.snippet = htmlToText(m[2] ?? '').replace(/\s+/g, ' ');
    }
  }
  return results;
}

/** The target of a result link: DuckDuckGo wraps it in /l/?uddg=<url>; its own pages and ads are dropped. */
function resultUrl(href: string): string | undefined {
  const raw = href.replace(/&amp;/g, '&');
  try {
    const u = new URL(raw.startsWith('//') ? `https:${raw}` : raw, 'https://duckduckgo.com');
    const target = u.hostname.endsWith('duckduckgo.com') ? u.searchParams.get('uddg') : u.href;
    if (!target) return undefined;
    const t = new URL(target);
    if (t.protocol !== 'https:' && t.protocol !== 'http:') return undefined;
    if (t.hostname.endsWith('duckduckgo.com')) return undefined;
    return t.href;
  } catch {
    return undefined;
  }
}

/**
 * The free search first; the paid one only when it fails or finds nothing, so the agent still
 * gets an answer when DuckDuckGo blocks this machine for a while.
 */
export function freeFirst(free: WebSearch, paid: WebSearch, log?: (m: string) => void): WebSearch {
  return async (query) => {
    try {
      const r = await free(query);
      if (r.sources.length > 0) return r;
      log?.('free web search found nothing; using the paid search');
    } catch (err) {
      log?.(`free web search failed (${(err as Error).message}); using the paid search`);
    }
    return paid(query);
  };
}
