import os from 'node:os';
import path from 'node:path';
import { taskTools } from '@dodo/agent';
import { describe, expect, it } from 'vitest';
import { filterBuiltins, pickWorkdir } from './run.js';

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

describe('filterBuiltins', () => {
  it('drops tools the Tools view turned off, never the core ones', () => {
    const names = (only?: string[]) =>
      filterBuiltins(taskTools, {
        builtins: { disabled: ['list_vault', 'finish'], only },
        mcp: [],
        toolsets: [],
      }).map((t) => t.name);
    expect(names()).not.toContain('list_vault');
    expect(names()).toContain('finish');
    expect(names(['get_personal_info'])).toEqual([
      'update_summary',
      'set_status',
      'post_message',
      'ask_user',
      'get_personal_info',
      'finish',
    ]);
    expect(filterBuiltins(taskTools, undefined)).toHaveLength(taskTools.length);
  });
});
