# dodo — Architecture

dodo is a personal, asynchronous AI task agent. You create a task on a task board; an agent picks it up, works on it as far as it can, and reports back on the task itself: a top-down **Summary**, a **Status** with the next action or decision, and a thread with one collapsed message per agent run (expand it to see the full trace). You steer, answer questions, and approve risky or costly actions. You never need a chat window.

This document is the target design. [ROADMAP.md](ROADMAP.md) says in which order it gets built, and [SETUP.md](SETUP.md) lists what needs to be done by hand in GCP and Firebase.

---

## 1. Design principles

1. **Cost is a hard constraint, not a metric.** Every cost-bearing operation (model call, compute second, paid API call, purchase) goes through one gate that reserves budget *before* the operation runs. GCP-level caps sit underneath as a backstop.
2. **Deterministic controls, LLM reasoning.** Budgets, permissions, credential injection, timeouts and logging are code. The model reasons and decides when to ask; it never decides *whether* it is allowed to.
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
┌──────────────────────┐          │                 ┌────────────────────┐
│ Cloud Functions (v2) │          │                 │ Notion / Linear /  │
│  intake pipeline     │          │                 │ GitHub Issues      │
│  dispatcher          │          │                 └────────────────────┘
│  budget kill switch  │          │
│  notifications (FCM) │          │
└──────┬───────────────┘          │
       │ jobs.run (one execution per run)
       ▼                          ▼
┌──────────────────────┐   ┌────────────────────────┐
│ Remote executor      │   │ Local executor (Mac)   │
│ Cloud Run Job        │   │ `dodo` daemon (launchd)│
│ ephemeral container  │   │ sandboxed shell        │
│ headless Chromium    │   │ your real Chrome       │
└──────┬───────────────┘   └──────────┬─────────────┘
       └──────────────┬───────────────┘
                      ▼
             Worker core (same code in both)
   AgentRuntime (ADK) ─ ToolHost ─ PolicyEngine ─ CostGate ─ Secrets
                      │
          Gemini on Vertex AI (billed to the same GCP project)
