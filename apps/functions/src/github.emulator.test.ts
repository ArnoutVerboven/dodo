import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { Run } from '@dodo/core';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { afterAll, describe, expect, it } from 'vitest';
import {
  appJwt,
  completeGitHubConnect,
  type GitHubDeps,
  githubGranted,
  openPullRequest,
  runGitHubToken,
  startGitHubConnect,
} from './github.js';
import type { VaultValues } from './vault.js';

const enabled = !!process.env.FIRESTORE_EMULATOR_HOST;
const app = enabled ? initializeApp({ projectId: 'demo-dodo' }, 'github-test') : undefined;
const db = app ? getFirestore(app) : undefined;

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

/** GitHub's API as far as the setup and run paths use it. */
function fakeGitHub() {
  const calls: Array<{ method: string; path: string; auth?: string; body?: unknown }> = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? 'GET';
    const auth = (init?.headers as Record<string, string>)?.authorization;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname + u.search, auth, body });
    const p = u.pathname;
    if (p === '/app-manifests/c0de/conversions')
      return json(201, {
        id: 42,
        slug: 'dodo-demo',
        name: 'dodo-demo',
        html_url: 'https://github.com/apps/dodo-demo',
        owner: { login: 'me' },
        client_id: 'Iv1.x',
        client_secret: 'cs',
        webhook_secret: null,
        pem,
      });
    if (p.startsWith('/users/')) return json(200, { id: 99, login: 'dodo-demo[bot]' });
    if (p === '/app/installations/7')
      return json(200, {
        id: 7,
        account: { login: 'me' },
        repository_selection: 'selected',
        html_url: 'https://github.com/settings/installations/7',
        app_slug: 'dodo-demo',
      });
    if (p === '/app/installations/7/access_tokens') {
      if (body?.repositories && !['app', 'web'].includes(body.repositories[0]))
        return json(422, { message: 'no such repo' });
      return json(201, { token: `ghs_${calls.length}`, expires_at: '2030-01-01T00:00:00Z' });
    }
    if (p === '/installation/repositories')
      return json(200, {
        total_count: 2,
        repositories: [
          { full_name: 'me/web', private: false, default_branch: 'main' },
          { full_name: 'me/app', private: true, default_branch: 'trunk' },
        ],
      });
    if (p === '/repos/me/app/pulls' && method === 'GET') return json(200, []);
    if (p === '/repos/me/app/pulls' && method === 'POST')
      return json(201, { number: 3, html_url: 'https://github.com/me/app/pull/3', state: 'open' });
    return json(404, { message: `unexpected ${method} ${p}` });
  }) as typeof fetch;
  return { calls, fetch: fetchFn };
}

function memoryStore() {
  let values: VaultValues = {};
  return {
    read: async () => structuredClone(values),
    write: async (v: VaultValues) => {
      values = structuredClone(v);
    },
  };
}

