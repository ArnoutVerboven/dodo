import { DEVICE_PROTOCOL } from '@dodo/core';
import { describe, expect, it, vi } from 'vitest';
import {
  claimRun,
  type DeviceDeps,
  egressCheck,
  onDeviceChanged,
  registerDevice,
  releaseRun,
} from './devices.js';

/** Firestore double with the transaction shape the device functions use. */
function fakeDb(initial: Record<string, Record<string, unknown>>) {
  const docs = new Map(Object.entries(structuredClone(initial)));
  let n = 0;
  const apply = (path: string, data: Record<string, unknown>) => {
    const cur = docs.get(path) ?? {};
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && 'operand' in (v as object)) {
        cur[k] = Number(cur[k] ?? 0) + Number((v as { operand: number }).operand);
      } else if (v && typeof v === 'object' && (v as { methodName?: string }).methodName) {
        delete cur[k];
      } else cur[k] = v;
    }
    docs.set(path, cur);
  };
  const doc = (path: string) => ({
    id: path.split('/').pop(),
    path,
    get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
    update: async (d: Record<string, unknown>) => apply(path, d),
  });
  const db = {
    doc,
    collection: (c: string) => ({ doc: () => doc(`${c}/new${++n}`) }),
    runTransaction: async (fn: (t: unknown) => Promise<unknown>) =>
      fn({
        get: (r: { get: () => unknown }) => r.get(),
        update: (r: { path: string }, d: Record<string, unknown>) => apply(r.path, d),
        create: (r: { path: string }, d: Record<string, unknown>) => {
          if (docs.has(r.path)) throw new Error('exists');
          docs.set(r.path, { ...d });
        },
      }),
  };
  return { db: db as unknown as DeviceDeps['db'], docs };
}

function deps(initial: Record<string, Record<string, unknown>>) {
  const { db, docs } = fakeDb(initial);
  const createCustomToken = vi.fn(async (uid: string) => `tok-${uid}`);
  const revokeRefreshTokens = vi.fn(async () => {});
  const deleteUser = vi.fn(async () => {});
  const d: DeviceDeps = {
    db,
    auth: { createCustomToken, revokeRefreshTokens, deleteUser },
    now: () => 1_000_000,
  };
  return { deps: d, docs, createCustomToken, revokeRefreshTokens, deleteUser };
}

const caller = (id: string) => ({ uid: `device:${id}`, claims: { device: id } });

describe('registerDevice', () => {
  const req = { code: 'abc123xyz', name: 'MacBook', platform: 'darwin', protocol: 1 };

  it('turns a fresh pairing code into an approved device and a device token', async () => {
    const t = deps({
      'settings/global': { devicePairing: { code: 'abc123xyz', createdAt: 990_000 } },
    });
    const res = await registerDevice(t.deps, req);
    expect(res.deviceId).toBe('new1');
    expect(res.token).toBe('tok-device:new1');
    expect(t.createCustomToken).toHaveBeenCalledWith('device:new1', { device: 'new1' });
    expect(t.docs.get('devices/new1')).toMatchObject({
      name: 'MacBook',
      state: 'approved',
      protocol: 1,
    });
    expect(t.docs.get('settings/global')?.devicePairing).toBeUndefined(); // single use
  });

  it('refuses a wrong, used or expired code', async () => {
    const wrong = deps({
      'settings/global': { devicePairing: { code: 'other', createdAt: 990_000 } },
    });
    await expect(registerDevice(wrong.deps, req)).rejects.toThrow(/Wrong/);
    const used = deps({ 'settings/global': {} });
    await expect(registerDevice(used.deps, req)).rejects.toThrow(/Wrong/);
    const old = deps({ 'settings/global': { devicePairing: { code: 'abc123xyz', createdAt: 0 } } });
    await expect(registerDevice(old.deps, req)).rejects.toThrow(/expired/);
    expect(old.docs.has('devices/new1')).toBe(false);
    expect(old.createCustomToken).not.toHaveBeenCalled();
  });
});

