import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { PolicyEngine } from '@dodo/policy';
import { describe, expect, it } from 'vitest';
import { authHeaderArgs, type GitHubAccess, githubTools } from './github-tools.js';
import { MemoryTaskStore, sampleTask } from './testing.js';
import { findTool, type ToolDef } from './tools.js';

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  exec('git', args, { cwd, env: { ...process.env, HOME: cwd } });

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dodo-gh-'));
  const bare = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  await exec('git', ['init', '--bare', '--quiet', bare]);
  await exec('git', ['init', '--quiet', '-b', 'main', work]);
  await git(work, 'config', 'user.email', 't@example.com');
  await git(work, 'config', 'user.name', 'T');
  await writeFile(path.join(work, 'a.txt'), 'hi');
  await git(work, 'add', '.');
  await git(work, 'commit', '--quiet', '-m', 'first');
  const calls: string[] = [];
  const access: GitHubAccess = {
    repo: 'me/app',
    defaultBranch: 'main',
    remoteUrl: bare,
    writeToken: async () => {
      calls.push('token');
      return 'ghs_secret';
    },
    openPullRequest: async (req) => {
      calls.push(`pr:${req.head}`);
      return { url: 'https://github.com/me/app/pull/7', number: 7, existing: false };
    },
  };
  const store = new MemoryTaskStore(sampleTask());
  return { bare, work, access, calls, store, tools: githubTools(access) };
}

describe('github tools', () => {
  it('ask before pushing or opening a pull request', async () => {
    const { tools, store, work } = await setup();
    const policy = new PolicyEngine({ profile: 'agent-decides', allow: [], deny: [] });
    for (const [name, rule] of [
      ['push_branch', 'GitHub(push:me/app)'],
      ['open_pull_request', 'GitHub(pr:me/app)'],
    ] as const) {
      const tool = findTool(tools, name) as ToolDef;
      const claim = tool.policy?.({ branch: 'x', title: 't' }, { store, workdir: work });
      expect(policy.decide(claim as never)).toMatchObject({ kind: 'ask', suggestedRule: rule });
    }
  });

  it('push HEAD to a branch, never the default branch', async () => {
    const { tools, store, work, bare, calls } = await setup();
    const push = findTool(tools, 'push_branch') as ToolDef;
    const refused = await push.execute({ branch: 'main' }, { store, workdir: work });
    expect(refused.result.error).toMatch(/Not pushing to main/);
    expect(calls).toEqual([]);
    const ok = await push.execute({ branch: 'dodo/fix' }, { store, workdir: work });
    expect(ok.result).toMatchObject({ ok: true });
    const { stdout } = await exec('git', ['branch', '--list'], { cwd: bare });
    expect(stdout).toContain('dodo/fix');
  });

  it('open a pull request after pushing and attach its link', async () => {
    const { tools, store, work, calls } = await setup();
    const open = findTool(tools, 'open_pull_request') as ToolDef;
    const r = await open.execute(
      { branch: 'dodo/feature', title: 'Add a thing', body: '', draft: false },
      { store, workdir: work },
    );
    expect(r.result).toMatchObject({ ok: true, number: 7 });
    expect(calls).toEqual(['token', 'pr:dodo/feature']);
    expect((await store.listArtifacts()).map((a) => a.url)).toContain(
      'https://github.com/me/app/pull/7',
    );
  });

  it('pass the token as a one-command header', () => {
    const [flag, value] = authHeaderArgs('tok');
    expect(flag).toBe('-c');
    expect(value).toBe(
      `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from('x-access-token:tok').toString('base64')}`,
    );
  });
});
