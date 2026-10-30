# dodo — Architecture

dodo is a personal, asynchronous AI task agent. You create a task on a task board; an agent picks it up, works on it as far as it can, and reports back on the task itself: a top-down **Summary**, a **Status** with the next action or decision, and a thread with one collapsed message per agent run (expand it to see the full trace). You steer, answer questions, and approve risky or costly actions. You never need a chat window.

This document is the target design. [ROADMAP.md](ROADMAP.md) says in which order it gets built, and [SETUP.md](SETUP.md) lists what needs to be done by hand in GCP and Firebase.

---

## 1. Design principles

1. **Cost is a hard constraint, not a metric.** Every cost-bearing operation (model call, compute second, paid API call, purchase) goes through one gate that reserves budget _before_ the operation runs. GCP-level caps sit underneath as a backstop.
2. **Deterministic controls, LLM reasoning.** Budgets, permissions, credential injection, timeouts and logging are code. The model reasons and decides when to ask; it never decides _whether_ it is allowed to.
3. **Swappable edges, stable core.** Three plug-in boundaries with small interfaces: `TaskConnector` (where tasks live), `AgentRuntime` (which agent framework runs the loop), `Executor` (where the run happens). Everything else is the core.
4. **Reuse popular code.** Firebase for auth/data/hosting/push, Google ADK for the agent loop, AG-UI's event vocabulary for traces, Playwright MCP for browsers, Anthropic's open-source sandbox runtime for local command sandboxing, official Notion/Linear/GitHub SDKs for future connectors.
5. **Single user, minimal ops.** Everything scales to zero. Nothing runs (or bills) while no task is being processed.

---

## 2. System overview

```txt
            You (browser / phone PWA, push-to-talk)
                         │
          ┌──────────────┴──────────────┐
          │  Web app (Firebase Hosting) │  React SPA: board, task page, projects,
          │                             │  budget dashboard, settings, approvals
          └──────────────┬──────────────┘
                         │ Firestore realtime (client SDK, Firebase Auth)
┌────────────────────────┴───────────────────────────────────────────────┐
│ Firestore = system of record + queue + live trace store                │
│   tasks, projects, runs, runs/*/events, ledger, policies, devices, ... │
└──────┬──────────────────────────┬──────────────────────────┬───────────┘
       │ triggers                 │ listen (queued runs      │ connectors sync
       ▼                          │  for device=mac)         ▼  (later phases)
┌──────────────────────────────┐  │                 ┌────────────────────┐
│ Control plane (Cloud         │  │                 │ Notion / Linear /  │
│ Functions v2, trusted code)  │  │                 │ GitHub Issues      │
│  intake, dispatcher          │  │                 └────────────────────┘
│  model gateway (streaming)   │  │
│  heartbeat + action costs    │◄─┼───────────────────────────┐
│  kill switch, notifications  │  │                           │
└──────┬───────────────────────┘  │                           │
       │ jobs.run (one execution per run, per-run identity)   │ callables, with a
       ▼                          ▼                           │ per-run or device
┌──────────────────────┐   ┌────────────────────────┐         │ Firebase identity
│ Remote executor      │   │ Local executor (Mac)   │         │
│ Cloud Run Job        │   │ `dodo` daemon (launchd)│         │
│ ephemeral container  │   │ sandboxed shell        │         │
│ headless Chromium    │   │ your real Chrome       │         │
└──────┬───────────────┘   └──────────┬─────────────┘         │
       └──────────────┬───────────────┘                       │
                      ▼                                       │
        Worker core (same code in both, **untrusted client**) ┘
          AgentRuntime ─ ToolHost ─ PolicyEngine ─ Secrets
                      │
      model calls only through the gateway ─► Gemini on Vertex AI
```

Trust boundary: everything that spends money or holds credentials (budget writes, model calls, secrets, billing) lives in the control plane. Workers are clients with a scoped identity: if a prompt-injected command takes over a worker, it can only do what that one run may do.

Why this shape:

- **Firestore as queue and trace store** gives realtime UI updates, the run queue, and the live trace with zero extra infrastructure, inside the free tier (50k reads / 20k writes per day). Traces are written per step (tool call, message), never per token.
- **Cloud Run Jobs** give one throwaway container per run: a natural sandbox, billed per second, nothing running when idle, and a GCP-enforced timeout we derive from the task budget.
- **The Mac daemon** runs the same worker core, so local and remote behave identically except for the tools and browser they are given.
- **Workers are untrusted clients.** The Cloud Run worker's service account has **no IAM roles at all**. Each run gets its own Firebase identity (`run:{runId}`, claims `taskId`, `generation`), minted by the dispatcher and revoked when the run ends. Firestore rules scope it to its own run and task, and the gateway checks it on every model call. This matters because any process inside a Cloud Run container can read the container's service-account token from the metadata server: with zero roles, a leaked token is worthless.

---

## 3. Stack

