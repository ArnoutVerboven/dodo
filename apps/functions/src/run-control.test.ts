import { describe, expect, it } from 'vitest';
import { scopeKind } from './gateway.js';
import { exhaustedCap } from './run-control.js';

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
