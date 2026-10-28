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

/** A run asks for a token for its own repo. `write` needs an approved push or pull request. */
export const GitHubTokenRequest = z.object({
  runId: z.string(),
  access: z.enum(['read', 'write']),
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
  head: BranchName,
  base: BranchName.optional(),
  title: z.string().min(1).max(256),
  body: z.string().max(60_000).default(''),
  draft: z.boolean().default(false),
});
export type GitHubOpenPrRequest = z.input<typeof GitHubOpenPrRequest>;

/** The permission rules: `GitHub(push:owner/name)` and `GitHub(pr:owner/name)`. */
export const githubRule = (action: 'push' | 'pr', repo: string) => `GitHub(${action}:${repo})`;

/** The repo a run works on: the task's own, else its project's. Empty or malformed is none. */
export function repoFor(
  task: { ai: { repo?: string } },
  project: { defaults: { repo?: string } } | undefined,
): string | undefined {
  const raw = (task.ai.repo?.trim() || project?.defaults.repo?.trim() || '').replace(
    /^https:\/\/github\.com\/|\.git$/g,
    '',
  );
  return RepoName.safeParse(raw).success ? raw : undefined;
}