| Concern           | Choice                                                                                                                                       | Why                                                                                                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language          | **TypeScript (strict) everywhere**, Node 22, pnpm workspaces                                                                                 | One language for UI, functions, worker and Mac CLI; shared zod schemas across all of them; first-class SDKs for Firebase, ADK (`@google/adk`), Anthropic Agent SDK, AG-UI, Playwright MCP, Notion, Linear, Octokit. Decided 2026-10-25. |
| Schemas           | zod                                                                                                                                          | Runtime validation at every boundary, types for free.                                                                                                                                                                                   |
| Web app           | Vite + React + Tailwind (shadcn-style components) + React Router, static SPA, installable PWA                                                | Static files on Firebase Hosting are free (Next.js SSR would need paid Cloud Run).                                                                                                                                                      |
| Auth              | Firebase Auth (Google sign-in), allowlist of one uid                                                                                         | Free; security rules reject everyone else.                                                                                                                                                                                              |
| Data              | Firestore (Native, `europe-west1`)                                                                                                           | Free tier, realtime, transactions for the ledger and queue claims.                                                                                                                                                                      |
| Files / artifacts | Cloud Storage for Firebase                                                                                                                   | 5 GB free; signed URLs for the agent.                                                                                                                                                                                                   |
| Backend glue      | Cloud Functions for Firebase (2nd gen)                                                                                                       | Free tier of 2M invocations; triggers on Firestore, Pub/Sub, schedules.                                                                                                                                                                 |
| Remote compute    | Cloud Run Jobs                                                                                                                               | Per-second billing, scale to zero, free tier 180k vCPU-s / month.                                                                                                                                                                       |
| Models            | Gemini via Vertex AI, only through the model gateway                                                                                         | Billed to the same project, so it sits under the same GCP budget cap. Model ids and prices live in a versioned table; the exact ids and prices are verified at the phase 2 spike (current-generation Flash as default).                 |
| Agent loop        | `AgentRuntime` interface; first adapter: own loop in TypeScript (decided 2026-10-25, see §6.2), ADK or Claude Agent SDK as optional adapters | The gateway already owns the model call; a framework that wants to own it too adds risk for little gain.                                                                                                                                |
| Trace events      | AG-UI event types (`@ag-ui/core`)                                                                                                            | Standard vocabulary (RUN_STARTED, TOOL_CALL_START, TEXT_MESSAGE_CONTENT, ...). We store them in Firestore instead of using the SSE transport. Opens the door to AG-UI/CopilotKit components later.                                      |
| Browser           | Playwright MCP (`@playwright/mcp`)                                                                                                           | Accessibility-tree based, widely used, works headless in a container _and_ attached to your real Chrome via its browser extension. `chrome-devtools-mcp` is the fallback for local.                                                     |
| Local sandbox     | `@anthropic-ai/sandbox-runtime`                                                                                                              | Seatbelt on macOS / bubblewrap on Linux, with a network allowlist; the same thing Claude Code uses.                                                                                                                                     |
| Notifications     | Firebase Cloud Messaging web push to the installed PWA                                                                                       | Free; works on iPhone for home-screen web apps. Telegram bot as an optional second channel (see decisions).                                                                                                                             |
| Infra             | `infra/` gcloud scripts + `firebase.json`; deploys from GitHub Actions with Workload Identity Federation                                     | No long-lived keys anywhere.                                                                                                                                                                                                            |
| Tests / lint      | Vitest, Biome, Firebase emulators for integration tests                                                                                      | Fast, one tool each.                                                                                                                                                                                                                    |

### Repository layout

```txt
apps/
  web/           React SPA (board, task page, projects, budget, settings)
  functions/     Cloud Functions: intake, dispatcher, kill switch, notifications
  worker/        Cloud Run Job entrypoint (container image)
  cli/           `dodo` Mac CLI + daemon (local executor)
packages/
  core/          domain model (zod), pipeline steps, pricing table
  budget/        CostGate, ledger, price models
  policy/        permission rules, bash command parser, approval requests
  runtime/       AgentRuntime interface + adapters (adk, later claude)
  tools/         tool definitions: task tools, bash, files, browser, http, ...
  connectors/    TaskConnector interface + custom (Firestore) connector, later notion/linear/github
  worker-core/   run loop shared by worker and cli: claim, run, heartbeat, settle
infra/           bootstrap scripts, budget + kill switch setup, IAM
docs/
```

---

## 4. Domain model

All canonical state lives in Firestore, whatever the task interface is. Connectors mirror it.

```txt
settings/global          connector choice, defaults (model, device, budget), global caps
projects/{id}            name, defaults: tools, device, repo, folder, model, budget, policy overrides
tasks/{id}
  title, description, titleSource: user|ai
  status: backlog | todo | in_progress | needs_input | review | done | cancelled
  priority, dueDate, tags[], projectId
  ai: { enabled, model|auto, device|auto, repo, folder, tools[], budgetEur }
  summary (markdown, agent-maintained), statusLine { text, nextAction, needsYou: bool }
  externalRefs: { notion?, linear?, github? }
tasks/{id}/messages/{id}  thread: author user|agent|system, body, runId?, input request?
tasks/{id}/artifacts/{id} kind file|link|text, role reference|output, storagePath|url, createdBy
runs/{id}                 taskId, device, model, state, lease {owner, generation, expiresAt}, trigger
runs/{id}/events/{seq}    AG-UI events (step-level), payloads over ~4 KB offloaded to Storage
gs://…/sessions/{runId}   serialised agent session (Cloud Storage, not Firestore: 1 MiB doc limit)
inputRequests/{id}        taskId, runId, kind text|choice|approval, prompt, options, answer
ledger/{id}               append-only cost entries: scope ids, category, amount, reservation id
budgets/{scope}           running totals per global lifetime, global/month, project/month, task (transactional);
                          task spend shown in the UI is read from here
policies/{scope}          allow / ask / deny rules for global, project, task
devices/{id}              mac daemons: lastSeen, capabilities, folders
```

### Run lifecycle

```txt
queued ─► claimed ─► running ─┬─► waiting_input ─(answer)─► queued (resume)
                              ├─► interrupted   (you pressed stop or commented)
                              ├─► budget_exhausted ─► input request "top up by X EUR?" ─► queued (resume)
                              ├─► succeeded / failed
```

