import type { IngestTaskUpdate, IngestTaskView } from '@dodo/core';
import { describe, expect, it, vi } from 'vitest';
import type { JobRun, JobThread } from './model.js';
import type { JobStore, TaskSink } from './ports.js';
import { BudgetStop, type SourceState, type SourceSync, syncLinkedTasks } from './sync.js';

function setup(links: JobThread[], statuses: Record<string, IngestTaskView['status']>) {
  const saved = new Map<string, Record<string, unknown>>();
  const tasks: Record<string, IngestTaskView> = Object.fromEntries(
    Object.entries(statuses).map(([id, status]) => [
      id,
      { id, title: `Task ${id}`, status, priority: 'none', tags: [], updatedAt: 0 },
    ]),
  );
  const updates: Array<[string, IngestTaskUpdate]> = [];
  const posts: Array<[string, string]> = [];
  const transitions: string[] = [];
  const store = {
    openThreads: vi.fn(async () => links),
    setThread: vi.fn(async (_job: string, t: { id: string }) => {
      saved.set(t.id, t as Record<string, unknown>);
    }),
  } as unknown as JobStore;
  const sink = {
    get: async (id: string) => tasks[id],
    update: async (id: string, u: IngestTaskUpdate) => {
      updates.push([id, u]);
    },
    post: async (id: string, body: string) => {
      posts.push([id, body]);
      return 'msg';
    },
    transition: async (_t: string, messageId: string) => {
      transitions.push(messageId);
      return {};
    },
  } as unknown as TaskSink;
  const run: JobRun = {
    id: 'r1',
    jobId: 'j1',
    trigger: 'manual',
    dryRun: false,
    state: 'running',
    counts: {
      scanned: 0,
      skipped: 0,
      ignored: 0,
      created: 0,
      updated: 0,
      resolved: 0,
      removed: 0,
      failed: 0,
    },
    entries: [],
    spent: 0,
    startedAt: 0,
  };
  const ctx = (dryRun = false) => ({
    jobId: 'j1',
    dryRun,
    store,
    tasks: sink,
    run,
    now: () => 1000,
    max: 20,
  });
  return { saved, updates, posts, transitions, run, ctx, store };
}

const link = (id: string, extra: Partial<JobThread> = {}): JobThread => ({
  id,
  taskId: `task-${id}`,
  open: true,
  updatedAt: 0,
  ...extra,
});

function source(states: Record<string, SourceState>, recheck = vi.fn()): SourceSync {
  return {
    label: 'Gmail',
    inspect: async (l) => states[l.id] ?? { kind: 'unknown' },
    recheck,
  };
}

describe('syncLinkedTasks', () => {
  it('cancels the task when the source item is gone, and withdraws its pending cards', async () => {
    const s = setup([link('a', { approval: { taskId: 'task-a', messageId: 'card1' } })], {
      'task-a': 'todo',
    });
    await syncLinkedTasks(
      s.ctx(),
      source({ a: { kind: 'gone', reason: 'The email was deleted in Gmail' } }),
    );
    expect(s.updates).toEqual([
      [
        'task-a',
        {
          status: 'cancelled',
          statusLine: { text: 'The email was deleted in Gmail', needsYou: false },
        },
      ],
    ]);
    expect(s.transitions).toEqual(['card1']);
    expect(s.saved.get('a')).toMatchObject({ open: false, approval: null, event: null });
    expect(s.run.counts.removed).toBe(1);
    expect(s.run.entries[0]?.decision).toBe('remove');
  });

  it('after your answer: done closes the task, open keeps it with the next step, once per answer', async () => {
    const recheck = vi
      .fn()
      .mockResolvedValueOnce({ recheck: { action: 'done', reason: 'Settled' }, cost: 5 })
      .mockResolvedValueOnce({
        recheck: { action: 'open', reason: 'You promised the lease', nextStep: 'Send lease' },
        cost: 7,
      });
    const s = setup([link('a'), link('b'), link('c', { checkedRef: 'm-c' })], {
      'task-a': 'todo',
      'task-b': 'needs_input',
      'task-c': 'todo',
    });
    await syncLinkedTasks(
      s.ctx(),
      source(
        {
          a: { kind: 'answered', ref: 'm-a' },
          b: { kind: 'answered', ref: 'm-b' },
          c: { kind: 'answered', ref: 'm-c' },
        },
        recheck,
      ),
    );
    expect(recheck).toHaveBeenCalledTimes(2); // c was already rechecked for this answer
    expect(s.updates[0]).toEqual([
      'task-a',
      { status: 'done', statusLine: { text: 'You replied in Gmail', needsYou: false } },
    ]);
    expect(s.saved.get('a')).toMatchObject({ open: false, checkedRef: 'm-a' });
    expect(s.updates[1]).toEqual([
      'task-b',
      { statusLine: { text: 'Send lease', needsYou: true } },
    ]);
    expect(s.saved.get('b')).toMatchObject({ checkedRef: 'm-b' });
    expect(s.saved.get('b')?.open).toBe(true);
    expect(s.saved.get('c')).toBeDefined(); // touched, so it moves to the back of the queue
    expect(s.run.counts).toMatchObject({ resolved: 1, updated: 1 });
    expect(s.run.spent).toBe(12);
  });

  it('closes links of tasks closed on the board, and stops on a budget refusal', async () => {
    const recheck = vi.fn().mockRejectedValue(new BudgetStop('budget_exhausted'));
    const s = setup([link('a'), link('b'), link('c')], {
      'task-a': 'done',
      'task-b': 'todo',
      'task-c': 'todo',
    });
    const stop = await syncLinkedTasks(
      s.ctx(),
      source({ b: { kind: 'answered', ref: 'x' }, c: { kind: 'gone', reason: 'gone' } }, recheck),
    );
    expect(stop).toBe(true);
    expect(s.run.state).toBe('budget_exhausted');
    expect(s.saved.get('a')).toMatchObject({ open: false });
    expect(s.saved.has('c')).toBe(false); // not reached
  });

  it('writes nothing on a dry run', async () => {
    const s = setup([link('a')], { 'task-a': 'todo' });
    await syncLinkedTasks(s.ctx(true), source({ a: { kind: 'gone', reason: 'gone' } }));
    expect(s.updates).toEqual([]);
    expect(s.saved.size).toBe(0);
    expect(s.run.counts.removed).toBe(1);
  });
});
