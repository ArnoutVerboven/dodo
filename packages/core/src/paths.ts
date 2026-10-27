/** Firestore collection and document paths, shared by the web app, functions and workers. */
export const paths = {
  settings: () => 'settings/global',
  /** Personal info the agent may read (not secret). */
  profile: () => 'settings/profile',
  /** Vault entry metadata; values are in Secret Manager. */
  vault: () => 'vault',
  vaultEntry: (id: string) => `vault/${id}`,
  tasks: () => 'tasks',
  task: (id: string) => `tasks/${id}`,
  messages: (taskId: string) => `tasks/${taskId}/messages`,
  artifacts: (taskId: string) => `tasks/${taskId}/artifacts`,
  projects: () => 'projects',
  project: (id: string) => `projects/${id}`,
  runs: () => 'runs',
  run: (id: string) => `runs/${id}`,
  runEvents: (runId: string) => `runs/${runId}/events`,
  devices: () => 'devices',
  device: (id: string) => `devices/${id}`,
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