describe('claimRun', () => {
  const base = {
    'devices/d1': { state: 'approved', name: 'MacBook' },
    'devices/d2': { state: 'revoked', name: 'Old' },
    'runs/r1': { state: 'queued', device: 'mac:d1', taskId: 't1', generation: 0 },
    'runs/r2': { state: 'queued', device: 'gcp', taskId: 't2', generation: 0 },
    'runs/r3': { state: 'queued', device: 'mac:d2', taskId: 't3', generation: 0 },
  };
  const req = (deviceId: string, runId: string, protocol = DEVICE_PROTOCOL) => ({
    deviceId,
    runId,
    protocol,
    version: '0.1.0',
  });

  it('claims a queued run for its device and mints the run identity', async () => {
    const t = deps(base);
    const res = await claimRun(t.deps, caller('d1'), req('d1', 'r1'));
    expect(res).toMatchObject({
      token: 'tok-run:r1',
      taskId: 't1',
      generation: 1,
      timeoutSeconds: 3600,
    });
    expect(t.createCustomToken).toHaveBeenCalledWith('run:r1', {
      run: 'r1',
      taskId: 't1',
      generation: 1,
    });
    expect(t.docs.get('runs/r1')).toMatchObject({
      state: 'claimed',
      generation: 1,
      attempts: 1,
      execution: 'mac:d1',
      lease: { owner: 'device:d1', expiresAt: 1_060_000 },
    });
    expect(t.docs.get('devices/d1')).toMatchObject({
      currentRunId: 'r1',
      version: '0.1.0',
      lastSeen: 1_000_000,
    });
    // A second claim of the same run finds it taken.
    await expect(claimRun(t.deps, caller('d1'), req('d1', 'r1'))).rejects.toThrow(/Run is claimed/);
  });

  it("refuses another device's run, a revoked device, a stranger and an old daemon", async () => {
    const t = deps(base);
    await expect(claimRun(t.deps, caller('d1'), req('d1', 'r2'))).rejects.toThrow(/another device/);
    await expect(claimRun(t.deps, caller('d2'), req('d2', 'r3'))).rejects.toThrow(/revoked/);
    await expect(claimRun(t.deps, caller('d1'), req('d2', 'r3'))).rejects.toThrow(
      /Not this device/,
    );
    await expect(
      claimRun(t.deps, { uid: 'owner', claims: { dodo_owner: true } }, req('d1', 'r1')),
    ).rejects.toThrow(/Not this device/);
    await expect(claimRun(t.deps, undefined, req('d1', 'r1'))).rejects.toThrow(/Sign in/);
    await expect(
      claimRun(t.deps, caller('d1'), req('d1', 'r1', DEVICE_PROTOCOL - 1)),
    ).rejects.toThrow(/update_needed/);
    expect(t.docs.get('runs/r1')).toMatchObject({ state: 'queued' });
    expect(t.createCustomToken).not.toHaveBeenCalled();
  });
});

describe('onDeviceChanged', () => {
  it('revokes the sign-in when a device is revoked, and deletes it when removed', async () => {
    const t = deps({});
    await onDeviceChanged(t.deps, 'd1', { state: 'approved' }, { state: 'revoked' });
    expect(t.revokeRefreshTokens).toHaveBeenCalledWith('device:d1');
    expect(t.deleteUser).not.toHaveBeenCalled();
    await onDeviceChanged(t.deps, 'd1', { state: 'revoked' }, undefined);
    expect(t.deleteUser).toHaveBeenCalledWith('device:d1');
  });

  it('does nothing on presence updates or a second revoke', async () => {
    const t = deps({});
    await onDeviceChanged(t.deps, 'd1', { state: 'approved' }, { state: 'approved' });
    await onDeviceChanged(t.deps, 'd1', { state: 'revoked' }, { state: 'revoked' });
    await onDeviceChanged(t.deps, 'd1', undefined, { state: 'approved' });
    expect(t.revokeRefreshTokens).not.toHaveBeenCalled();
  });
});

