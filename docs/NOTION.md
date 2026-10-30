# dodo — Notion

The task agent can search and read your Notion pages and databases, and add to them with your approval. It uses a Notion **internal integration** that you create once and share pages with; the token is pasted in **Settings › Integrations › Notion**.

## Setup (once, about two minutes)

1. Open [notion.so/profile/integrations](https://www.notion.so/profile/integrations) and click **New integration**. Name it `dodo`, pick your workspace, type **Internal**.
2. Under **Capabilities**, tick **Read content**, **Update content** and **Insert content**. User information is not needed (leave it at "No user information"). Save.
3. Copy the **Internal Integration Secret** (`ntn_…`) and paste it in dodo under **Settings › Integrations › Notion**, then **Connect**. dodo checks it with Notion and shows the workspace name.
4. Share what the agent may use: on a page or database in Notion, **••• › Connections › dodo**. Subpages and database entries follow their parent, so sharing a few top-level pages (or a teamspace's root pages) is usually enough. The agent sees nothing you did not share.

To stop: **Disconnect** in Settings forgets the token; to revoke it in Notion too, delete the integration there. A new token (after rotating it in Notion) goes in with **New token**.

## Tools

A **Notion** group in Tools › Built-in (switchable, pickable in toolsets). The run only gets it when Notion is connected.

| Tool                    | Does                                                                                   | Approval                                  |
| ----------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------- |
| `notion_search`         | Pages and databases by title, most recently edited first                               | free                                      |
| `notion_read_page`      | A page's properties and content as Markdown (nested blocks included)                   | free                                      |
| `notion_query_database` | A database's properties (names, types, options) and entries, with Notion filters/sorts | free                                      |
| `notion_create_page`    | A page under a page, or an entry in a database; content from Markdown                  | `Notion(create:<parent id>)`              |
| `notion_update_page`    | Title or properties of a page or entry; move to trash and back                         | `Notion(edit:<id>)`, `Notion(trash:<id>)` |
| `notion_append_to_page` | Markdown added to the end of a page                                                    | `Notion(edit:<id>)`                       |

Pages and databases can be given by id or by their Notion link. Properties take plain values (`"Status": "Done"`, `"Due": "2026-11-02"`, `"Tags": ["a", "b"]`) that the control plane turns into Notion's form from the database schema; Notion's own property objects work too. Created pages are attached to the task as links.

"Always allow" on an approval card adds the rule for that one parent or page, e.g. `Notion(create:<your reading list database>)`, so the agent can keep adding entries there without asking. `Notion(create:*)` in Settings › Allowed actions allows all new pages.

## How it works

- The token never reaches a run. It is stored in the vault's Secret Manager secret (`dodo-vault`, key `integration:notion`, readable by `dodo-gateway` only). Firestore's `connectors/notion` holds only the status and workspace name (owner-readable, server-written).
- A run sends one operation at a time to the `notionTool` callable (`apps/functions/src/notion.ts`), which checks the run identity, checks that a write was approved for this task (same check as Google's), calls the Notion API (version `2025-09-03`) and returns the result. A database id is resolved to its first data source.
- Markdown ↔ blocks (`apps/functions/src/notion-markdown.ts`): headings, paragraphs, bulleted/numbered/to-do lists (two nesting levels per write), quotes, code, dividers, bold/italic/strike/code/links. Reading also renders callouts, toggles, tables, files and child pages (by id). A page read stops at about 60,000 characters or 40 block requests.
- A token Notion no longer accepts marks the connection broken; the card says to paste a new one.

## Why not Notion's hosted MCP server

The Tools view can already add remote MCP servers, and Notion runs one at `https://mcp.notion.com/mcp`. It was not used as the default because:

- **Auth.** The hosted server takes either an interactive OAuth login (short-lived tokens with refresh, which dodo's remote MCP support does not do: it sends one fixed `Authorization` header), or an "MCP token" that needs a Notion **Business or Enterprise** plan. An internal integration token works on every plan and does not expire.
- **Approvals.** dodo's MCP tools ask for everything not marked read-only and the rule is per tool (`Mcp(notion:notion-update-page)`), not per page. The built-in tools ask per page or database and the control plane enforces the approval again before it writes.
- **Size.** The hosted server offers some 70 tools (calendar, agents, meeting notes…); six focused tools keep the prompt small.

If your workspace is on Business or Enterprise and you want the hosted server's extra tools anyway: create an MCP token in Notion's developer portal and add a remote server in **Tools › MCP servers** with URL `https://mcp.notion.com/mcp` and header `Bearer <token>`. Both can be on at once; toolsets decide which a task gets.