describe.skipIf(!enabled)('github (emulator)', () => {
  afterAll(async () => app && deleteApp(app));

  const connected = async () => {
    if (!db) throw new Error('no db');
    await db.doc('github/app').delete();
    const gh = fakeGitHub();
    const deps: GitHubDeps = {
      db,
      secrets: memoryStore(),
      fetch: gh.fetch,
      appUrl: 'https://dodo.test',
      callbackUrl: 'https://fn.test/githubCallback',
      projectId: 'demo-dodo',
    };
    const start = await startGitHubConnect(deps, 'owner');
    if (start.kind !== 'manifest') throw new Error('expected the manifest step');
    expect(JSON.parse(start.manifest).default_permissions).toEqual({
      contents: 'write',
      pull_requests: 'write',
      metadata: 'read',
    });
    const state = new URL(start.postUrl).searchParams.get('state') ?? undefined;
    const next = await completeGitHubConnect(deps, { code: 'c0de', state });
    expect(next).toMatch(/^https:\/\/github\.com\/apps\/dodo-demo\/installations\/new\?state=/);
    const installState = new URL(next).searchParams.get('state') ?? undefined;
    const done = await completeGitHubConnect(deps, { installation_id: '7', state: installState });
    expect(done).toBe('https://dodo.test/settings?section=integrations&github=connected');
    return { deps, gh };
  };

  const runOn = async (repo: string | undefined) => {
    if (!db) throw new Error('no db');
    const taskId = randomUUID();
    await db
      .doc(`tasks/${taskId}`)
      .set({ title: 'Fix it', ai: repo ? { enabled: true, repo } : {} });
    return { id: `r${taskId.slice(0, 6)}`, taskId } as Run;
  };

  const approve = async (run: Run, rule: string, value = 'yes') => {
    await db?.collection(`tasks/${run.taskId}/messages`).add({
      author: 'system',
      body: '',
      input: {
        kind: 'approval',
        prompt: '',
        suggestedRule: rule,
        answer: { value, answeredAt: 1 },
      },
      createdAt: 1,
    });
  };

  it('creates the app, installs it and lists the repos', async () => {
    const { deps } = await connected();
    const doc = (await db?.doc('github/app').get())?.data();
    expect(doc?.app).toMatchObject({
      slug: 'dodo-demo',
      botEmail: '99+dodo-demo[bot]@users.noreply.github.com',
    });
    expect(doc?.installation).toMatchObject({ id: 7, account: 'me' });
    expect(doc?.repos.map((r: { fullName: string }) => r.fullName)).toEqual(['me/app', 'me/web']);
    expect((await deps.secrets.read()).app?.pem).toBe(pem);
    // With the app in place, connecting again goes to the install page.
    expect((await startGitHubConnect(deps, 'owner')).kind).toBe('install');
  });

  it('refuses a reused state and an unknown installation', async () => {
    const { deps } = await connected();
    expect(await completeGitHubConnect(deps, { code: 'c0de', state: 'nope' })).toMatch(
      /invalid_state/,
    );
    expect(await completeGitHubConnect(deps, { installation_id: '8' })).toMatch(/invalid_state/);
    // A change made on GitHub to our own installation only re-syncs it.
    expect(
      await completeGitHubConnect(deps, { installation_id: '7', setup_action: 'update' }),
    ).toMatch(/connected/);
  });

  it('gives a run a read token for its own repo only', async () => {
    const { deps, gh } = await connected();
    const run = await runOn('me/app');
    const t = await runGitHubToken(deps, run, 'read');
    expect(t).toMatchObject({ repo: 'me/app', defaultBranch: 'trunk', botLogin: 'dodo-demo[bot]' });
    expect(t.token).toMatch(/^ghs_/);
    const req = gh.calls.filter((c) => c.path.endsWith('/access_tokens')).pop();
    expect(req?.body).toEqual({
      repositories: ['app'],
      permissions: { contents: 'read', metadata: 'read' },
    });
    expect(req?.auth).toMatch(/^Bearer /);

    const other = await runGitHubToken(deps, await runOn('someone/else'), 'read');
    expect(other.token).toBeUndefined();
    const notInstalled = await runGitHubToken(deps, await runOn('me/secret'), 'read');
    expect(notInstalled.token).toBeUndefined();
    await expect(runGitHubToken(deps, await runOn(undefined), 'read')).rejects.toThrow('no repo');
  });

  it('gives a write token only after you approved a push or pull request', async () => {
    const { deps } = await connected();
    const run = await runOn('me/app');
    await expect(runGitHubToken(deps, run, 'write')).rejects.toThrow('not approved');
    await approve(run, 'GitHub(push:me/app)', 'no');
    await expect(runGitHubToken(deps, run, 'write')).rejects.toThrow('not approved');
    await approve(run, 'GitHub(pr:me/app)');
    expect((await runGitHubToken(deps, run, 'write')).token).toMatch(/^ghs_/);
    // Approved on one task is not approved on another.
    await expect(runGitHubToken(deps, await runOn('me/app'), 'write')).rejects.toThrow(
      'not approved',
    );
  });

  it('counts allow rules at any scope and lets a deny win', async () => {
    await connected();
    const run = await runOn('me/app');
    if (!db) throw new Error('no db');
    await db.doc(`tasks/${run.taskId}`).set({ allowRules: ['GitHub(pr:*)'] }, { merge: true });
    expect(await githubGranted(db, run, 'me/app', 'push')).toBe(true);
    await db.doc('settings/global').set({ denyRules: ['GitHub(push:me/app)'] }, { merge: true });
    try {
      expect(await githubGranted(db, run, 'me/app', 'pr')).toBe(false);
    } finally {
      await db.doc('settings/global').set({ denyRules: [] }, { merge: true });
    }
  });

  it('opens a pull request against the default branch after approval', async () => {
    const { deps, gh } = await connected();
    const run = await runOn('me/app');
    const req = { runId: run.id, head: 'dodo/fix', title: 'Fix it', body: 'Done.' };
    await expect(openPullRequest(deps, run, req)).rejects.toThrow('not approved');
    await approve(run, 'GitHub(pr:me/app)');
    expect(await openPullRequest(deps, run, req)).toEqual({
      url: 'https://github.com/me/app/pull/3',
      number: 3,
      existing: false,
    });
    const post = gh.calls.find((c) => c.method === 'POST' && c.path === '/repos/me/app/pulls');
    expect(post?.body).toMatchObject({ head: 'dodo/fix', base: 'trunk', title: 'Fix it' });
    await expect(openPullRequest(deps, run, { ...req, head: '../x' })).rejects.toThrow();
  });

  it('signs a JWT GitHub accepts the shape of', () => {
    const jwt = appJwt({ appId: '42', pem }, 1_700_000_000_000);
    const [, payload] = jwt.split('.');
    expect(JSON.parse(Buffer.from(payload as string, 'base64url').toString())).toEqual({
      iat: 1_699_999_940,
      exp: 1_700_000_480,
      iss: '42',
    });
  });
});
