import { describe, expect, it } from 'vitest';
import { checkoutOf, proxyBypass, sandboxConfig, workerHosts } from './sandbox.js';

const inputs = {
  homeDir: '/Users/me',
  stateDir: '/Users/me/.dodo',
  workRoot: '/Users/me/.dodo/work',
  folders: ['/Users/me/code/app'],
  readable: ['/Users/me/code/dodo/apps/worker/dist', '/opt/homebrew/bin'],
  tmpDir: '/var/folders/x/T',
  projectId: 'dodo-512722',
  region: 'europe-west1',
};

describe('sandboxConfig', () => {
  const c = sandboxConfig(inputs);

  it('hides the home folder and the daemon state, except the task folders and what the worker needs', () => {
    expect(c.filesystem.denyRead).toEqual(['/Users/me', '/Users/me/.dodo']);
    expect(c.filesystem.allowRead).toEqual([
      '/Users/me/.dodo/work',
      '/Users/me/code/app',
      '/Users/me/code/dodo/apps/worker/dist',
      '/opt/homebrew/bin',
    ]);
  });

  it('lets the worker write only the task folders, the work folder and temp', () => {
    expect(c.filesystem.allowWrite).toEqual([
      '/Users/me/.dodo/work',
      '/Users/me/code/app',
      '/var/folders/x/T',
    ]);
    expect(c.filesystem.denyWrite).toEqual([
      '/Users/me/.dodo/config.json',
      '/Users/me/.dodo/auth.json',
      '/Users/me/.dodo/daemon.log',
    ]);
  });

  it('allows the control plane, GitHub and the registries, nothing wider', () => {
    expect(c.network.allowedDomains).toContain('europe-west1-dodo-512722.cloudfunctions.net');
    expect(c.network.allowedDomains).toContain('firestore.googleapis.com');
    expect(c.network.allowedDomains).not.toContain('*.googleapis.com');
    expect(c.network.allowedDomains.some((d) => d.includes('*'))).toBe(false);
    expect(c.network.allowedDomains).not.toContain('localhost');
    expect(c.network.deniedDomains).toEqual([]);
  });

  it('adds the emulator hosts only when paired against the emulators', () => {
    expect(workerHosts('demo-dodo', 'europe-west1', '127.0.0.1')).toEqual(
      expect.arrayContaining(['localhost', '127.0.0.1']),
    );
  });
});

describe('checkoutOf', () => {
  it('finds the repo above the worker bundle, else keeps the folder', () => {
    expect(checkoutOf('/Users/me/dodo/apps/worker/dist/index.js')).toBe('/Users/me/dodo');
    expect(checkoutOf('/opt/dodo-worker/index.js')).toBe('/opt/dodo-worker');
  });
});

describe('proxyBypass', () => {
  it('exempts only the proxy, in every spelling node compares against', () => {
    expect(proxyBypass(3128)).toBe('localhost:3128,127.0.0.1:3128,::1:3128,[::1]:3128');
    expect(proxyBypass(undefined)).toBeUndefined();
  });
});
