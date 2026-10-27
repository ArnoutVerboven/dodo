import { describe, expect, it, vi } from 'vitest';
import { type DispatcherDeps, dispatch } from './dispatcher.js';

/** Minimal Firestore double with the transaction shape `dispatch` uses. */
function fakeDb(docs: Map<string, Record<string, unknown>>) {
  const doc = (path: string) => ({
    get: async () => ({ data: () => docs.get(path) }),
    update: async (data: Record<string, unknown>) => {
      const cur = docs.get(path) ?? {};
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'object' && 'operand' in (v as object)) {
          cur[k] = Number(cur[k] ?? 0) + Number((v as { operand: number }).operand);
        } else if (v && typeof v === 'object' && (v as { methodName?: string }).methodName) {
          delete cur[k]; // FieldValue.delete()
        } else cur[k] = v;
      }
      docs.set(path, cur);
    },
  });
  return {
    doc,
    runTransaction: async (fn: (t: unknown) => Promise<unknown>) =>
      fn({
        get: (r: { get: () => unknown }) => r.get(),
        update: (r: { update: (d: unknown) => unknown }, d: unknown) => r.update(d),
      }),
  } as unknown as DispatcherDeps['db'];
}

function setup(
  createCustomToken: () => Promise<string>,
  start = vi.fn(async () => 'exec-1'),
  extra: Array<[string, Record<string, unknown>]> = [],
) {
  const docs = new Map<string, Record<string, unknown>>([
    ['runs/r1', { state: 'queued', device: 'gcp', taskId: 't1', projectId: undefined }],
    ['tasks/t1', { status: 'in_progress', activeRunId: 'r1' }],
    ...extra,
  ]);
  const deps: DispatcherDeps = {
    db: fakeDb(docs),
    auth: { createCustomToken } as unknown as DispatcherDeps['auth'],
    costGate: { available: async () => 1_000_000 } as unknown as DispatcherDeps['costGate'],
    executor: { start },
    now: () => 1_000_000,
  };
  return { deps, docs, start };
}

describe('dispatch', () => {
  it('claims a queued run and starts the worker', async () => {
    const { deps, docs, start } = setup(async () => 'tok');
    expect(await dispatch(deps, 'r1')).toBe('started');
    expect(docs.get('runs/r1')).toMatchObject({
      state: 'claimed',
      execution: 'exec-1',
      generation: 1,
    });
    expect(start).toHaveBeenCalledOnce();
    // A second delivery of the same trigger finds nothing to do.
    expect(await dispatch(deps, 'r1')).toBe('skipped');
  });

  it('fails the run visibly when the identity cannot be minted', async () => {
    const { deps, docs, start } = setup(async () => {
      throw new Error('Permission iam.serviceAccounts.signBlob denied');
    });
    expect(await dispatch(deps, 'r1')).toBe('skipped');
    expect(docs.get('runs/r1')).toMatchObject({ state: 'failed', endReason: 'error' });
    expect(String(docs.get('runs/r1')?.error)).toContain('signBlob');
    expect(docs.get('tasks/t1')).toMatchObject({ status: 'needs_input' });
    expect(docs.get('tasks/t1')?.activeRunId).toBeUndefined();
    expect(start).not.toHaveBeenCalled();
  });

  it('leaves a Mac run queued and tells the task what it waits for', async () => {
    const { deps, docs, start } = setup(async () => 'tok', undefined, [
      ['runs/r1', { state: 'queued', device: 'mac:d1', taskId: 't1', createdAt: 0 }],
      ['devices/d1', { state: 'approved', name: 'MacBook', lastSeen: 1_000_000 }],
    ]);
    expect(await dispatch(deps, 'r1')).toBe('deferred');
    expect(docs.get('runs/r1')).toMatchObject({ state: 'queued' });
    expect(docs.get('tasks/t1')?.statusLine).toMatchObject({ text: 'Waiting for MacBook' });
    expect(start).not.toHaveBeenCalled();
  });

  it('says when the Mac is offline, and fails a run for a Mac that is not paired', async () => {
    const offline = setup(async () => 'tok', undefined, [
      ['runs/r1', { state: 'queued', device: 'mac:d1', taskId: 't1', createdAt: 0 }],
      ['devices/d1', { state: 'approved', name: 'MacBook', lastSeen: 0 }],
    ]);
    await dispatch(offline.deps, 'r1');
    expect(offline.docs.get('tasks/t1')?.statusLine).toMatchObject({
      text: expect.stringMatching(/offline/),
    });

    const revoked = setup(async () => 'tok', undefined, [
      ['runs/r1', { state: 'queued', device: 'mac:d9', taskId: 't1', createdAt: 0 }],
      ['devices/d9', { state: 'revoked', name: 'Old' }],
    ]);
    expect(await dispatch(revoked.deps, 'r1')).toBe('deferred');
    expect(revoked.docs.get('runs/r1')).toMatchObject({ state: 'failed' });
    expect(revoked.docs.get('tasks/t1')).toMatchObject({ status: 'needs_input' });
    expect(revoked.docs.get('tasks/t1')?.activeRunId).toBeUndefined();
  });
});
