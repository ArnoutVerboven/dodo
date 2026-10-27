# dodo — Roadmap

Each phase ends with an exit criterion: a task you actually ran. Nothing that can spend money ships before the budget guardrails, and no tool that reaches outside the task ships before the policy engine.

## Phase 0 — Plan

- Architecture, roadmap, setup checklist; decisions recorded in [ARCHITECTURE.md](ARCHITECTURE.md).
- Architecture review addressed (honest cost guarantees, model gateway, deterministic ask for egress, credential scoping, lease fencing).

## Phase 1 — Board and money safety net

- Monorepo, domain model, CostGate + ledger with Firestore emulator tests.
- Web app: sign-in (owner only), board, task page, projects, budget page, settings with manual halt.
- Security rules + tests. CI and keyless deploy.
- `infra/bootstrap.sh`: lifetime 50 EUR budget, kill-switch and deployer accounts, Workload Identity Federation.
- Kill switch: halt, cancel running executions, detach billing.
- **Exit:** the app is live on Firebase Hosting, you created a task from your phone, and `infra/test-kill-switch.sh` detached billing for real and re-linked it.

The UI breadth (kanban, projects, budget page) was built before this plan was reviewed. It only depends on the Firestore model, so a phase 2 redesign would not throw it away.

## Phase 2 — First agent runs (remote, task tools only)

**Status (2026-10-26): built and merged (#3).** Deviations from the plan below: the gateway is not streaming yet; Cloud Monitoring alert policies are not created yet (they need one more bootstrap run); the exit criterion (ledger vs. Vertex console) waits for the first real smoke test.

Agents in this phase can only use the task tools (summary, status, message, ask, artifacts, finish). **No bash, HTTP or browser** until the policy engine exists.

- Own agent loop behind `AgentRuntime` (decided 2026-10-25; ADK is a later optional adapter).
- Control plane callables: `gateway.generate` (streaming; countTokens, tiered prices, thinking budget, rate governor 2 EUR/hour, stable prefix for implicit caching), `run.heartbeat` (lease + infra metering), `run.finish`.
- Per-run Firebase identity minted by the dispatcher and revoked at run end; Firestore rules for `run:*` writes with lease-generation check; worker SA with no roles.
- Idempotent dispatcher; one active run per task; comment steering at the next model call; trace archival to Storage at run end.
- Cloud Monitoring alert policies (token count, Cloud Run time) into the kill switch.
- Cloud Run Job worker: `max-retries = 0`, timeout from budget, aborts when the heartbeat says `halted` or `interrupt`.
- Live trace, collapse into one message, interrupt, comment-to-continue, text/choice/approval input requests, budget top-up request.
- AI title generation.
- **Exit:** a task asked the agent to summarise a pasted document, and the ledger matched the Vertex usage in the console within 5%.

## Phase 3 — Policy engine and local Mac with your browser

The headline use case (your own accounts in your own browser) comes before the remote browser.

- Policy engine: allow / ask / deny at global, project, task; bash parser; deterministic ask for egress, writes outside the folder, git push, outbound messages; `untrusted` profile; "Always allow" with scope.
- Tracked as #22 (Mac executor) and #23 (your Chrome). **Status (2026-10-27):** device pairing, revoke and the claim callables (#28), the `dodo` CLI and daemon (#29) and the sandboxed worker built; next is a real test on a Mac, then your Chrome (#23).
- `dodo` CLI: device login, folders, launchd daemon, status; model calls via the gateway; the whole worker inside sandbox-runtime with an egress allowlist that asks the control plane about other hosts, no Keychain access.
- Playwright MCP attached to your Chrome: log in by hand, then the agent continues.
- **Exit:** the agent downloaded your latest energy bill from a site you were logged into, asking before anything outside the allowlist.

## Phase 4 — Remote tools and notifications

**Status (2026-10-26): policy engine, bash, files, HTTP fetch, git checkout per task/project and Telegram notifications built (#4), ahead of phase 3 because they needed no Mac.** The policy engine from phase 3 moved here; phase 3 now reuses it. FCM web push added afterwards (#14). Still open in this phase: web search, the in-container egress proxy, tool cost models, and the exit criterion (a PR opened after an approval from your phone).

- Remote container tools: bash, files, git checkout per project, HTTP fetch, web search, all behind the policy engine and the in-container egress proxy.
- Tool cost models; one paid API end to end (Maps).
- Notifications: FCM web push (PWA) and Telegram with approve/deny buttons.
- **Exit:** a remote task opened a PR on a repo after you approved the push from your phone.

## Phase 5 — Remote browser, credentials, MFA

- Tracked as #24 (remote browser) and #25 (vault and MFA).
- Headless Playwright MCP in the container with encrypted, domain-scoped session store.
- Bitwarden agent vault: per-task scoped secret references, taint after injection, redaction.
- MFA as input requests, optional TOTP, `local-only` services; session handoff from the Mac.
- **Exit:** a remote task logged in to a site with a vault credential and an MFA code you typed from your phone.

## Phase 6 — Other task interfaces

- Task ingest API with per-source tokens, idempotency, `untrusted` profile; Gmail Apps Script example.
- **Status (2026-10-27):** ingest API built (#31); its first consumer is Jobs ([JOBS.md](JOBS.md), #32–#34).
- Connectors: Notion, Linear (agent API), GitHub Issues; one-time connector setting.

## Phase 7 — Polish

- `auto` device and model routing, budget estimate at creation, server-side transcription.
- Second runtime adapter (Claude on Vertex through the gateway) to prove the swap.
- Billing export reconciliation.
