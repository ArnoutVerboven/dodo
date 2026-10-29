import { createSign, randomBytes } from 'node:crypto';
import {
  GitHubConnection,
  GitHubOpenPrRequest,
  type GitHubRepo,
  type GitHubTokenResponse,
  githubRule,
  isApproved,
  paths,
  type Run,
  repoFor,
} from '@dodo/core';
import { matches, parseRule } from '@dodo/policy';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { VaultSecretStore } from './vault.js';

/**
 * GitHub for the agent, through a GitHub App (docs/GITHUB.md).
 *
 * Setup is two clicks in Settings › GitHub: "Create the GitHub App" posts a manifest to GitHub,
 * which creates the app and redirects to `githubCallback` with a one-time code; we trade it for
 * the app's id and private key (into Secret Manager, `dodo-github-app`) and send you on to
 * install the app on the repos you pick. The install redirects back to the same callback.
 *
 * At run time the worker asks `githubToken` for an installation token scoped to the run's one
 * repo, valid for an hour: read access for the checkout, write access only when you approved a
 * push or pull request on that task (or an allow rule covers it). Pull requests are opened here
 * with the app's own token, so the worker never holds a pull-request permission.
 */

export const GITHUB_SECRET = 'dodo-github-app';
const API = 'https://api.github.com';
const STATE_TTL_MS = 30 * 60_000;
const statePath = (s: string) => `oauthStates/${s}`;

export interface GitHubAppSecret {
  appId: string;
  slug: string;
  pem: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
}