describe('egressCheck', () => {
  const world = (extra: Record<string, Record<string, unknown>> = {}) => ({
    'devices/mac1': { state: 'approved', name: 'MacBook' },
    'runs/run1': { taskId: 't1', device: 'mac:mac1', state: 'running' },
    'tasks/t1': { title: 'x', ai: { enabled: true }, allowedHosts: ['api.example.com'] },
    'settings/global': { allowedHosts: ['github.com'] },
    ...extra,
  });
  const req = { deviceId: 'mac1', runId: 'run1', host: 'api.example.com' };

  it('allows a host from the task, project or global allowed hosts', async () => {
    const { deps: d } = deps(world());
    expect(await egressCheck(d, caller('mac1'), req)).toEqual({
      allow: true,
      by: 'allowed host api.example.com',
    });
    expect(await egressCheck(d, caller('mac1'), { ...req, host: 'raw.github.com' })).toMatchObject({
      allow: true,
    });
  });

  it('denies a host nothing allows, and anything once the run is over', async () => {
    const { deps: d } = deps(world());
    expect(await egressCheck(d, caller('mac1'), { ...req, host: 'evil.test' })).toEqual({
      allow: false,
    });
    const over = deps(
      world({ 'runs/run1': { taskId: 't1', device: 'mac:mac1', state: 'succeeded' } }),
    );
    expect(await egressCheck(over.deps, caller('mac1'), req)).toEqual({
      allow: false,
      by: 'run is succeeded',
    });
  });

  it('counts the approval the user just gave for the command that reaches the host', async () => {
    const { deps: d } = deps(
      world({
        'runs/run1': {
          taskId: 't1',
          device: 'mac:mac1',
          state: 'claimed',
          answer: { value: 'yes', suggestedRule: 'Bash(curl https://pypi.org/simple/)' },
        },
      }),
    );
    expect(await egressCheck(d, caller('mac1'), { ...req, host: 'pypi.org' })).toEqual({
      allow: true,
      by: 'Bash(curl https://pypi.org/simple/)',
    });
    expect(
      await egressCheck(d, caller('mac1'), { ...req, host: 'files.pythonhosted.org' }),
    ).toEqual({
      allow: false,
    });
  });

  it("refuses another device, a revoked device and a run that is not this Mac's", async () => {
    const { deps: d } = deps(world());
    await expect(egressCheck(d, caller('mac2'), req)).rejects.toThrow(/Not this device/);
    const revoked = deps(world({ 'devices/mac1': { state: 'revoked' } }));
    await expect(egressCheck(revoked.deps, caller('mac1'), req)).rejects.toThrow(/revoked/);
    const other = deps(
      world({ 'runs/run1': { taskId: 't1', device: 'mac:mac9', state: 'running' } }),
    );
    await expect(egressCheck(other.deps, caller('mac1'), req)).rejects.toThrow(/another device/);
  });
});

describe('releaseRun', () => {
  const world = (state: string) => ({
    'devices/mac1': { state: 'approved', name: 'MacBook' },
    'runs/run1': { taskId: 't1', device: 'mac:mac1', state },
  });

  it('ends a live run whose worker died, through the finish path', async () => {
    const { deps: d } = deps(world('running'));
    const finished = vi.fn(async () => {});
    const req = { deviceId: 'mac1', runId: 'run1', exitCode: 127 };
    expect(await releaseRun(d, caller('mac1'), req, finished)).toEqual({ released: true });
    expect(finished).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'run1', taskId: 't1' }),
      'the worker on this Mac exited with code 127',
    );
  });

  it('leaves a run alone that already ended, and refuses another device', async () => {
    const finished = vi.fn(async () => {});
    const done = deps(world('succeeded'));
    expect(
      await releaseRun(
        done.deps,
        caller('mac1'),
        { deviceId: 'mac1', runId: 'run1', exitCode: 0 },
        finished,
      ),
    ).toEqual({ released: false });
    expect(finished).not.toHaveBeenCalled();
    const { deps: d } = deps(world('claimed'));
    await expect(
      releaseRun(d, caller('mac2'), { deviceId: 'mac2', runId: 'run1', exitCode: null }, finished),
    ).rejects.toThrow();
  });
});
