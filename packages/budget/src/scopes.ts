import { monthKey, type Scope } from './cost-gate.js';

/**
 * The scopes every cost of a task counts against: the lifetime total, the month,
 * the project's month and the task.
 */
export function scopesForTask(taskId: string, projectId: string | undefined, now: number): Scope[] {
  const month = monthKey(now);
  const scopes: Scope[] = [{ kind: 'total' }, { kind: 'global', month }, { kind: 'task', taskId }];
  if (projectId) scopes.push({ kind: 'project', projectId, month });
  return scopes;
}

/** A job's model calls count against the lifetime total, the month and the job's own month. */
export function scopesForJob(jobId: string, now: number): Scope[] {
  const month = monthKey(now);
  return [{ kind: 'total' }, { kind: 'global', month }, { kind: 'job', jobId, month }];
}