export interface GitHubDeps {
  db: Firestore;
  /** `{ app: GitHubAppSecret }` in a JSON secret. */
  secrets: VaultSecretStore;
  fetch?: typeof fetch;
  now?: () => number;
  /** The web app, where the flow ends. */
  appUrl: string;
  /** This function's public URL (`githubCallback`). */
  callbackUrl: string;
  /** Used to give the app a unique name. */
  projectId: string;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

export class GitHubError extends Error {
  constructor(
    readonly code: 'invalid-argument' | 'not-found' | 'permission-denied' | 'failed-precondition',
    message: string,
  ) {
    super(message);
  }
}

/* ------------------------------ GitHub API ------------------------------ */

async function gh<T>(
  deps: GitHubDeps,
  path: string,
  init: { method?: string; token?: string; jwt?: string; body?: unknown } = {},
): Promise<T> {
  const auth = init.jwt ? `Bearer ${init.jwt}` : init.token ? `token ${init.token}` : undefined;
  const res = await (deps.fetch ?? fetch)(`${API}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dodo',
      ...(auth ? { authorization: auth } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : {};
  if (!res.ok) {
    const msg = (json as { message?: string }).message ?? text.slice(0, 200);
    throw Object.assign(new Error(`GitHub ${init.method ?? 'GET'} ${path}: ${res.status} ${msg}`), {
      status: res.status,
      body: json,
    });
  }
  return json as T;
}

/** The app's own identity: a JWT signed with its private key, valid for nine minutes. */
export function appJwt(secret: Pick<GitHubAppSecret, 'appId' | 'pem'>, nowMs: number): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const iat = Math.floor(nowMs / 1000) - 60;
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat, exp: iat + 540, iss: secret.appId })}`;
  const sig = createSign('RSA-SHA256').update(unsigned).sign(secret.pem).toString('base64url');
  return `${unsigned}.${sig}`;
}

async function appSecret(deps: GitHubDeps): Promise<GitHubAppSecret | undefined> {
  const v = (await deps.secrets.read()).app as GitHubAppSecret | undefined;
  return v?.appId && v.pem ? v : undefined;
}

async function connection(deps: GitHubDeps): Promise<GitHubConnection> {
  const snap = await deps.db.doc(paths.github()).get();
  return GitHubConnection.parse(snap.exists ? snap.data() : {});
}

const now = (deps: GitHubDeps) => (deps.now ?? Date.now)();

interface InstallationToken {
  token: string;
  expires_at: string;
}

/** An installation token, narrowed to the given repos and permissions. */
async function installationToken(
  deps: GitHubDeps,
  secret: GitHubAppSecret,
  installationId: number,
  scope?: { repos: string[]; permissions: Record<string, 'read' | 'write'> },
): Promise<InstallationToken> {
  return gh<InstallationToken>(deps, `/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    jwt: appJwt(secret, now(deps)),
    body: scope ? { repositories: scope.repos, permissions: scope.permissions } : {},
  });
}

/* ------------------------------- setup flow ------------------------------ */

async function newState(deps: GitHubDeps, kind: 'manifest' | 'install', uid = '') {
  const state = randomBytes(24).toString('base64url');
  await deps.db.doc(statePath(state)).set({ uid, provider: 'github', kind, createdAt: now(deps) });
  return state;
}

/** Single use: deleted in the same transaction that reads it. */
async function takeState(deps: GitHubDeps, state: string | undefined, kind: string) {
  if (!state) return false;
  const ref = deps.db.doc(statePath(state));
  const data = await deps.db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) return undefined;
    t.delete(ref);
    return snap.data() as { provider?: string; kind?: string; createdAt?: number };
  });
  return (
    !!data &&
    data.provider === 'github' &&
    data.kind === kind &&
    now(deps) - (data.createdAt ?? 0) < STATE_TTL_MS
  );
}

export function appManifest(deps: GitHubDeps) {
  return {
    name: `dodo-${deps.projectId}`.slice(0, 34),
    description: 'Lets your dodo agent clone your repos, push branches and open pull requests.',
    url: deps.appUrl,
    hook_attributes: { url: deps.callbackUrl, active: false },
    redirect_url: deps.callbackUrl,
    setup_url: deps.callbackUrl,
    setup_on_update: true,
    public: false,
    // No `workflows`: the agent cannot change CI, which holds the deploy credentials.
    default_permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
    default_events: [],
  };
}

/**
 * Settings › GitHub, first step. Returns what the browser posts to GitHub: before the app
 * exists, the manifest form; afterwards, the install page.
 */
export async function startGitHubConnect(
  deps: GitHubDeps,
  uid: string,
  org?: string,
): Promise<
  { kind: 'manifest'; postUrl: string; manifest: string } | { kind: 'install'; url: string }
> {
  const secret = await appSecret(deps);
  if (secret) {
    const state = await newState(deps, 'install', uid);
    return {
      kind: 'install',
      url: `https://github.com/apps/${secret.slug}/installations/new?state=${state}`,
    };
  }
  if (org && !/^[\w-]+$/.test(org)) throw new GitHubError('invalid-argument', 'Not an org name');
  const state = await newState(deps, 'manifest', uid);
  const base = org
    ? `https://github.com/organizations/${org}/settings/apps/new`
    : 'https://github.com/settings/apps/new';
  return {
    kind: 'manifest',
    postUrl: `${base}?state=${state}`,
    manifest: JSON.stringify(appManifest(deps)),
  };
}

interface ManifestConversion {
  id: number;
  slug: string;
  name: string;
  html_url: string;
  owner?: { login: string };
  client_id: string;
  client_secret: string;
  webhook_secret: string | null;
  pem: string;
}

/**
 * GitHub redirects here twice: after creating the app (`code`) and after installing it
 * (`installation_id`). Returns where to send the browser next.
 */
export async function completeGitHubConnect(
  deps: GitHubDeps,
  q: { code?: string; state?: string; installation_id?: string; setup_action?: string },
): Promise<string> {
  const back = (result: string) => `${deps.appUrl}/settings?github=${encodeURIComponent(result)}`;
  try {
    if (q.installation_id) return back(await completeInstall(deps, q));
    if (!q.code) return back('error');
    if (!(await takeState(deps, q.state, 'manifest'))) return back('invalid_state');
    const app = await gh<ManifestConversion>(
      deps,
      `/app-manifests/${encodeURIComponent(q.code)}/conversions`,
      { method: 'POST' },
    );
    const secret: GitHubAppSecret = {
      appId: String(app.id),
      slug: app.slug,
      pem: app.pem,
      clientId: app.client_id,
      clientSecret: app.client_secret,
      webhookSecret: app.webhook_secret ?? '',
    };
    const all = await deps.secrets.read();
    await deps.secrets.write({ ...all, app: { ...secret } });
    const bot = await gh<{ id: number; login: string }>(
      deps,
      `/users/${encodeURIComponent(`${app.slug}[bot]`)}`,
    ).catch(() => undefined);
    await deps.db.doc(paths.github()).set(
      {
        app: {
          id: app.id,
          slug: app.slug,
          name: app.name,
          htmlUrl: app.html_url,
          ...(app.owner ? { owner: app.owner.login } : {}),
          botLogin: bot?.login ?? `${app.slug}[bot]`,
          botEmail: bot
            ? `${bot.id}+${bot.login}@users.noreply.github.com`
            : `${app.slug}[bot]@users.noreply.github.com`,
          createdAt: now(deps),
        },
        error: FieldValue.delete(),
        updatedAt: now(deps),
      },
      { merge: true },
    );
    deps.log?.('github app created', { slug: app.slug });
    // Straight on to installing it.
    const state = await newState(deps, 'install');
    return `https://github.com/apps/${app.slug}/installations/new?state=${state}`;
  } catch (err) {
    deps.log?.('github connect failed', { err: String(err) });
    await deps.db
      .doc(paths.github())
      .set({ error: String(err).slice(0, 300), updatedAt: now(deps) }, { merge: true });
    return back('error');
  }
}

interface InstallationInfo {
  id: number;
  account: { login: string } | null;
  repository_selection: string;
  html_url: string;
  app_slug: string;
}

async function completeInstall(
  deps: GitHubDeps,
  q: { state?: string; installation_id?: string; setup_action?: string },
): Promise<string> {
  const secret = await appSecret(deps);
  if (!secret) return 'not_configured';
  const id = Number(q.installation_id);
  if (!Number.isInteger(id) || id <= 0) return 'error';
  const current = await connection(deps);
  // A fresh install must come from a flow started in the app; a change you made on GitHub
  // (setup_on_update) only re-syncs the installation we already have.
  const fromApp = await takeState(deps, q.state, 'install');
  if (!fromApp && current.installation?.id !== id) return 'invalid_state';
  // Asked with the app's own key: only an installation of this app is found.
  const inst = await gh<InstallationInfo>(deps, `/app/installations/${id}`, {
    jwt: appJwt(secret, now(deps)),
  });
  await deps.db.doc(paths.github()).set(
    {
      installation: {
        id: inst.id,
        account: inst.account?.login ?? '',
        selection: inst.repository_selection,
        htmlUrl: inst.html_url,
        installedAt: current.installation?.installedAt ?? now(deps),
      },
      error: FieldValue.delete(),
      updatedAt: now(deps),
    },
    { merge: true },
  );
  await syncRepos(deps);
  deps.log?.('github app installed', { installation: id, account: inst.account?.login });
  return 'connected';
}

interface RepoListing {
  total_count: number;
  repositories: Array<{ full_name: string; private: boolean; default_branch: string }>;
}

/** The repos the installation can reach, for the pickers. */
export async function syncRepos(deps: GitHubDeps): Promise<{ repos: GitHubRepo[] }> {
  const secret = await appSecret(deps);
  const conn = await connection(deps);
  if (!secret || !conn.installation)
    throw new GitHubError('failed-precondition', 'Connect GitHub first (Settings › GitHub)');
  const { token } = await installationToken(deps, secret, conn.installation.id);
  const repos: GitHubRepo[] = [];
  for (let page = 1; page <= 10; page++) {
    const r = await gh<RepoListing>(deps, `/installation/repositories?per_page=100&page=${page}`, {
      token,
    });
    for (const x of r.repositories)
      repos.push({ fullName: x.full_name, private: x.private, defaultBranch: x.default_branch });
    if (repos.length >= r.total_count || r.repositories.length < 100) break;
  }
  repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
  await deps.db
    .doc(paths.github())
    .set(
      { repos, syncedAt: now(deps), error: FieldValue.delete(), updatedAt: now(deps) },
      { merge: true },
    );
  return { repos };
}

/** Forget the installation here; the app itself stays on GitHub (uninstall it there). */
export async function disconnectGitHub(deps: GitHubDeps) {
  await deps.db
    .doc(paths.github())
    .set({ installation: FieldValue.delete(), repos: [], updatedAt: now(deps) }, { merge: true });
  return { ok: true };
}

/* ------------------------------- run access ------------------------------ */

async function runContext(db: Firestore, run: Run) {
  const [task, project, settings] = await Promise.all([
    db.doc(paths.task(run.taskId)).get(),
    run.projectId ? db.doc(paths.project(run.projectId)).get() : undefined,
    db.doc(paths.settings()).get(),
  ]);
  const ai = (task.get('ai') ?? {}) as { repo?: string };
  const defaults = (project?.get('defaults') ?? {}) as { repo?: string };
  return {
    repo: repoFor({ ai }, project?.exists ? { defaults } : undefined),
    task,
    project,
    settings,
  };
}

/**
 * Whether you let this task push to (or open a pull request on) the repo: an allow rule at any
 * scope (`GitHub(pr:owner/name)`, `GitHub(pr:*)`, `GitHub`), or an approval you answered yes on
 * this task. A deny rule anywhere wins. Approving a pull request also covers its push.
 */
export async function githubGranted(
  db: Firestore,
  run: Run,
  repo: string,
  action: 'push' | 'pr',
): Promise<boolean> {
  const { task, project, settings } = await runContext(db, run);
  const list = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
  const rules = (field: string) =>
    [task.get(field), project?.get(field), settings.get(field)]
      .flatMap(list)
      .flatMap((r) => parseRule(r) ?? []);
  const actions = action === 'push' ? ['push', 'pr'] : ['pr'];
  const keys = actions.map((a) => `${a}:${repo}`);
  const hit = (field: string) =>
    rules(field).some((r) => keys.some((k) => matches(r, 'GitHub', k)));
  // A deny on pushing also blocks the pull request that needs the push.
  if (
    rules('denyRules').some(
      (r) => matches(r, 'GitHub', `push:${repo}`) || matches(r, 'GitHub', `pr:${repo}`),
    )
  )
    return false;
  if (hit('allowRules')) return true;
  const wanted = new Set(actions.map((a) => githubRule(a as 'push' | 'pr', repo)));
  const approvals = await db
    .collection(paths.messages(run.taskId))
    .where('input.suggestedRule', 'in', [...wanted])
    .get();
  return approvals.docs.some((d) => {
    const value = d.get('input.answer.value');
    return typeof value === 'string' && isApproved(value);
  });
}

/** A token for the run's own repo. Read: to clone. Write: to push, after your approval. */
export async function runGitHubToken(
  deps: GitHubDeps,
  run: Run,
  access: 'read' | 'write',
): Promise<GitHubTokenResponse> {
  const { repo } = await runContext(deps.db, run);
  if (!repo) throw new GitHubError('failed-precondition', 'This task has no repo');
  const conn = await connection(deps);
  const secret = await appSecret(deps);
  const meta = conn.repos.find((r) => r.fullName.toLowerCase() === repo.toLowerCase());
  const base = {
    repo,
    defaultBranch: meta?.defaultBranch,
    botLogin: conn.app?.botLogin,
    botEmail: conn.app?.botEmail,
  };
  const [owner, name] = repo.split('/') as [string, string];
  if (!secret || !conn.installation) {
    if (access === 'write')
      throw new GitHubError('failed-precondition', 'GitHub is not connected (Settings › GitHub)');
    return { ...base, note: 'GitHub is not connected; only public repos can be cloned.' };
  }
  if (conn.installation.account.toLowerCase() !== owner.toLowerCase()) {
    if (access === 'write')
      throw new GitHubError(
        'permission-denied',
        `The dodo GitHub App is installed on ${conn.installation.account}, not ${owner}`,
      );
    return {
      ...base,
      note: `The GitHub App does not cover ${owner}; cloning it as a public repo.`,
    };
  }
  if (access === 'write') {
    if (!(await githubGranted(deps.db, run, repo, 'push')))
      throw new GitHubError(
        'permission-denied',
        `This task is not approved to push to ${repo}; ask for ${githubRule('push', repo)} first`,
      );
  }
  try {
    const t = await installationToken(deps, secret, conn.installation.id, {
      repos: [name],
      permissions: { contents: access, metadata: 'read' },
    });
    deps.log?.('github token issued', { runId: run.id, repo, access });
    return { ...base, token: t.token, expiresAt: t.expires_at };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (access === 'read' && (status === 422 || status === 404))
      return {
        ...base,
        note: `The GitHub App is not installed on ${repo}; add it in Settings › GitHub.`,
      };
    throw err;
  }
}

interface PullRequest {
  number: number;
  html_url: string;
  state: string;
}

/** Opens (or finds the open) pull request for a branch the run pushed. */
export async function openPullRequest(
  deps: GitHubDeps,
  run: Run,
  input: unknown,
): Promise<{ url: string; number: number; existing: boolean }> {
  const parsed = GitHubOpenPrRequest.safeParse(input);
  if (!parsed.success)
    throw new GitHubError('invalid-argument', parsed.error.issues[0]?.message ?? 'Invalid request');
  const req = parsed.data;
  const { repo } = await runContext(deps.db, run);
  if (!repo) throw new GitHubError('failed-precondition', 'This task has no repo');
  if (!(await githubGranted(deps.db, run, repo, 'pr')))
    throw new GitHubError(
      'permission-denied',
      `This task is not approved to open pull requests on ${repo}; ask for ${githubRule('pr', repo)} first`,
    );
  const conn = await connection(deps);
  const secret = await appSecret(deps);
  if (!secret || !conn.installation)
    throw new GitHubError('failed-precondition', 'GitHub is not connected (Settings › GitHub)');
  const [owner, name] = repo.split('/') as [string, string];
  const { token } = await installationToken(deps, secret, conn.installation.id, {
    repos: [name],
    permissions: { pull_requests: 'write', contents: 'read', metadata: 'read' },
  });
  const meta = conn.repos.find((r) => r.fullName.toLowerCase() === repo.toLowerCase());
  const base = req.base ?? meta?.defaultBranch ?? 'main';
  if (req.head === base)
    throw new GitHubError('invalid-argument', 'head and base are the same branch');
  const open = await gh<PullRequest[]>(
    deps,
    `/repos/${owner}/${name}/pulls?state=open&head=${encodeURIComponent(`${owner}:${req.head}`)}`,
    { token },
  );
  if (open[0]) return { url: open[0].html_url, number: open[0].number, existing: true };
  const pr = await gh<PullRequest>(deps, `/repos/${owner}/${name}/pulls`, {
    method: 'POST',
    token,
    body: {
      title: req.title,
      head: req.head,
      base,
      body: `${req.body}\n\n---\n_Opened by dodo for task ${run.taskId}_`.trim(),
      draft: req.draft,
    },
  });
  deps.log?.('github pull request opened', { runId: run.id, repo, number: pr.number });
  return { url: pr.html_url, number: pr.number, existing: false };
}
