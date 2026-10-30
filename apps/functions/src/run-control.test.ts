import type { Run } from '@dodo/core';
import { describe, expect, it } from 'vitest';
import { scopeKind } from './gateway.js';
import { exhaustedCap, START_GRACE_MS, staleReason } from './run-control.js';
import { LEASE_MS } from './runtime.js';

describe('exhaustedCap', () => {
  it("reads the gateway's refusal: which cap, why, and what the call needed", () => {
    const cap = exhaustedCap(
      'budget_exhausted(monthly): the monthly budget has €0.03 left and this call needs €0.21 (280k input tokens)',
    );
    expect(cap.kind).toBe('monthly');
    expect(cap.why).toMatch(/^the monthly budget has/);
    expect(cap.needed).toBe(210_000);
  });

  it("is the task's budget when a worker gives no detail", () => {
    expect(exhaustedCap(undefined)).toEqual({ kind: 'task' });
    expect(exhaustedCap('something else')).toEqual({ kind: 'task' });
  });
});

describe('scopeKind', () => {
  it('names each scope key', () => {
    expect(scopeKind('total')).toBe('total');
    expect(scopeKind('global_2026-10')).toBe('monthly');
    expect(scopeKind('project_p1_2026-10')).toBe('project');
    expect(scopeKind('job_j1_2026-10')).toBe('job');
    expect(scopeKind('task_t1')).toBe('task');
  });
});

describe('staleReason', () => {
  const now = 10_000_000;
  const run = (patch: Partial<Run>): Run => ({
    id: 'r',
    taskId: 't',
    device: 'gcp',
    model: 'm',
    state: 'running',
    trigger: 'new',
    generation: 1,
    interrupt: false,
    compact: false,
    attempts: 1,
    spent: 0,
    steps: 0,
    createdAt: 1,
    updatedAt: now,
    ...patch,
  });

  it('reaps a running run only once its lease is well past', () => {
    expect(staleReason(run({ lease: { owner: 'x', expiresAt: now - LEASE_MS } }), now)).toBe(
      undefined,
    );
    expect(staleReason(run({ lease: { owner: 'x', expiresAt: now - 3 * LEASE_MS } }), now)).toMatch(
      /stopped responding/,
    );
  });

  it('reaps a remote run that never started, after the start grace', () => {
    for (const state of ['queued', 'dispatching'] as const) {
      expect(staleReason(run({ state, updatedAt: now - 60_000 }), now)).toBe(undefined);
      expect(staleReason(run({ state, updatedAt: now - START_GRACE_MS - 1 }), now)).toMatch(
        /never started/,
      );
    }
  });

  it('never reaps a run queued for a Mac: it waits for the daemon', () => {
    expect(staleReason(run({ state: 'queued', device: 'mac:studio', updatedAt: 1 }), now)).toBe(
      undefined,
    );
  });

  it('leaves ended runs alone', () => {
    for (const state of ['succeeded', 'failed', 'waiting_input', 'interrupted'] as const) {
      expect(staleReason(run({ state, updatedAt: 1 }), now)).toBe(undefined);
    }
  });
});