```

Why this shape:

- **Firestore as queue and trace store** gives realtime UI updates, the run queue, and the live trace with zero extra infrastructure, inside the free tier (50k reads / 20k writes per day). Traces are written per step (tool call, message), never per token.
- **Cloud Run Jobs** give one throwaway container per run: a natural sandbox, billed per second, nothing running when idle, and a GCP-enforced timeout we derive from the task budget.
- **The Mac daemon** runs the same worker core, so local and remote behave identically except for the tools and browser they are given.

---

## 3. Stack

| Concern | Choice | Why |
| --- | --- | --- |
| Language | **TypeScript (strict) everywhere**, Node 22, pnpm workspaces | One language for UI, functions, worker and Mac CLI; shared zod schemas across all of them; first-class SDKs for Firebase, ADK (`@google/adk`), Anthropic Agent SDK, AG-UI, Playwright MCP, Notion, Linear, Octokit. *Alternative:* Python worker + TS UI (see decisions). |
| Schemas | zod | Runtime validation at every boundary, types for free. |
| Web app | Vite + React + shadcn/ui + TanStack Router, static SPA | Static files on Firebase Hosting are free (Next.js SSR would need paid Cloud Run). shadcn gives standard, good-looking components. |
| Auth | Firebase Auth (Google sign-in), allowlist of one uid | Free; security rules reject everyone else. |
| Data | Firestore (Native, `europe-west1`) | Free tier, realtime, transactions for the ledger and queue claims. |
| Files / artifacts | Cloud Storage for Firebase | 5 GB free; signed URLs for the agent. |
| Backend glue | Cloud Functions for Firebase (2nd gen) | Free tier of 2M invocations; triggers on Firestore, Pub/Sub, schedules. |
| Remote compute | Cloud Run Jobs | Per-second billing, scale to zero, free tier 180k vCPU-s / month. |
| Models | Gemini via Vertex AI | Billed to the same project, so it sits under the same GCP budget cap. Model ids and prices live in config. |
| Agent loop | Google ADK (JS) behind `AgentRuntime` | As requested; swappable for Claude Agent SDK or others. |
| Trace events | AG-UI event types (`@ag-ui/core`) | Standard vocabulary (RUN_STARTED, TOOL_CALL_START, TEXT_MESSAGE_CONTENT, ...). We store them in Firestore instead of using the SSE transport. Opens the door to AG-UI/CopilotKit components later. |
| Browser | Playwright MCP (`@playwright/mcp`) | Accessibility-tree based, widely used, works headless in a container *and* attached to your real Chrome via its browser extension. `chrome-devtools-mcp` is the fallback for local. |
| Local sandbox | `@anthropic-ai/sandbox-runtime` | Seatbelt on macOS / bubblewrap on Linux, with a network allowlist; the same thing Claude Code uses. |
| Notifications | Firebase Cloud Messaging web push to the installed PWA | Free; works on iPhone for home-screen web apps. Telegram bot as an optional second channel (see decisions). |
| Infra | `infra/` gcloud scripts + `firebase.json`; deploys from GitHub Actions with Workload Identity Federation | No long-lived keys anywhere. |
| Tests / lint | Vitest, Biome, Firebase emulators for integration tests | Fast, one tool each. |

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
  spend: { reservedEur, spentEur, byCategory }
  externalRefs: { notion?, linear?, github? }
tasks/{id}/messages/{id}  thread: author user|agent|system, body, runId?, input request?
tasks/{id}/artifacts/{id} kind file|link|text, role reference|output, storagePath|url, createdBy
runs/{id}                 taskId, device, model, state, lease, budget, trigger (new|comment|resume)
runs/{id}/events/{seq}    AG-UI events (step-level), cost annotations
inputRequests/{id}        taskId, runId, kind text|choice|approval, prompt, options, answer
ledger/{id}               append-only cost entries: scope ids, category, amount, reservation id
budgets/{scope}           running totals per global/month, project, task (transactional)
policies/{scope}          allow / ask / deny rules for global, project, task
devices/{id}              mac daemons: lastSeen, capabilities, folders
```

### Run lifecycle

```txt
queued ─► claimed ─► running ─┬─► waiting_input ─(answer)─► queued (resume)
                              ├─► interrupted   (you pressed stop or commented)
                              ├─► budget_exhausted
                              ├─► succeeded / failed
```

- **Claiming** is a Firestore transaction that sets a lease (`owner`, `expiresAt`). Workers heartbeat every 15 s. An expired lease puts the run back to `queued` (max retries 2).
- **Interrupt**: the UI sets `runs/{id}.interrupt = true`. The worker listens to its own run document and aborts at the next model or tool boundary (abort signal into the runtime and into any running process).
- **New comment while running**: interrupt, then enqueue a new run with the same session, so the comment is appended to the current context.
- **Waiting for input** ends the run and releases the container (no paid idle time). The answer enqueues a resume run that restores the session from Firestore.

---

## 5. Task flow

```txt
create task ─► intake pipeline ─► queue ─► executor ─► agent run ─► task updates
 (UI, voice)    (Cloud Function)   (runs)   (gcp|mac)   (tools)      (summary, status,
                                                                      thread, artifacts)
```

### Intake pipeline (modular mini-steps)

Each step is a small function `Step<In, Out>` registered by name; the pipeline is a list in config so steps can be swapped, reordered or disabled without touching the rest.

1. `transcribe` — push-to-talk audio → text (Gemini Flash-class; Web Speech API fallback in the browser for free).
2. `generateTitle` — if no title.
3. `applyProjectDefaults` — project values fill unset task fields.
4. `routeDevice` — `auto` → a very small model picks `gcp` or `mac` from the task text, tools and folder.
5. `routeModel` — `auto` → small model picks the model tier.
6. `estimateBudget` — (later phase) estimate and show before the run starts.
7. `enqueue` — create the `runs` doc, unless the task is not AI-enabled.

Routing steps return a reason string that is shown on the task, so a wrong choice is visible and correctable.

