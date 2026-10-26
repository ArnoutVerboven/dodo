/** Firestore collection and document paths, shared by the web app, functions and workers. */
export const paths = {
  settings: () => 'settings/global',
  tasks: () => 'tasks',
  task: (id: string) => `tasks/${id}`,
  messages: (taskId: string) => `tasks/${taskId}/messages`,
  artifacts: (taskId: string) => `tasks/${taskId}/artifacts`,
  projects: () => 'projects',
  project: (id: string) => `projects/${id}`,
  runs: () => 'runs',
  run: (id: string) => `runs/${id}`,
  runEvents: (runId: string) => `runs/${runId}/events`,
  /** Storage paths. */
  sessionBlob: (runId: string) => `runs/${runId}/session.json`,
  traceBlob: (runId: string) => `runs/${runId}/trace.json`,
  ledger: () => 'ledger',
  reservations: () => 'reservations',
  budgets: () => 'budgets',
  budget: (scopeKey: string) => `budgets/${scopeKey}`,
} as const;