- **Dispatching is idempotent.** Firestore triggers fire at least once, so the dispatcher moves a run `queued → dispatching` in a transaction that records the execution it is about to start; a second trigger finds the state already changed and does nothing. At most one active run exists per task; a new trigger on a task with an active run is queued behind it.
- **Claiming** is a Firestore transaction that sets a lease (`owner`, `generation`, `expiresAt`). Workers heartbeat every 15 s through the `heartbeat` callable, which also meters infra cost (§7.1).
- **Fencing**: every write a worker makes, including every CostGate `reserve`/`settle`, carries the lease generation and is rejected in the transaction if the generation changed. A worker that loses its lease aborts itself. So a slow-but-alive worker and its replacement can never both spend the task budget.
- **No blind retries**: an expired lease re-queues the run once. A crash does not retry (Cloud Run Job `max-retries = 0`); it is shown on the task, because a crash loop would spend the budget for nothing.
- **Interrupt and halt**: the worker listens to its own run document and to `settings/global.halted`, and aborts at once: the abort signal goes into the runtime, and running tool processes are killed as a process group. Every tool also has its own hard timeout, so "abort at the next boundary" is always bounded.
- **New comment while running** does not abort: the worker watches the thread and delivers the comment into the context at the next model call (steering, like a mid-run message in Claude Code). Only the stop button aborts. Aborting throws away in-flight work and a resume re-sends the context, so it is the exception, not the way to steer.
- **Waiting for input** ends the run and releases the container (no paid idle time). The answer enqueues a resume run that restores the session from Cloud Storage.
- **Budget exhausted** is not a dead end: it becomes an input request ("This task has used its 0.50 EUR. Top up by 0.50 EUR?"), and approving it raises the task budget and resumes.
- **When a run ends**, its event documents are archived as one JSON trace in Cloud Storage (linked from the collapsed thread message) and deleted from Firestore. Firestore stays small and within the free tier; the live trace only exists while the run is live.

---

## 5. Task flow

```txt
create task ─► intake pipeline ─► queue ─► executor ─► agent run ─► task updates
 (UI, voice)    (Cloud Function)   (runs)   (gcp|mac)   (tools)      (summary, status,
                                                                      thread, artifacts)
```

### Intake pipeline (modular mini-steps)

Each step is a small, separately testable function `(task, ctx) => changes`. The pipeline itself is one plain function that calls them in order: easy to read and to change in code, no registry or config layer.

1. `generateTitle` — if no title (smallest model, through CostGate).
2. `applyProjectDefaults` — project values fill unset task fields.
3. `enqueue` — create the `runs` doc, unless the task is not AI-enabled.

Routing for `auto` (built 2026-10-29, `apps/functions/src/routing.ts`), decided when the run is queued and shown on the task's status line ("Queued: Studio is online, with a browser"):

- **Device `auto`**: your Mac whenever one is online (the one seen most recently); otherwise remote, unless the task names a folder, which only a Mac has: then the Mac seen last, and the run waits for it.
- **Browser `auto`**: once per new task the cheapest model answers whether the work needs a real browser (a site to log in to, click through or fill in, a JavaScript app, something to look at) or whether HTTP fetch, files and code cover it. A continued conversation keeps the browser it had. A run that started without one gets `request_browser`: the agent calls it when it finds out it needs one, the run ends as `needs_browser` and a new run with a browser picks the session up at once. `none` never gives one; `chrome` always does.
- **Model `auto`** is still the default model; `estimateBudget` and server-side `transcribe` remain for later.

### Agent run

The worker builds the context (task fields, summary, thread, artifacts list, project instructions), gives the runtime the allowed tools, and streams events into `runs/{id}/events`. The task page renders them live; when the run ends they collapse into one thread message that links to the full trace.

### Communication contract

The agent writes to the task only through task tools, so the UI stays structured:

| Tool                                     | Effect                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `update_summary(markdown)`               | Replaces the Summary: answer first, then supporting points (top-down, MECE). |
| `set_status(text, nextAction, needsYou)` | One-line state and the single next action or decision.                       |
| `post_message(markdown)`                 | Final message of the run in the thread (the collapsed message).              |
| `ask_user(kind, prompt, options?)`       | `text`, `choice` (buttons), or `approval`. Ends the run; resumes on answer.  |
| `add_artifact` / `read_artifact`         | Attachments and links, as reference or output.                               |
| `finish(outcome)`                        | Marks the task `review` or `done`.                                           |

`ask_user` can also attach a screenshot of the browser page (or one element on it). The thread shows it and Telegram gets it as a photo, so a QR code or a "pick this icon" check can be done from your phone.

A remote run with a browser does not end on `ask_user`: it **holds** the worker, and with it the page and its logins, for up to 10 minutes (`RequestInputRequest.holdMs`, `run.awaiting`). The question is posted and announced as usual, the heartbeat delivers the answer, and the agent continues in the same session, which is what an MFA code or a "confirm in your banking app" needs. When the hold runs out the worker parks the run itself (`finish(waiting_input)`), and the answer starts a new run as before. The wait is metered as container time against the task budget (about a cent for ten minutes). A Mac run needs no hold: its Chrome window outlives the run.

The system prompt carries the communication style from task-ai (top-down, concise, ask only when a decision would otherwise waste your review time), rewritten for this contract.

---

## 6. Plug-in boundaries

### 6.1 TaskConnector

```ts
interface TaskConnector {
  id: 'custom' | 'notion' | 'linear' | 'github';
  capabilities: {
    liveTrace: boolean; // can show a message that updates while running
    editMessages: boolean;
    choiceInput: boolean; // native buttons, else fall back to "reply 1/2/3"
    attachments: boolean;
  };
  watch(onChange: (e: ExternalTaskEvent) => void): Unsubscribe; // webhooks or polling
  pullTask(ref: ExternalRef): Promise<ExternalTask>;
  pushTask(task: Task, changes: TaskChange[]): Promise<void>; // summary, status, fields
  postMessage(ref: ExternalRef, msg: ThreadMessage): Promise<MessageRef>;
  updateMessage?(ref: MessageRef, msg: ThreadMessage): Promise<void>;
  requestInput(ref: ExternalRef, req: InputRequest): Promise<void>;
}
```

- **custom** (phase 1) is the native case: the web app reads Firestore directly, so the connector is a no-op passthrough.
- **notion** (`@notionhq/client`): Summary and Status as page properties or a pinned block at the top, thread as comments, task database chosen in settings, webhooks for changes.
- **linear** (`@linear/sdk`): Linear's agent API shows agent activity natively in the issue, which matches the live-trace idea well.
- **github** (Octokit): issue body section for Summary/Status, comments (editable) for the thread, labels for tags.

The web app keeps a one-time setting for which connector is active. Connectors only translate; the canonical model, queue, budget and policy live in dodo. The capability flags are a sketch: they get designed for real when the second connector is built.

