import { z } from 'zod';
import { Timestamp } from './model.js';

/**
 * GitHub through a GitHub App you create from Settings › GitHub (the manifest flow) and install
 * on the repos you choose. The app's private key lives in Secret Manager; a run gets a token
 * for its own repo only, valid for an hour: read to clone, write only after you approved a push
 * or a pull request for the task. Firestore `github/app` holds what is safe to show.
 */

/** `owner/name`, as GitHub spells it. */
export const RepoName = z
  .string()
  .trim()
  .regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name');

export const GitHubRepo = z.object({
  fullName: z.string(),
  private: z.boolean().default(false),
  defaultBranch: z.string().default('main'),
});
export type GitHubRepo = z.infer<typeof GitHubRepo>;

/** `github/app`: written by the GitHub functions only, read by the owner. */
export const GitHubConnection = z.object({
  /** Set once the app exists (after the manifest flow). */
  app: z
    .object({
      id: z.number(),
      slug: z.string(),
      name: z.string(),
      htmlUrl: z.string(),
      owner: z.string().optional(),
      /** The app's bot account, which commits made by the agent are attributed to. */
      botLogin: z.string().optional(),
      botEmail: z.string().optional(),
      createdAt: Timestamp,
    })
    .optional(),
  /** Set once the app is installed on your account. */
  installation: z
    .object({
      id: z.number(),
      account: z.string(),
      /** `all` or `selected` repositories. */
      selection: z.string().default('selected'),
      htmlUrl: z.string().optional(),
      installedAt: Timestamp,
    })
    .optional(),
  repos: z.array(GitHubRepo).default([]),
  syncedAt: Timestamp.optional(),
  error: z.string().optional(),
  updatedAt: Timestamp.optional(),
});
export type GitHubConnection = z.infer<typeof GitHubConnection>;

/**
 * A run asks for a token for one of its own repos (the first when `repo` is absent). `write`
 * needs an approved push or pull request.
 */
export const GitHubTokenRequest = z.object({
  runId: z.string(),
  access: z.enum(['read', 'write']),
  repo: z.string().optional(),
});
export type GitHubTokenRequest = z.infer<typeof GitHubTokenRequest>;

export const GitHubTokenResponse = z.object({
  repo: z.string(),
  /** Absent when the app does not cover the repo (a public repo still clones without one). */
  token: z.string().optional(),
  expiresAt: z.string().optional(),
  defaultBranch: z.string().optional(),
  botLogin: z.string().optional(),
  botEmail: z.string().optional(),
  note: z.string().optional(),
});
export type GitHubTokenResponse = z.infer<typeof GitHubTokenResponse>;

/** A branch name we let the agent push: no refs/, no `..`, nothing git would refuse anyway. */
export const BranchName = z
  .string()
  .min(1)
  .max(200)
  .regex(/^(?!.*\.\.)(?!\/)(?!.*\/$)(?!.*\.lock$)[\w./-]+$/, 'a plain branch name');

export const GitHubOpenPrRequest = z.object({
  runId: z.string(),
  /** One of the run's repos; the first when absent. */
  repo: z.string().optional(),
  head: BranchName,
  base: BranchName.optional(),
  title: z.string().min(1).max(256),
  body: z.string().max(60_000).default(''),
  draft: z.boolean().default(false),
});
export type GitHubOpenPrRequest = z.input<typeof GitHubOpenPrRequest>;

/** The permission rules: `GitHub(push:owner/name)` and `GitHub(pr:owner/name)`. */
export const githubRule = (action: 'push' | 'pr', repo: string) => `GitHub(${action}:${repo})`;

/** At most this many repos are checked out for one run. */
export const MAX_REPOS = 5;

/** The repos one settings layer names: `repos`, else the older single `repo`. Cleaned, deduped. */
export function repoList(ai: { repo?: string; repos?: string[] } | undefined): string[] {
  const raw = ai?.repos?.length ? ai.repos : ai?.repo ? [ai.repo] : [];
  const out: string[] = [];
  for (const r of raw) {
    const name = r.trim().replace(/^https:\/\/github\.com\/|\.git$/g, '');
    if (!RepoName.safeParse(name).success) continue;
    if (out.some((o) => o.toLowerCase() === name.toLowerCase())) continue;
    out.push(name);
  }
  return out.slice(0, MAX_REPOS);
}

/** The repos a run works on: the task's own, else its project's. Malformed names are dropped. */
export function reposFor(
  task: { ai: { repo?: string; repos?: string[] } },
  project: { defaults: { repo?: string; repos?: string[] } } | undefined,
): string[] {
  const own = repoList(task.ai);
  return own.length ? own : repoList(project?.defaults);
}

/** The first repo a run works on, if any. */
export function repoFor(
  task: { ai: { repo?: string; repos?: string[] } },
  project: { defaults: { repo?: string; repos?: string[] } } | undefined,
): string | undefined {
  return reposFor(task, project)[0];
}

/**
 * Where a repo is checked out, relative to the task folder: the folder itself for a single repo,
 * else a subfolder named after the repo (`owner-name` when two repos share a name).
 */
export function repoDir(repo: string, repos: string[]): string {
  if (repos.length <= 1) return '.';
  const name = repo.split('/')[1] ?? repo;
  const clash = repos.filter((r) => (r.split('/')[1] ?? r).toLowerCase() === name.toLowerCase());
  return clash.length > 1 ? repo.replace('/', '-') : name;
}
