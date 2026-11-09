# Browser bench

Runs the same navigation tasks once per approach, with one model, and puts success, model calls, tokens, cost and time side by side. Tasks stop before any password or account change, so runs are safe to repeat.

## Approaches

| Approach            | What the model sees                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `dodo-current`      | dodo today: Playwright MCP's 16 tools; an action returns no page, so the model calls `browser_snapshot` after it  |
| `mcp-inline`        | each action returns the new page snapshot inline                                                                  |
| `mcp-inline-pruned` | as above, and older snapshots in the conversation become one line                                                 |
| `mcp-interactive`   | as above, showing only interactive elements and headings                                                          |
| `mcp-find`          | no page dumps: actions return the page outline; the model searches with `browser_find`                            |
| `agent-browser`     | [agent-browser](https://github.com/vercel-labs/agent-browser): `snapshot -i -c` after each action, pruned history |
| `browser-use`       | [browser-use](https://github.com/browser-use/browser-use) as it ships (its own loop and prompt), through `uv`     |
| `replay`            | no model: replays the Playwright code an earlier successful run executed                                          |

All but `browser-use` share one loop and system prompt (`src/loop.ts`), so differences come from how the page is shown.

## Run it on your Mac

```sh
git pull && pnpm install
pnpm bench:browser --headed                      # your dodo local model, the live tasks
pnpm bench:browser --gemini --reps 3             # gemini-3.8-flash (GEMINI_API_KEY)
pnpm bench:browser --vertex my-gcp-project --model gemini-3.5-flash-lite   # your gcloud login
pnpm bench:browser --tasks vinted-email-login --approaches dodo-current,agent-browser
pnpm bench:browser --tasks-file my-tasks.json    # your own cases
pnpm bench:browser --self-test                   # offline check of the plumbing, no model
```

`--cloud` runs every approach in the browser dodo's GCP worker uses (Playwright's headless Chromium with its anti-detection flag and user agent; it needs `pnpm --filter @dodo/browser-bench exec playwright install chromium chromium-headless-shell` once). It still browses from your own IP, so sites that block datacenter addresses will treat it more kindly than the real worker.

`--interactive` makes `ask_user` ask you in the terminal, so you can solve a CAPTCHA or log in in the window and let the run go on. `browser-use` needs [uv](https://docs.astral.sh/uv/). Results land in `results/` as JSON and a Markdown table; `--help` lists every option.

Cost is computed at gemini-3.8-flash list prices from the tokens the model reports, so runs on a local model still compare on the money scale that matters in production. dodo's real system prompt is much longer than the bench's, so production runs cost more per call than these; the gaps between approaches carry over.
