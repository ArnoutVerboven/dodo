import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pickWorkdir } from './run.js';

const env = (allowedFolders?: string[]) => ({
  runId: 'r1',
  runToken: 't',
  firebase: { apiKey: 'k', projectId: 'p' },
  region: 'europe-west1',
  workRoot: '/work',
  allowedFolders,
});

describe('pickWorkdir', () => {
  it('uses a scratch folder when the task names none or the daemon allows none', () => {
    expect(pickWorkdir(undefined, 't1', env(['/Users/me/code']))).toBe('/work/t1');
    expect(pickWorkdir('/Users/me/code/app', 't1', env())).toBe('/work/t1');
    expect(pickWorkdir('/Users/me/code/app', 't1', env([]))).toBe('/work/t1');
  });

  it('uses the task folder only inside an allowed folder, with ~ and .. resolved', () => {
    const allowed = [path.join(os.homedir(), 'code')];
    expect(pickWorkdir('~/code/app', 't1', env(allowed))).toBe(
      path.join(os.homedir(), 'code', 'app'),
    );
    expect(pickWorkdir('~/code', 't1', env(allowed))).toBe(path.join(os.homedir(), 'code'));
    expect(pickWorkdir('~/code/../.ssh', 't1', env(allowed))).toBe('/work/t1');
    expect(pickWorkdir('~/codex', 't1', env(allowed))).toBe('/work/t1');
    expect(pickWorkdir('/etc', 't1', env(allowed))).toBe('/work/t1');
  });
});
