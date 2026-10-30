import type { SearchResponse } from '@dodo/core';
import { z } from 'zod';
import { define, type ToolDef } from './tools.js';

/**
 * Web search (#13): Gemini grounding with Google Search, run by the control plane so it is
 * billed under the same GCP project and cap, needs no key, and is paid per query from the
 * task's budget (TOOL_PRICES.web_search, #15). The worker only sends the query.
 *
 * A search is a read: it runs freely under the agent-decides profile and asks in the
 * untrusted one (`WebSearch(<query>)`, or `WebSearch(*)` for every search).
 */
export type WebSearch = (query: string) => Promise<SearchResponse>;

export function webSearchTool(search: WebSearch): ToolDef {
  return define({
    name: 'web_search',
    description:
      'Search the web (Google) and get a short answer with its sources. Use it to find facts, current information, prices, opening hours, documentation or the right page to open; then http_fetch or the browser to read a source in full. One focused question per call; each search costs about €0.01–0.07 from the task budget, so do not repeat a search that already answered.',
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
