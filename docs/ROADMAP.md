# dodo — Roadmap

Each phase ends with something usable end to end and keeps the budget guardrails ahead of the features that spend money. Nothing that can spend money ships before phase 1's guardrails are live.

## Phase 0 — Plan (this PR)

- Architecture, roadmap, setup checklist.
- Decisions recorded in [ARCHITECTURE.md](ARCHITECTURE.md).

## Phase 1 — Skeleton, task board, budget guardrails

Goal: you can sign in, create and manage tasks, and the money safety net is in place. No agent yet.

- Monorepo scaffolding: pnpm workspaces, strict TypeScript, Biome, Vitest, GitHub Actions CI.
- `packages/core`: zod domain model (tasks, projects, messages, artifacts, runs, input requests).
- `packages/budget`: CostGate (reserve/settle), ledger, pricing table, with unit tests against the Firestore emulator.
- Web app: sign-in (allowlisted), board (list + kanban), task page (Summary, Status, thread, artifacts), create task with tags, priority, due date, project; projects page with defaults; settings page (connector = custom); budget page (empty dashboard over the ledger).
- Firestore and Storage security rules + emulator tests.
- `infra/bootstrap.sh`: enables APIs, creates the billing budget (50 EUR) + Pub/Sub topic, quotas, service accounts, Workload Identity Federation for GitHub Actions.
- `killSwitch` function: halt at 40 EUR, detach billing at 45 EUR; tested with a fake Pub/Sub message.
- Deploy from CI to Firebase Hosting / Functions.

## Phase 2 — First agent runs (remote)

Goal: an AI-enabled task gets worked on in GCP and reports back.

- Intake pipeline with `generateTitle`, `applyProjectDefaults`, `enqueue` (routing steps fixed to defaults).
- `AgentRuntime` interface + ADK adapter; Gemini on Vertex AI; every model call through CostGate.
- Task tools (summary, status, message, ask_user, artifacts, finish) and the system prompt.
- Dispatcher function + Cloud Run Job worker; leases, heartbeats, timeouts from budget, infra cost metering.
- Live trace on the task page (AG-UI events), collapsed into one message per run; interrupt button; comment-to-continue.
- Input requests: text, choice, approval (without "always allow" yet).
- Budget dashboard with real data: per task, project, model, category.

## Phase 3 — Tools and permissions

- Policy engine with allow / ask / deny lists at global, project and task level; bash parser; "Always allow" from approval cards with scope picker; policy editor in settings.
- Tools in the remote container: bash, files, git (repo checkout per project), HTTP fetch, web search.
- Action cost models on tools; paid-API example (Maps) end to end.
- Notifications: FCM web push, PWA install.

## Phase 4 — Local Mac executor

- `dodo` CLI: login with device approval, folders, daemon (launchd), status.
- Sandboxed shell in chosen folder (sandbox-runtime), device online status in the UI.
- Routing steps `routeDevice` and `routeModel` (`auto` with a small model, reason shown on the task).

## Phase 5 — Browser, credentials, MFA

- Playwright MCP remote (headless) with encrypted session store.
- Playwright MCP local, attached to your Chrome; manual-login-then-continue.
- Secret provider (decided vault) with placeholder injection and redaction.
- MFA as input requests, optional TOTP, `local-only` services.
- Session handoff local → remote.

## Phase 6 — Other task interfaces

- Connector framework hardening, then Notion, Linear (agent API), GitHub Issues.
- One-time connector configuration in settings.

## Phase 7 — Polish

- Push-to-talk on task creation (transcribe step).
- Budget estimate step shown at creation.
- Second runtime adapter (Claude Agent SDK) to prove the swap.
- Telegram notifications with inline approve/deny (if chosen).
