import { describe, expect, it } from 'vitest';
import {
  type BrowserStateDeps,
  browserStatePath,
  decrypt,
  encrypt,
  loadBrowserState,
  onTaskClosed,
  saveBrowserState,
} from './browser-state.js';

const key = Buffer.alloc(32, 7);

/** A bucket double: files by path, with the three calls the module makes. */
function fakeStorage(files = new Map<string, Buffer>()) {
  const storage = {
    bucket: () => ({
      file: (path: string) => ({
        save: async (data: Buffer) => {
          files.set(path, data);
        },
        download: async () => {
          const data = files.get(path);
          if (!data) throw Object.assign(new Error('No such object'), { code: 404 });
          return [data];
        },
        delete: async () => {
          files.delete(path);
        },
      }),
    }),
  } as unknown as BrowserStateDeps['storage'];
  return { storage, files };
}

const state = JSON.stringify({
  cookies: [{ name: 'session', value: 'abc', domain: 'example.com' }],
  origins: [],
});

describe('browser state', () => {
  it('round-trips through the cipher with a fresh iv each time', () => {
    const a = encrypt(key, state);
    const b = encrypt(key, state);
    expect(a.equals(b)).toBe(false);
    expect(decrypt(key, a)).toBe(state);
    expect(() => decrypt(Buffer.alloc(32, 8), a)).toThrow();
  });

  it('saves encrypted, loads back, and is gone for an unknown task', async () => {
    const { storage, files } = fakeStorage();
    const deps = { storage, key: async () => key };
    await saveBrowserState(deps, 't1', { state, lastUrl: 'https://example.com/account' });
    expect(files.get(browserStatePath('t1'))?.includes('abc')).toBe(false);
    expect(await loadBrowserState(deps, 't1')).toEqual({
      state,
      lastUrl: 'https://example.com/account',
    });
    expect(await loadBrowserState(deps, 't2')).toBeUndefined();
  });

  it('drops a blob it cannot read instead of failing the run', async () => {
    const { storage, files } = fakeStorage();
    files.set(browserStatePath('t1'), Buffer.from('garbage'));
    const deps = { storage, key: async () => key, log: () => {} };
    expect(await loadBrowserState(deps, 't1')).toBeUndefined();
    expect(files.has(browserStatePath('t1'))).toBe(false);
  });

  it('keeps nothing for an empty state', async () => {
    const { storage, files } = fakeStorage();
    const deps = { storage, key: async () => key };
    await saveBrowserState(deps, 't1', { state });
    await saveBrowserState(deps, 't1', { state: JSON.stringify({ cookies: [], origins: [] }) });
    expect(files.has(browserStatePath('t1'))).toBe(false);
  });

  it('deletes the state when the task closes or disappears, not on other changes', async () => {
    const { storage, files } = fakeStorage();
    const deps = { storage, key: async () => key };
    await saveBrowserState(deps, 't1', { state });
    await onTaskClosed(deps, 't1', { status: 'todo' }, { status: 'in_progress' });
    expect(files.has(browserStatePath('t1'))).toBe(true);
    await onTaskClosed(deps, 't1', { status: 'review' }, { status: 'done' });
    expect(files.has(browserStatePath('t1'))).toBe(false);
    await saveBrowserState(deps, 't1', { state });
    await onTaskClosed(deps, 't1', { status: 'done' }, { status: 'done' });
    expect(files.has(browserStatePath('t1'))).toBe(true);
    await onTaskClosed(deps, 't1', { status: 'todo' }, undefined);
    expect(files.has(browserStatePath('t1'))).toBe(false);
  });
});
