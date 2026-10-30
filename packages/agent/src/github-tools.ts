import { execFile } from 'node:child_process';
import path from 'node:path';
import { BranchName } from '@dodo/core';
import { z } from 'zod';
import { inheritedEnv } from './exec-tools.js';
import { define, type ToolDef } from './tools.js';

/**
 * Pushing branches and opening pull requests on the run's repo (docs/GITHUB.md). The repo in
 * the task folder has no credentials: a plain `git push` fails. These tools get a token from the
 * control plane for this one push, after the policy engine asked you (`GitHub(push:owner/name)`,
 * `GitHub(pr:owner/name)`), and the control plane checks that approval again before it hands
 * out a write token. The token is passed to git for one command and never written to disk.
 */
export interface GitHubAccess {
  repo: string;
  /** Where the checkout is, relative to the task folder; the folder itself when absent. */
  dir?: string;
  defaultBranch?: string;
  /** Where to push; GitHub unless a test points it elsewhere. */
  remoteUrl?: string;
  /** A write token for the run's repo; refused without your approval. */
  writeToken(): Promise<string>;
  openPullRequest(req: {
    head: string;
    base?: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<{ url: string; number: number; existing: boolean }>;
}

/** Git's own option for one command: the token as a basic-auth header, nothing persisted. */
export function authHeaderArgs(token: string): string[] {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`];
}

function git(
  args: string[],
  cwd: string,
  timeoutMs = 120_000,
): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...inheritedEnv(), GIT_TERMINAL_PROMPT: '0', HOME: cwd, LANG: 'C.UTF-8' },
      },
      (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}`.trim() }),
    );
  });
}

async function push(
  access: GitHubAccess,
  cwd: string,
  branch: string,
): Promise<{ ok: true } | { error: string }> {
  if (branch === access.defaultBranch || ['main', 'master'].includes(branch))
    return {
      error: `Not pushing to ${branch}: work on a new branch and open a pull request instead.`,
    };
  const status = await git(['status', '--porcelain'], cwd, 10_000);
  if (!status.ok) return { error: `Not a git checkout: ${status.out.slice(0, 300)}` };
  let token: string;
  try {
    token = await access.writeToken();
  } catch (err) {
    return { error: (err as Error).message };
  }
  const r = await git(
    [
      ...authHeaderArgs(token),
      'push',
      access.remoteUrl ?? `https://github.com/${access.repo}.git`,
      `HEAD:refs/heads/${branch}`,
    ],
    cwd,
  );
  const out = r.out.split(token).join('***');
  if (!r.ok) return { error: `git push failed: ${out.slice(0, 2000)}` };
  return { ok: true };
}

/**
 * The tools for the run's repos. With one repo they work on it; with several, `repo` says which
 * (each is checked out in its own subfolder of the task folder).
 */
export function githubTools(accessOrList: GitHubAccess | GitHubAccess[]): ToolDef[] {
  const list = Array.isArray(accessOrList) ? accessOrList : [accessOrList];
  const first = list[0];
  if (!first) return [];
  const names = list.map((a) => a.repo) as [string, ...string[]];
  const multi = list.length > 1;
  const pick = (args: object) => {
    const repo = (args as { repo?: string }).repo?.toLowerCase();
    return list.find((a) => a.repo.toLowerCase() === repo) ?? first;
  };
  const cwd = (access: GitHubAccess, workdir: string | undefined) =>
    path.join(workdir ?? process.cwd(), access.dir ?? '.');
  const on = multi ? `one of ${names.join(', ')} (repo)` : first.repo;
  // One repo: no argument, so the tool reads as before.
  const repoArg = multi ? { repo: z.enum(names).describe('Which repository') } : {};
  const branchArg = BranchName.describe('Branch name, e.g. dodo/fix-login');
  return [
    define({
      name: 'push_branch',
      description: `Push the current commit (HEAD) of the checkout to a branch on ${on}. Commit first with bash (git checkout -b, git add, git commit). Never the default branch. Needs your approval unless allowed; plain git push has no credentials.`,
      schema: z.object({ ...repoArg, branch: branchArg }),
      policy: (args) => ({
        tool: 'GitHub',
        key: `push:${pick(args).repo}`,
        category: 'outbound',
      }),
      async execute(args, ctx) {
        const { branch } = args;
        const access = pick(args);
        const r = await push(access, cwd(access, ctx.workdir), branch);
        if ('error' in r) return { result: r };
        return { result: { ok: true, pushed: `${access.repo}@${branch}` } };
      },
    }),
    define({
      name: 'open_pull_request',
      description: `Push the current commit (HEAD) to a branch on ${on} and open a pull request for it (or return the one already open for that branch). Commit your changes first. Needs your approval unless allowed.`,
      schema: z.object({
        ...repoArg,
        branch: branchArg,
        title: z.string().min(1).max(256),
        body: z.string().max(60_000).default(''),
        base: BranchName.optional().describe('Target branch; the default branch if omitted'),
        draft: z.boolean().default(false),
      }),
      policy: (args) => ({ tool: 'GitHub', key: `pr:${pick(args).repo}`, category: 'outbound' }),
      async execute(args, ctx) {
        const { branch, title, body, base, draft } = args;
        const access = pick(args);
        const pushed = await push(access, cwd(access, ctx.workdir), branch);
        if ('error' in pushed) return { result: pushed };
        try {
          const pr = await access.openPullRequest({ head: branch, base, title, body, draft });
          if (!pr.existing)
            await ctx.store.addArtifact({
              kind: 'link',
              name: multi
                ? `${access.repo} PR #${pr.number}: ${title}`
                : `PR #${pr.number}: ${title}`,
              url: pr.url,
            });
          return { result: { ok: true, ...pr } };
        } catch (err) {
          return { result: { error: (err as Error).message } };
        }
      },
    }),
  ] as ToolDef[];
}
