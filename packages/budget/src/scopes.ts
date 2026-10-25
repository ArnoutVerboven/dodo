import { type Scope, monthKey } from './cost-gate.js';

/** The scopes every cost of a task counts against: the month, the project's month, the task. */
export function scopesForTask(taskId: string, projectId: string | undefined, now: number): Scope[] {
  const month = monthKey(now);
  const scopes: Scope[] = [{ kind: 'global', month }, { kind: 'task', taskId }];
  if (projectId) scopes.push({ kind: 'project', projectId, month });
  return scopes;
}
