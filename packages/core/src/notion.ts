import { z } from 'zod';
import { Timestamp } from './model.js';

/**
 * Notion for the task agent: search, read pages and databases, create and change pages, on a
 * Notion internal integration token pasted in Settings › Integrations (docs/NOTION.md). The
 * token is kept in Secret Manager next to the vault values and never leaves the control plane:
 * a run sends one operation at a time to the `notionTool` callable, which runs it and returns
 * the result. The integration only sees the pages and databases you share with it in Notion.
 */

/** The Notion API version the control plane speaks (databases hold data sources). */
export const NOTION_VERSION = '2025-09-03';

/** The most text notion_read_page returns to the model. */
export const NOTION_TEXT_MAX_CHARS = 60_000;

/** The connection as the web app sees it, in `connectors/notion` (written by the functions). */
export const NotionConnection = z.object({
  id: z.string(),
  status: z.enum(['connected', 'error', 'disconnected']),
  workspace: z.string().optional(),
  /** The integration's own name in Notion, e.g. "dodo". */
  bot: z.string().optional(),
  error: z.string().optional(),
  connectedAt: Timestamp.optional(),
  updatedAt: Timestamp,
});
export type NotionConnection = z.infer<typeof NotionConnection>;

/** Settings › Integrations › Notion: a token to check and keep, or null to disconnect. */
export const NotionConnectRequest = z.object({
  token: z
    .string()
    .trim()
    .regex(/^(secret_|ntn_)[A-Za-z0-9]{20,100}$/, 'A Notion integration token (ntn_… or secret_…)')
    .nullable(),
});
export type NotionConnectRequest = z.infer<typeof NotionConnectRequest>;

/**
 * A page, database or data source id in either form, or a Notion link that ends in one:
 * returns the dashed UUID, or the input trimmed when it holds none.
 */
export function notionId(ref: string): string {
  const s = ref.trim();
  const dashed = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(s);
  if (dashed) return (dashed[1] as string).toLowerCase();
  // A link: the id is the last 32 hex characters of the path, before ?v= or #.
  const pathPart = s.split(/[?#]/)[0] as string;
  const all = [...pathPart.matchAll(/([0-9a-f]{32})/gi)];
  const hex = all.at(-1)?.[1];
  if (!hex) return s;
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const Ref = z.string().trim().min(1).max(500);
const Markdown = z.string().max(100_000);
/**
 * Property values by property name: plain values (text, number, true/false, a date, an option
 * name, a list of option names) are turned into Notion's form from the database's schema; an
 * object is passed to Notion as it is.
 */
const Properties = z.record(z.string().max(200), z.unknown());

/** One operation of the notionTool callable. */
export const NotionOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('notion_search'),
    query: z.string().trim().max(300).default(''),
    kind: z.enum(['page', 'database', 'any']).default('any'),
    max: z.number().int().min(1).max(50).default(15),
  }),
  z.object({ op: z.literal('notion_read_page'), page: Ref }),
  z.object({
    op: z.literal('notion_query_database'),
    database: Ref,
    filter: z.record(z.string(), z.unknown()).optional(),
    sorts: z.array(z.record(z.string(), z.unknown())).max(10).optional(),
    max: z.number().int().min(1).max(100).default(25),
  }),
  z.object({
    op: z.literal('notion_create_page'),
    /** A page (the new page goes under it) or a database (the new page is an entry in it). */
    parent: Ref,
    title: z.string().trim().max(2000).optional(),
    properties: Properties.optional(),
    content: Markdown.optional(),
  }),
  z.object({
    op: z.literal('notion_update_page'),
    page: Ref,
    title: z.string().trim().max(2000).optional(),
    properties: Properties.optional(),
    /** true moves the page to the trash, false takes it back out. */
    trash: z.boolean().optional(),
  }),
  z.object({ op: z.literal('notion_append'), page: Ref, content: Markdown.min(1) }),
]);
export type NotionOp = z.infer<typeof NotionOp>;
export type NotionOpName = NotionOp['op'];

export const NotionToolRequest = z.object({ runId: z.string(), call: NotionOp });
export type NotionToolRequest = z.infer<typeof NotionToolRequest>;

/** Notion as a run sees it (runStart): absent when Notion is not connected. */
export interface RunNotionAccess {
  workspace?: string;
}

/**
 * What a Notion operation means for the policy engine, shared by the agent (which asks) and
 * the control plane (which checks a write was approved before it runs it).
 *   search and reading pages and databases       sandbox (free under agent-decides)
 *   a new page or entry, changing or trashing one  write (asks): Notion(create:<parent>),
 *                                                  Notion(edit:<page>), Notion(trash:<page>)
 */
export function notionClaim(call: NotionOp): {
  tool: 'Notion';
  key: string;
  category: 'sandbox' | 'write';
} {
  const tool = 'Notion' as const;
  switch (call.op) {
    case 'notion_search':
      return { tool, key: `search:${call.query}`, category: 'sandbox' };
    case 'notion_read_page':
      return { tool, key: `read:${notionId(call.page)}`, category: 'sandbox' };
    case 'notion_query_database':
      return { tool, key: `read:${notionId(call.database)}`, category: 'sandbox' };
    case 'notion_create_page':
      return { tool, key: `create:${notionId(call.parent)}`, category: 'write' };
    case 'notion_update_page':
      return {
        tool,
        key: `${call.trash ? 'trash' : 'edit'}:${notionId(call.page)}`,
        category: 'write',
      };
    case 'notion_append':
      return { tool, key: `edit:${notionId(call.page)}`, category: 'write' };
  }
}