### Agent run

The worker builds the context (task fields, summary, thread, artifacts list, project instructions), gives the runtime the allowed tools, and streams events into `runs/{id}/events`. The task page renders them live; when the run ends they collapse into one thread message that links to the full trace.

### Communication contract

The agent writes to the task only through task tools, so the UI stays structured:

| Tool | Effect |
| --- | --- |
| `update_summary(markdown)` | Replaces the Summary: answer first, then supporting points (top-down, MECE). |
| `set_status(text, nextAction, needsYou)` | One-line state and the single next action or decision. |
| `post_message(markdown)` | Final message of the run in the thread (the collapsed message). |
| `ask_user(kind, prompt, options?)` | `text`, `choice` (buttons), or `approval`. Ends the run; resumes on answer. |
| `add_artifact` / `read_artifact` | Attachments and links, as reference or output. |
| `finish(outcome)` | Marks the task `review` or `done`. |

The system prompt carries the communication style from task-ai (top-down, concise, ask only when a decision would otherwise waste your review time), rewritten for this contract.

---

## 6. Plug-in boundaries

### 6.1 TaskConnector

```ts
interface TaskConnector {
  id: 'custom' | 'notion' | 'linear' | 'github';
  capabilities: {
    liveTrace: boolean;       // can show a message that updates while running
    editMessages: boolean;
    choiceInput: boolean;     // native buttons, else fall back to "reply 1/2/3"
    attachments: boolean;
  };
  watch(onChange: (e: ExternalTaskEvent) => void): Unsubscribe;  // webhooks or polling
  pullTask(ref: ExternalRef): Promise<ExternalTask>;
  pushTask(task: Task, changes: TaskChange[]): Promise<void>;     // summary, status, fields
  postMessage(ref: ExternalRef, msg: ThreadMessage): Promise<MessageRef>;
  updateMessage?(ref: MessageRef, msg: ThreadMessage): Promise<void>;
  requestInput(ref: ExternalRef, req: InputRequest): Promise<void>;
}
```

- **custom** (phase 1) is the native case: the web app reads Firestore directly, so the connector is a no-op passthrough.
- **notion** (`@notionhq/client`): Summary and Status as page properties or a pinned block at the top, thread as comments, task database chosen in settings, webhooks for changes.
- **linear** (`@linear/sdk`): Linear's agent API shows agent activity natively in the issue, which matches the live-trace idea well.
- **github** (Octokit): issue body section for Summary/Status, comments (editable) for the thread, labels for tags.

The web app keeps a one-time setting for which connector is active. Connectors only translate; the canonical model, queue, budget and policy live in dodo.

### 6.2 AgentRuntime

```ts
interface AgentRuntime {
  id: 'adk' | 'claude-agent-sdk' | string;
  run(input: RunInput, hooks: RuntimeHooks, signal: AbortSignal): AsyncIterable<AgUiEvent>;
}
interface RuntimeHooks {
  beforeModelCall(req: ModelCallPlan): Promise<ModelCallPermit>; // CostGate.reserve, may cap max tokens
  afterModelCall(usage: TokenUsage): Promise<void>;               // CostGate.settle
  executeTool(call: ToolCall): Promise<ToolResult>;               // PolicyEngine + CostGate + ToolHost
}
```

- Tools are defined once in our own format (name, zod input schema, cost model, policy key, execute) and converted by each adapter (ADK `FunctionTool`, Anthropic tool schema, MCP).
- The adapter must route **every** model call and tool call through the hooks. That is the only contract that keeps budget and permissions intact when the runtime is swapped. ADK exposes before/after model and tool callbacks, which map one-to-one.
- Session state (conversation so far) is serialised by the adapter into Firestore so runs can resume on another machine.

### 6.3 Executor

```ts
interface Executor {
  id: 'gcp' | `mac:${string}`;
  tools(): ToolDefinition[];      // what this environment can offer
  browser(): BrowserProvider;    // headless container Chromium, or your Chrome
  shell(): ShellProvider;        // container shell, or sandboxed Mac shell in the chosen folder
}
```

