import os from 'node:os';
import path from 'node:path';
import { execTools, taskTools } from '@dodo/agent';
import { describe, expect, it } from 'vitest';
import { filterBuiltins, pickWorkdir, vaultNeedsBrowser, withBrowserHint } from './run.js';

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

describe('withBrowserHint', () => {
  const fetchDesc = (tools: typeof execTools) =>
    tools.find((t) => t.name === 'http_fetch')?.description ?? '';
  it('points http_fetch at the browser only when the run has one', () => {
    expect(fetchDesc(withBrowserHint(execTools, true))).toContain('use browser_navigate instead');
    expect(fetchDesc(withBrowserHint(execTools, false))).not.toContain('browser_navigate');
    expect(fetchDesc(execTools)).not.toContain('browser_navigate');
  });
});

describe('vaultNeedsBrowser', () => {
  const vault = (tools: typeof taskTools) =>
    tools.find((t) => t.name === 'request_vault_access') as (typeof taskTools)[number];
  it('restarts with a browser instead of asking for a vault entry on Browser Auto', async () => {
    const out = await vault(vaultNeedsBrowser(taskTools, true)).execute(
      { entryId: 'albert-heijn', reason: 'log in' },
      {} as never,
    );
    expect(out).toMatchObject({ needsBrowser: true });
    expect(vault(vaultNeedsBrowser(taskTools, false))).toBe(vault(taskTools));
  });
});
