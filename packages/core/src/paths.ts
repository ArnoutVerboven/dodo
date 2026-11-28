/** Firestore collection and document paths, shared by the web app, functions and workers. */
export const paths = {
  settings: () => 'settings/global',
  /** Personal info the agent may read (not secret). */
  profile: () => 'settings/profile',
  /** Vault entry metadata; values are in Secret Manager. */
  vault: () => 'vault',
  vaultEntry: (id: string) => `vault/${id}`,
  /** GitHub App connection (safe to show); its keys are in Secret Manager. */
  github: () => 'github/app',
  /** Notion connection (safe to show); the token is in Secret Manager. Server-written. */
  notion: () => 'connectors/notion',
  tasks: () => 'tasks',
  task: (id: string) => `tasks/${id}`,
  messages: (taskId: string) => `tasks/${taskId}/messages`,
  artifacts: (taskId: string) => `tasks/${taskId}/artifacts`,
  projects: () => 'projects',
  project: (id: string) => `projects/${id}`,
  runs: () => 'runs',
  run: (id: string) => `runs/${id}`,
  runEvents: (runId: string) => `runs/${runId}/events`,
  /** Live takeover of the cloud browser: `view` (worker) and `control` (owner). */
  runLiveView: (runId: string) => `runs/${runId}/live/view`,
  runLiveControl: (runId: string) => `runs/${runId}/live/control`,
  /** The owner's clicks and typing in the live view, replayed by the worker. */
  runLiveInput: (runId: string) => `runs/${runId}/liveInput`,
  /** Tools view: built-ins turned off, MCP servers, toolsets. */
  toolSettings: () => 'settings/tools',
  mcpServers: () => 'mcpServers',
  mcpServer: (id: string) => `mcpServers/${id}`,
  toolsets: () => 'toolsets',
  toolset: (id: string) => `toolsets/${id}`,
  devices: () => 'devices',
  device: (id: string) => `devices/${id}`,
  /** Standby workers (remote): a container started ahead of a run, waiting to take it. */
  standbys: () => 'standbys',
  standby: (id: string) => `standbys/${id}`,
  /** What standbys cost this month (server only), for their hard monthly cap. */
  standbyUsage: (month: string) => `standbyUsage/${month}`,
  /** Storage paths. */
  sessionBlob: (runId: string) => `runs/${runId}/session.json`,
  traceBlob: (runId: string) => `runs/${runId}/trace.json`,
  ledger: () => 'ledger',
  reservations: () => 'reservations',
  budgets: () => 'budgets',
  budget: (scopeKey: string) => `budgets/${scopeKey}`,
  /** Web push registrations, one document per FCM token (the token is the id). */
  pushTokens: () => 'pushTokens',
  pushToken: (token: string) => `pushTokens/${token}`,
  /** Task ingest API: tokens (owner-visible, hashed) and idempotency keys (server only). */
  apiTokens: () => 'apiTokens',
  apiToken: (id: string) => `apiTokens/${id}`,
  ingestKey: (id: string) => `ingestKeys/${id}`,
} as const;