---

## 7. Budget and cost control

Two independent layers. The internal layer is real time and is what normally stops spending. The GCP layer is a backstop for bugs and runaway resources; it lags by hours, so it is set *below* the 50 EUR line.

### 7.1 GCP layer (backstop for the 50 EUR cap)

| Control | Setting | Effect |
| --- | --- | --- |
| Cloud Billing budget on project `dodo-512722` | 50 EUR, thresholds 50/80/90/100% of actual spend, Pub/Sub topic `billing-alerts` | Emails and an event for the kill switch. |
| `killSwitch` function (Pub/Sub) | at **≥ 40 EUR** actual: set `settings/global.halted = true`, cancel running Cloud Run executions, set Cloud Run Job max parallelism to 0. At **≥ 45 EUR**: **detach billing from the project** (Google's documented "cap costs" pattern). | Halt is reversible by you; detaching billing stops every paid service. |
| Quotas | Vertex AI tokens-per-minute capped low; Cloud Run Job max 2 concurrent executions, max task timeout 1 h | Limits how fast money can be spent while billing data lags. |
| Service account scoping | worker SA can only call Vertex AI, write its own run, read its secrets | A compromised run cannot create resources. |
| No public billable endpoints | Functions are triggered by Firestore/Pub/Sub, not public HTTP (except auth-checked callables) | No way for outsiders to run up costs. |

Caveat: billing data arrives with a delay of up to roughly a day, which is why the internal ledger exists and why the GCP thresholds sit at 40 and 45 EUR. Detaching billing is a blunt tool: paid services stop and some resources may not survive a long detach, so it is the last resort, not the normal stop.

### 7.2 Internal layer: CostGate and ledger (real time, per task)

Every cost-bearing operation follows **reserve → execute → settle**:

```ts
const r = await costGate.reserve({ scopes: [global, project, task], category, maxEur });
try { result = await op(r.limits); } finally { await costGate.settle(r, actualEur); }
```

- `reserve` is one Firestore transaction across the scope documents. It fails if *any* scope (task, project, monthly global) would go over its cap counting existing reservations. Nothing runs without a reservation.
- Categories, all counted against the same task budget:
  - **tokens**: reserve `input_tokens × in_price + max_output_tokens × out_price` before each call; `max_output_tokens` is lowered to fit what is left. Settled with actual usage.
  - **infra**: Cloud Run seconds × (vCPU + memory) price, reserved per minute by the heartbeat. The Cloud Run execution timeout is set from the remaining task budget at launch, so GCP itself kills an over-budget container. Mac runs cost 0 infra.
  - **actions**: each tool declares a cost model: `free`, `fixed(eur)`, `perUnit(fn)` (for example a Maps API call), or `unknown`. `unknown` and anything flagged as a payment always require approval and reserve the approved amount.
  - **purchases**: an approval card shows the amount; the approved amount is reserved before the agent continues. For a physical hard limit, we recommend a virtual card with its own spending limit for agent purchases.
- Prices (EUR, with a conservative USD→EUR rate) live in a versioned `pricing` table in code. Unknown models refuse to run.
- The ledger is append-only. The budget dashboard (spend per task, project, model, category, per day) is a read of the ledger plus the running totals.
- Reconciliation: a daily scheduled function compares ledger totals with the GCP billing export (when enabled) and flags drift.

Default caps (editable): global 35 EUR/month internal, project unset, task 0.50 EUR.

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
- **Bash parsing**: commands are parsed into a syntax tree, and every simple command (across `&&`, `;`, `|`, subshells, `$(...)`) must be allowed on its own. Redirections to files count as writes. Anything the parser cannot understand goes to *ask*.
- **Default mode** for actions no rule matches: `agent-decides` (your preference). The model gets a short written policy ("ask before anything irreversible, anything that costs money, anything that sends a message as you, anything outside the task folder") and calls `ask_user(kind: approval)` itself. Payments, unknown-cost tools, credential use for a new service, and outbound messages stay deterministic *ask* regardless.
- **Remote** runs are already inside a throwaway container. **Local** runs execute shell commands through the sandbox runtime: writes limited to the chosen folder, network limited to an allowlist.

### 8.2 Approval UX

An approval request shows what will happen, why, and the cost, with:

- **Approve once**
- **Always allow `Bash(git push:*)`**: the suggested rule is editable and has a scope picker (this task / project / everywhere)
- **Deny**, or **Deny and tell the agent why** (text goes back into the context)

Text questions and choice menus use the same `inputRequests` mechanism. Answering from the push notification opens the task with the card focused.

---

## 9. Browser, credentials and MFA

### 9.1 Browser control

- **Remote**: headless Chromium in the Cloud Run Job container, driven through Playwright MCP. Browser state per service (cookies, local storage) is saved as an encrypted Playwright `storageState` in Cloud Storage and restored next time.
- **Local**: Playwright MCP attached to **your running Chrome** through its browser extension, so the agent reuses your logged-in sessions. You can log in by hand and tell the agent to continue in that same tab.
- **Handoff**: a session you logged into locally can be exported to the remote session store, so remote runs can reuse it until it expires.
- Every browser action goes through the policy engine (`Browser(navigate:domain)`, `Browser(submit:*)`, downloads, payments).

### 9.2 Credentials (the agent never sees passwords)

- Credentials come from a **secret provider** behind an interface. The LLM only sees a reference like `{{secret:energy-provider.password}}`; the browser tool resolves it inside the tool and types it into the field. Values are redacted from traces and logs.
- Recommended provider: a **dedicated vault** in your password manager that holds only what agents may use (1Password service account or Bitwarden Secrets Manager both have SDKs and free or cheap tiers). Never the full vault. GCP Secret Manager is the fallback (a handful of secrets stays in the free tier).
- First use of a credential for a new service is always an approval.

### 9.3 MFA

- **TOTP**: optional per service, stored in the vault, generated inside the tool (only for services you mark low risk).
- **SMS / email / push codes, passkeys, CAPTCHA, device checks**: the run pauses with an input request ("Enter the code from your phone" or "Approve the login on your device, then press Continue"). Notification goes to your phone.
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

- The daemon signs in to Firebase as a **device identity** (custom token minted by a callable function after you approve the device in the web app), listens for queued runs with `device = mac:<id>`, and heartbeats `devices/{id}.lastSeen`. The UI shows whether the Mac is online; tasks routed to an offline Mac wait in the queue and say so.
- Tokens are kept in the macOS Keychain.
- Phase 1 for local can be even simpler: `dodo daemon` in a terminal tab.

---

## 11. Notifications

- Events that notify: input requested, run failed, budget threshold hit, task finished (configurable).
- **Web push via Firebase Cloud Messaging** to the installed PWA (desktop and iPhone home screen). Free, no extra accounts.
- Optional: a **Telegram bot** (free), which can carry Approve / Deny buttons right in the notification.
- Quiet hours and batching (one notification per task per 10 minutes) to keep noise down.

---

## 12. Security summary

- Firestore and Storage rules allow only your uid and the device/worker identities; the worker can only touch its own run and task.
- No service account keys: GitHub Actions deploy with Workload Identity Federation; workers use attached service accounts.
- Secrets never enter model context, traces or logs.
- Everything that leaves dodo (messages, purchases, posts) defaults to ask.

---

## 13. Cost estimate (personal use)

| Item | Expected monthly cost |
| --- | --- |
| Firebase Hosting, Auth, Firestore, FCM, Functions | 0 EUR (free tier) |
| Cloud Storage (artifacts, sessions) | 0 EUR under 5 GB |
| Cloud Run Jobs (1 vCPU / 2 GiB, ~20 h of runs) | ~0–2 EUR (free tier covers ~50 h of 1 vCPU) |
| Artifact Registry (worker image) | ~0.1 EUR |
| Gemini tokens | what you choose to spend; capped by task budgets and the monthly cap |

---

## 14. Open questions

Tracked in the PR description and the project thread; decisions are recorded here once made.