### 6.2 AgentRuntime

```ts
interface AgentRuntime {
  id: 'adk' | 'claude-agent-sdk' | string;
  run(input: RunInput, hooks: RuntimeHooks, signal: AbortSignal): AsyncIterable<AgUiEvent>;
}
interface RuntimeHooks {
  beforeModelCall(req: ModelCallPlan): Promise<ModelCallPermit>; // CostGate.reserve, may cap max tokens
  afterModelCall(usage: TokenUsage): Promise<void>; // CostGate.settle
  executeTool(call: ToolCall): Promise<ToolResult>; // PolicyEngine + CostGate + ToolHost
}
```

- Tools are defined once in our own format (name, zod input schema, cost model, policy key, execute) and converted by each adapter (ADK `FunctionTool`, Anthropic tool schema, MCP).
- The adapter must route **every** model call and tool call through the hooks, including calls the framework makes on its own (agent transfer, planning, built-in tools such as search grounding). This is enforced twice: by a test that runs the adapter against a fake model and fails on any call that skipped the hooks, and by construction, since the worker has no Vertex AI permission and can only reach models through the model gateway (§6.4).
- Session state (conversation so far) is serialised by the adapter into Cloud Storage so runs can resume on another machine.
- **Compaction**: the gateway records on the task how many tokens the conversation held at its last model call (`task.context`, shown in the task view against the model's window). Before a model call the loop replaces the conversation with a summary the model writes of it once it reaches 200k tokens or 80% of the window, whichever is lower: every step re-sends the whole conversation, so this keeps steps cheap as well as inside the window. **Compact** in the task view does the same by hand: a working run compacts at its next step (handed over by the heartbeat); an idle task is summarised by the `taskCompact` callable under a run with trigger `compact`, metered and charged to the task like any step.
- **First adapter: our own loop (decided 2026-10-25).** The loop is small: build the request (system prompt, task context, history, tool schemas) → call the gateway (streaming) → if the model asks for tools, run them through `executeTool` → append results → repeat until `finish` or a stop condition. About 200 lines, with the hooks, session serialisation, steering and abort handling built in rather than bolted on. It uses the Gemini function-calling format the gateway passes through unchanged.
- **Why not ADK first.** The gateway owns the model call; ADK (and any framework) wants to own it too, so an ADK adapter needs a custom model backend pointing at the gateway plus callbacks that can veto and rewrite requests. `@google/adk` is younger than the Python ADK, and that is exactly the part that must be proven. The framework's strengths (multi-agent trees, built-in tools) are not needed here. ADK and the Claude Agent SDK remain adapters behind the same interface: the swap is proven by a second adapter in phase 7, not paid for up front.
- Claude models are available on Vertex AI, so a Claude Agent SDK adapter can call them through the same gateway, under the same budget and kill switch, with no second billing account.

### 6.3 Executor

```ts
interface Executor {
  id: 'gcp' | `mac:${string}`;
  tools(): ToolDefinition[]; // what this environment can offer
  browser(): BrowserProvider; // headless container Chromium, or your Chrome
  shell(): ShellProvider; // container shell, or sandboxed Mac shell in the chosen folder
}
```

### 6.4 Control plane: model gateway, heartbeat, action costs

Workers never write budget state and never hold model or cloud credentials. Everything that spends money is a **callable Cloud Function** (trusted code, Admin SDK), authenticated with Firebase Auth: the per-run identity for remote workers, the device identity for the Mac, your account for the web app. Callables accept all three with no extra auth code, and they stay inside the Functions free tier.

| Callable                                 | Does                                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gateway.generate` (streaming)           | The only path to Vertex AI: reserve → call → settle for tokens. Thin passthrough of `generateContent`, so tool calling and any Gemini feature work unchanged. |
| `run.heartbeat`                          | Renews the lease, reserves the next minute of infra cost, returns `halted`/`interrupt` flags. A worker that cannot heartbeat aborts.                          |
| `run.reserveAction` / `run.settleAction` | Cost of paid tools (Maps, purchases) around the tool's execution.                                                                                             |
| `run.requestInput` / `run.finish`        | State transitions that end a run; revoke the run identity.                                                                                                    |
| `secrets.resolve` (phase 5)              | Returns a credential to the browser tool only for a service the task is approved for.                                                                         |
| `githubToken` / `githubOpenPr`           | A token for the run's own repo (read to clone; write only after an approved push or PR), and opening the PR itself. See [GITHUB.md](GITHUB.md).               |

The gateway:

- does reserve → call → settle itself, so budget enforcement is server-side for remote _and_ Mac runs. A prompt-injected shell command on either executor cannot bypass the CostGate: there is nothing to bypass it with.
- counts input tokens before the call (`countTokens`, free on Vertex), applies the price tier for that prompt length, sets an explicit thinking budget and `max_output_tokens` that fit the remaining budget, and refuses models missing from the pricing table.
- applies an **independent rate governor**: a hard cap on spend per hour across all runs (default 2 EUR/hour), kept in its own counter. It protects against bugs in the CostGate or the ledger, since it does not share their code path.
- keeps the request prefix stable (system prompt, task context, history in order) so Gemini's **implicit context caching** applies to long runs and resumes. Explicit caches cost storage per hour and are not worth it at this scale.
- checks on every call that the caller's run is active and its lease generation is current; a call from a stale or finished run is refused.
- settles with the usage the API reports. If the call fails without usage, the full reservation is charged: safe, and visible in the ledger as an overrun of zero with a failed call.

### 6.5 Task ingest API (programmatic task creation)

Other pipelines can push tasks onto the board, for example "emails in Gmail that need action become tasks".

- `POST /v1/tasks` on one HTTPS Cloud Function, authenticated with a personal access token per source (created in settings, stored hashed, revocable). Body is the same `NewTask` schema plus `source` (e.g. `gmail`) and an `idempotencyKey` (e.g. the Gmail message id) so a retried pipeline never creates duplicates.
- Each source has its own defaults: tags, project, and whether AI starts automatically (off by default, so injected tasks wait for you).
- Content from a source is **untrusted input**: it is stored and shown as quoted source material. Runs on such tasks get the `untrusted` policy profile: no `agent-decides` at all, so every action outside the task tools is a deterministic _ask_, because an email can contain prompt-injection text.
- Rate limited per token, and the function rejects anything without a valid token before doing work, so it cannot be used to run up costs.
- Example pipeline for Gmail, at no cost: a Google Apps Script on your account that runs every 10 minutes, looks for a label like `dodo` (or a Gmail filter result), and posts each new email to the API.
- **Built (2026-10-27)** as the `taskApi` function (`apps/functions/src/ingest.ts`): `POST/GET /v1/tasks`, `GET/PATCH /v1/tasks/{id}`, `POST /v1/tasks/{id}/messages`. The token decides the source, a token can only touch its own source's tasks, 120 calls per hour per token. Tasks carry `source` (kind, link back, label), shown as a logo on the board. Jobs ([JOBS.md](JOBS.md)) use the same functions in-process.

---

## 7. Budget and cost control

The **internal layers enforce the cap**. The GCP layer is a safety net for bugs in them: it reacts in minutes to hours and cannot undo charges already made, so it bounds the damage instead of preventing it.

| Layer                                                    | Reacts in               | Stops spending by                      |
| -------------------------------------------------------- | ----------------------- | -------------------------------------- |
| 1. CostGate + ledger (per task, project, month)          | before every cost       | refusing the reservation               |
| 2. Gateway rate governor (spend per hour)                | before every model call | refusing the call                      |
| 3. Cloud Monitoring alerts (token count, Cloud Run time) | ~5–10 minutes           | kill switch: halt + cancel executions  |
| 4. Cloud Billing budget (50 EUR lifetime)                | hours, up to a day      | kill switch: halt, then detach billing |

### 7.1 Internal layer: CostGate and ledger

Every cost-bearing operation follows **reserve → execute → settle**:

```ts
const r = await costGate.reserve({ scopes: [global, project, task], category, amount });
try {
  result = await op(r);
} finally {
  await costGate.settle(r.id, actual);
}
```

- `reserve` is one Firestore transaction across the scope documents. It fails if _any_ scope (task, project month, global month, global lifetime) would go over its cap counting existing reservations, or if processing is halted. Nothing runs without a reservation. Caps are read live, so lowering one applies at once.
- Money is integer micro-euros. Prices are converted from USD at 1 USD = 1 EUR, which overestimates cost.
- Categories, all counted against the same task budget:
  - **tokens** (in the gateway, §6.4): reserve `counted_input × tier_price + (max_output + thinking_budget) × out_price`; output and thinking budgets are lowered to fit what is left. Tool-side model costs (for example search grounding, priced per request) are reserved as their own entries. Settled with the actual usage the API reports.
  - **infra**: Cloud Run seconds × (vCPU + memory) price, reserved one minute at a time by the `heartbeat` callable (server-side; the worker cannot write it). The Cloud Run task timeout is set from the remaining task budget at launch, so GCP itself stops an over-budget container. Mac runs cost 0 infra.
  - **actions**: each tool declares a cost model: `free`, `fixed(eur)`, `perUnit(fn)` (for example a Maps API call), or `unknown`. `unknown` and anything flagged as a payment always require approval and reserve the approved amount.
  - **purchases**: an approval card shows the amount; the approved amount is reserved before the agent continues. For a physical hard limit, use a virtual card with its own spending limit for agent purchases.
- What the ledger does not see: Firestore or Storage overage, Cloud Build minutes from deploys, logging volume, Artifact Registry. These are small, and they are why the internal monthly cap sits well below the GCP alarms.
- Default caps (editable): **35 EUR lifetime** and **25 EUR/month** internal, project unset, **0.50 EUR per task**. The lifetime cap mirrors the GCP lifetime budget, below its 40 EUR halt.
- Later: daily reconciliation against the billing export, once the ledger has ever been wrong.

### 7.2 GCP layer (safety net)

| Control                               | Setting                                                                                                                                                                                                       | Effect                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Cloud Billing budget on `dodo-512722` | 50 EUR over a custom period (setup → 2030-12-31, so a lifetime total), thresholds 50/80/90/100%, credits excluded (gross cost), Pub/Sub `billing-alerts`                                                      | Feeds the kill switch.                          |
| Cloud Monitoring alert policies       | Vertex AI `publisher/online_serving/token_count` and Cloud Run billable instance time above what the internal caps can legitimately produce per hour; notification channel into `billing-alerts`              | Reacts in minutes, independent of billing data. |
| `killSwitch` function                 | Any alert or ≥ **40 EUR**: set `halted`, cancel running Cloud Run executions. ≥ **45 EUR**: also **detach billing** from the project.                                                                         | Workers also watch `halted` and abort.          |
| Cloud Run Job settings                | max **1** concurrent execution, `max-retries = 0`, task timeout from budget (max 1 h)                                                                                                                         | Bounds the burn rate.                           |
| No per-token quota                    | Current Gemini models on Vertex use dynamic shared quota, so there is no per-project tokens-per-minute limit to lower; the rate bound comes from the gateway governor, concurrency and per-call caps instead. |                                                 |
| No public billable endpoints          | Only auth-checked callables, the token-checked rate-limited ingest API, and the gateway (per-run tokens)                                                                                                      | Outsiders cannot run up costs.                  |

**Worst case if layers 1 and 2 both fail.** With one concurrent run, a 128k-token context cap, an 8k output cap and about 6 calls per minute, a Pro-class model burns roughly 90 EUR per hour, a Flash-class model roughly 20 EUR per hour. Layer 3 reacts within about 10 minutes, so the overshoot is around 15 EUR (Pro) or 4 EUR (Flash). Layer 4 alone could be hours late. This is why the default model is Flash-class and Pro needs a task-level choice.

**Operating the kill switch.** `halted` stays set until you clear it in Settings. After a billing detach: re-link billing in the console, redeploy if needed, then clear `halted`. Before any agent code ships, Phase 1 runs one real detach and re-link (`infra/test-kill-switch.sh`), because the dangerous part is the billing IAM, not the message parsing.

---

## 8. Permissions and approvals

### 8.1 Rules

Rules use the same shape as Claude Code permission rules, so they are familiar and easy to read:

```txt
Bash(echo:*)            Bash(git status)        Bash(git push:*)
Bash(rm -rf:*)          Read(~/code/**)         Write(./**)
Browser(navigate:*.strava.com)                  Browser(submit:*)
Http(GET:api.github.com/**)                     Tool(maps.geocode)
Pay(*)
```

- Three lists at each scope (global → project → task): **deny**, **ask**, **allow**. Precedence: deny > ask > allow; the most specific scope cannot loosen a deny from a broader scope.
- **Bash parsing**: commands are parsed into a syntax tree, and every simple command (across `&&`, `;`, `|`, subshells, `$(...)`) must be allowed on its own. Redirections to files count as writes. Anything the parser cannot understand goes to _ask_.
- **Default mode** for actions no rule matches: `agent-decides`, but only for actions that are read-only or stay inside the sandbox (reading files, running tests, editing files in the task folder). The model gets a short written policy and calls `ask_user(kind: approval)` itself when it judges something risky.
- **Always deterministic _ask_** unless an allow rule matches, whatever the mode: network egress to a host not on the allowlist (`Http`, `Browser(navigate)`, `Bash` with network), writes outside the task folder, `git push`, opening PRs or issues, sending any message as you, payments, unknown-cost tools, and credential use. This is what blocks the "email tells the agent to send your files somewhere" attack; allow rules from the approval cards are how prompts get fewer over time.
- **Tasks from the ingest API** use the `untrusted` profile: no `agent-decides` at all.
- **Egress control, Mac**: shell commands run under the sandbox runtime (seatbelt): writes limited to the task folder, network only through its allowlisting proxy, no Keychain access.
- **Egress control, Cloud Run**: the container runs tool subprocesses as a separate unprivileged user with `HTTP(S)_PROXY` pointing at the same allowlisting proxy, and the policy engine treats any shell command with network as _ask_ unless allowed. This is not a hard network boundary (Cloud Run does not allow the kernel features the Linux sandbox needs), which is acceptable because the worker identity can do nothing beyond its own run. If a hard boundary is ever needed, Direct VPC egress with firewall rules provides it at the cost of Cloud NAT for external sites.

### 8.2 Approval UX

An approval request shows what will happen, why, and the cost, with:

- **Approve once**
- **Always allow `Bash(git push:*)`**: the suggested rule is editable and has a scope picker (this task / project / everywhere)
- **Deny**, or **Deny and tell the agent why** (text goes back into the context)

Text questions and choice menus use the same `inputRequests` mechanism. Answering from the push notification opens the task with the card focused.

---

## 9. Browser, credentials and MFA

### 9.1 Browser control

- **Remote** (built 2026-10-29): a second Cloud Run Job, `dodo-worker-browser` (`apps/worker/Dockerfile.browser`: the same bundle plus `@playwright/mcp` and headless Chromium, 1 vCPU / 2 GiB instead of 1 GiB, about 10% more per second). The dispatcher sends runs with `browser: true` there; the worker starts Playwright MCP headless on localhost for the run (`apps/worker/src/headless.ts`, in-memory profile, `--no-sandbox` because the container has no user namespaces) and the same browser tools connect to it. Nobody sees the page: logins come from the vault, and anything the user must see goes out as an `ask_user` screenshot while the run holds for the answer (§5). Playwright MCP runs inside the worker process on a context the worker owns (an in-memory MCP transport, no port), so the worker can restore and read the context's **logins**: at the end of a run the Playwright `storageState` (cookies, local storage) goes to the control plane (`runBrowserState`), which keeps it per task in Cloud Storage under `browser/{taskId}/` (no client rule reaches it), encrypted with AES-256-GCM under a key in Secret Manager (`dodo-browser-key`, gateway only); the task's next remote run gets it back before its first page. Task-level on purpose, so two tasks on one site never share a session; the blob is deleted when the task is done, cancelled or deleted, and a session still ends when the site ends it. Sharing within a project is a possible later toggle.
- **Local** (built): the daemon runs Playwright MCP, a server on localhost, against a real Chrome window on your Mac. By default that is **dodo's own Chrome window** with a persistent profile under `~/.dodo/chrome` (nothing to install; log in to a site there once). With the Playwright Extension installed it drives **your everyday Chrome** instead, in your profile with your logged-in sessions (Chrome asks you to allow the first connection; `dodo browser connect <token>` skips that). The worker is an MCP client over streamable HTTP; the sandbox opens loopback only for runs the task asked for ("Browser: Your Chrome" on the task or as a project default). The server and the window stay up between runs, so you can log in by hand (itsme, MFA) in the tab the agent opened and tell it to continue. Downloads and screenshots land under `~/.dodo/work/browser`.
- **Handoff**: a session you logged into locally can be exported to the remote session store, so remote runs can reuse it until it expires.
- Every browser action goes through the policy engine, keyed by what it does on which site: `Browser(navigate:host)` is egress (allowed hosts and allow rules apply), `Browser(act:host)` reads and clicks on an open site, `Browser(submit:host)` is a click, Enter or typed submit on anything that reads like pay, order, confirm, send, delete or sign (always asks), `Browser(evaluate:host)` and `Browser(upload:host)` ask. Results are accessibility snapshots, cut to a fixed size and passed through the vault's redaction.

### 9.2 Credentials

Goal: passwords never enter model context. This is a mitigation with known limits, not an absolute guarantee, so the rules below close the obvious read-back paths.

- Credentials come from a **secret provider** behind an interface. The LLM only sees a reference like `{{secret:energy-provider.password}}`; the browser tool resolves it inside the tool and types it into the field. Values are redacted from traces and logs.
- **Scoped per task**: a task declares which services it may use, and the provider refuses references outside that set. Using a credential is an approval per task, not once globally, so approving the energy provider in one task does not expose it to another.
- **Taint after injection**: once a secret is typed into a page, arbitrary JavaScript (`browser_evaluate`) is disabled for that browser context and `Http`/`Bash` egress is blocked until the page navigates away. Page snapshots are filtered for the injected value.
- **Sessions**: saved browser sessions are restored only for domains the task's browser rules allow; the encryption key lives in Secret Manager and is fetched per run.
- Provider: **Google Secret Manager** (decided 2026-10-27, replacing Bitwarden). All values are one JSON secret `dodo-vault` that only `dodo-gateway` can read or write; every write adds a version and destroys the older ones. Firestore `vault/{id}` holds what may be shown: name, sites (`domains`), field names, a login hint, last use. Settings › Vault writes values through `vaultSave`; they are never readable from the web app again.
- **Resolving**: `vaultResolve({runId, entryId, field, host})` returns one value only to the live run itself, only when `host` matches one of the entry's sites, and only when the task was approved for the entry: an answered approval card for `Vault(<id>)` on that task, or a `Vault(<id>)` allow rule on the task. Project and global allow rules do not count; a deny rule anywhere wins. Each use updates `lastUsed` and is logged without the value.
- **In the worker**: `SecretResolver` (`packages/agent/src/secrets.ts`) resolves references for a host and remembers every value it handed out; the loop redacts those values from model output, tool arguments and results, the trace and anything the agent posts. The model gets `list_vault` (entries, sites, fields, refs; never values) and `request_vault_access` (the approval card).
- **Personal info** (`settings/profile`, Settings › Personal info) is the non-secret counterpart: name, email, phone, address, birth date, languages, time zone, extra details, free-text notes and availability (`schedulingNotes`, also read by Jobs). Any live run may read it; the model gets it with `get_personal_info`.

### 9.3 MFA

- **TOTP**: optional per service, stored in the vault, generated inside the tool (only for services you mark low risk).
- **SMS / email / push codes, passkeys, CAPTCHA, device checks**: the run pauses with an input request ("Enter the code from your phone" or "Approve the login on your device, then press Continue"). Notification goes to your phone.
- **Secret answers** (built): a code is asked with `ask_user` and `secret: true`. You answer in a password field in the app (callable `answerSecret`) or by replying on Telegram, where the bot deletes your message. The value is stored encrypted with the browser-state key in `secretAnswers/{messageId}`, which no client rule reaches; the question's message gets only `{{answer:<messageId>}}` as its answer, so the thread, the trace and the model see the reference. `browser_type` resolves it through `runSecretAnswer` (a live run on that task only), taints the page like a vault value and the loop redacts it afterwards. A code is handed out for 30 minutes and every code of a task is deleted when the task closes.
- Passkeys and some Google sign-ins only work in your real browser, so those services are tagged `local-only` and the device router sends their tasks to the Mac.

The Personal Authentication Layer from the brainstorm maps onto this: Browser Manager = Playwright MCP, Authentication Manager + Service Registry = a `services` config with login strategy per site, Policy Engine = §8, Secret Provider = §9.2, Session Store = §9.1, Approval Service = `inputRequests`.

---

## 10. Mac install (local executor)

```sh
npm install -g @dodo/cli        # later: brew install arnoutverboven/tap/dodo
dodo login                      # opens the web app, you approve, device gets its own token
dodo folders add ~/code         # folders the agent may work in
dodo daemon install             # writes a launchd agent, starts at login
dodo status                     # online, current run, last errors
```

- Pairing: Settings › Your Macs shows a one-time code; `dodo login <code>` calls `deviceRegister`, which creates the approved `devices/{id}` document and mints a **device identity** (`device:{id}`). The daemon keeps that sign-in's refresh token in the Keychain.
- The device identity can do two things only: read the queued runs with `device = mac:<id>` and report presence (`lastSeen`, `version`, `folders`) on its own document. To work on a run it calls `deviceClaim`, which takes the lease and hands back the same **per-run identity** a Cloud Run worker gets (decided 2026-10-27; the device identity itself never touches tasks). Revoking in Settings flags the device, and a trigger revokes its refresh token.
- The UI shows whether the Mac is online; tasks routed to an offline Mac wait in the queue and say so. Mac runs have no infra cost and a fixed 1-hour cap.
- The daemon never holds model or cloud credentials: model calls go through the gateway (§6.4) with the run token. The device token is kept in the Keychain and only in the daemon's memory while running; sandboxed commands cannot read the Keychain.
- **Sandbox (built 2026-10-27).** The daemon starts each run's worker as a child process inside `@anthropic-ai/sandbox-runtime` (Seatbelt on macOS, bubblewrap on Linux): reads denied under the home folder except the allowed task folders, the work folder and the worker's own files; writes only to those and temp; network only through the runtime's proxy. The proxy allows the control-plane hosts, GitHub and the registries; for any other host it asks the daemon, which asks `deviceEgress`: trusted code that applies the task's policy (allowed hosts, allow rules, the approval the user just gave for the command) and answers allow or deny. Refusals land in the daemon log. The daemon will not run a task unsandboxed unless `DODO_SANDBOX=off`.
- Phase 1 for local can be even simpler: `dodo daemon` in a terminal tab.

---

## 11. Notifications

- Events that notify: input requested, run failed, budget threshold hit, task finished (configurable).
- **Web push via Firebase Cloud Messaging** to the installed PWA (desktop and iPhone home screen). Free, no extra accounts.
- Optional: a **Telegram bot** (free), which can carry Approve / Deny buttons right in the notification.
- Quiet hours and batching (one notification per task per 10 minutes) to keep noise down.

---

## 12. Security summary

- **Three identities, all through Firestore rules**: your account (owner claim; granted by the `claimOwnership` callable to the configured owner email, so no manual claim step), the Mac device identity (`device:{id}`), and the per-run identity (`run:{runId}`, scoped to its run's events, its task's summary/status/messages/artifacts, and checked against the lease generation with a rule-side `get()`). Only Cloud Functions use the Admin SDK: they are the trusted code.
- **Worker service account has no IAM roles.** The threat is the metadata server: any process in a Cloud Run container can fetch the container's service-account token, so that token must be worth nothing.
- No service account keys: GitHub Actions deploy with Workload Identity Federation. The deployer may act only as the specific runtime service accounts, not as any account in the project.
- The Firebase web API key is public by design; it is restricted to the app's domains in the GCP console (SETUP.md). Anyone can sign in with Google, but without the owner claim the rules reject every read and write.
- Secrets never enter model context, traces or logs.
- Everything that leaves dodo (messages, purchases, posts) defaults to ask.

---

## 13. Cost estimate (personal use)

| Item                                              | Expected monthly cost                                                |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| Firebase Hosting, Auth, Firestore, FCM, Functions | 0 EUR (free tier)                                                    |
| Cloud Storage (artifacts, sessions)               | 0 EUR under 5 GB                                                     |
| Cloud Run Jobs (1 vCPU / 2 GiB, ~20 h of runs)    | ~0–2 EUR (free tier covers ~50 h of 1 vCPU)                          |
| Artifact Registry (worker image)                  | ~0.1 EUR                                                             |
| Gemini tokens                                     | what you choose to spend; capped by task budgets and the monthly cap |

---

## 14. Decisions

| Date       | Decision                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-25 | TypeScript everywhere (UI, functions, worker, Mac CLI).                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-10-25 | Billing in EUR, region `europe-west1`.                                                                                                                                                                                                                                                                                                                                                                                        |
| 2026-10-25 | Bitwarden (dedicated agent vault) as the secret provider.                                                                                                                                                                                                                                                                                                                                                                     |
| 2026-10-25 | Telegram as a second notification channel next to web push (free).                                                                                                                                                                                                                                                                                                                                                            |
| 2026-10-25 | Model gateway: all model calls server-side, Mac holds no model credentials (from the architecture review).                                                                                                                                                                                                                                                                                                                    |
| 2026-10-25 | Egress, writes outside the folder and anything outbound are deterministic _ask_; `agent-decides` only for sandbox-confined actions (from the architecture review).                                                                                                                                                                                                                                                            |
| 2026-10-25 | The 50 EUR GCP cap is a **lifetime total**: the billing budget covers a fixed period from setup to the end of 2030 instead of resetting monthly.                                                                                                                                                                                                                                                                              |
| 2026-10-25 | Workers are untrusted clients with a per-run Firebase identity; the worker service account has no IAM roles; all budget writes and model calls happen in callables (second review pass).                                                                                                                                                                                                                                      |
| 2026-10-25 | A comment during a run steers it at the next model call instead of aborting it (second review pass).                                                                                                                                                                                                                                                                                                                          |
| 2026-10-25 | **Own agent loop first** as the first `AgentRuntime` adapter; ADK and the Claude Agent SDK as optional adapters later (decided by Arnout).                                                                                                                                                                                                                                                                                    |
| 2026-10-26 | Stale runs are reaped on demand (before a new run is enqueued) instead of by Cloud Scheduler, which would need extra deployer roles. Revisit if a stuck task ever matters before the next comment.                                                                                                                                                                                                                            |
| 2026-10-26 | The gateway is non-streaming for now; the output cap comes from the remaining budget, so the worst case is one over-long answer, not a runaway. Streaming is a phase 7 refinement.                                                                                                                                                                                                                                            |
| 2026-10-27 | Mac runs use the per-run identity; the device identity only claims runs and reports presence. The whole worker runs inside the sandbox on the Mac, not just shell commands.                                                                                                                                                                                                                                                   |
| 2026-10-26 | The Telegram bot token is a functions `.env` value written by the deploy workflow from a repo secret; move to Secret Manager once the deployer has `secretmanager.admin`.                                                                                                                                                                                                                                                     |
| 2026-10-26 | Gemini is called through the Vertex **global** endpoint (`VERTEX_LOCATION`, default `global`): europe-west1 does not serve the current models and regional endpoints cost about 10% more. Default model `gemini-3.8-flash`, titles `gemini-3.1-flash-lite`; prices in `packages/budget` checked against the Vertex pricing page on 2026-10-26 (3.x Flash promo prices double on 2027-01-01).                                  |
| 2026-10-29 | Two worker images and jobs (`dodo-worker`, `dodo-worker-browser`) instead of Chromium in every worker: a browser run costs about 10% more container time and a few seconds of cold start, so only runs that want a browser pay it. The remote browser holds its run for up to 10 minutes after a question instead of persisting browser state, which is the smaller step and covers MFA; the session store stays on the list. |
| 2026-10-30 | Remote browser logins are kept **per task** as an encrypted `storageState` blob, not per project or globally: no cross-task session collisions, and nothing to clean up beyond the task. Playwright MCP runs in-process on the worker's own context for this, instead of as a child process on a port.                                                                                                                        |
| 2026-10-29 | `auto` routing is deterministic for the device (your Mac when online, else remote unless a folder needs the Mac) and a cheapest-model question for the browser, with `request_browser` as the fallback when the question was answered wrong.                                                                                                                                                                                  |
| 2026-10-27 | Agent vault in **Google Secret Manager**, not Bitwarden: it is already in the stack (Jobs keep a token there), needs no extra account or bootstrap key (a Bitwarden access token would itself have to live in Secret Manager), access is limited to one service account by IAM and logged by Cloud Audit Logs. Values approved per task and per site; Firestore holds metadata only.                                          |
| 2026-10-26 | Repo checkout clones public GitHub repos only (`git clone --depth 50`); private repos wait for the credential work in phase 5.                                                                                                                                                                                                                                                                                                |
| 2026-10-30 | Stale runs are also reaped by a Cloud Scheduler job every 5 minutes (`reapRuns`, as the gateway account), so a task whose worker died shows it without a new comment. The on-demand check before an enqueue stays.                                                                                                                                                                                                            |
