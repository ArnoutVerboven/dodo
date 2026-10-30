import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Keeping the Mac's copy of dodo current. The daemon runs the worker from this checkout, so a
 * Mac that is not pulled keeps running old tools (no Gmail, no email codes) while the cloud has
 * the new ones. While idle the daemon checks origin/main; when the checkout is a clean `main`
 * that is only behind, it fast-forwards, installs and builds, and exits so launchd starts the
 * new build. A branch, local changes or local commits are left alone (and logged once).
 */

export type Exec = (
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs?: number,
) => Promise<{ ok: boolean; out: string }>;

export const exec: Exec = (cmd, args, cwd, timeoutMs = 60_000) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, CI: '1' } },
      (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}`.trim() }),
    );
  });

/** The checkout the CLI was built from (apps/cli/dist → repo root). */
export function repoRoot(): string | undefined {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  return existsSync(path.join(root, '.git')) ? root : undefined;
}

export type UpdateCheck =
  | { state: 'current' }
  | { state: 'behind'; commits: number }
  | { state: 'skipped'; why: string };

export async function checkForUpdate(repo: string, run: Exec = exec): Promise<UpdateCheck> {
  const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repo);
  if (!branch.ok)
    return { state: 'skipped', why: `not a git checkout (${branch.out.slice(0, 200)})` };
  if (branch.out !== 'main') return { state: 'skipped', why: `on branch ${branch.out}, not main` };
  const dirty = await run('git', ['status', '--porcelain', '--untracked-files=no'], repo);
  if (!dirty.ok || dirty.out) return { state: 'skipped', why: 'local changes in the checkout' };
  const fetched = await run('git', ['fetch', '--quiet', 'origin', 'main'], repo, 120_000);
  if (!fetched.ok)
    return { state: 'skipped', why: `git fetch failed: ${fetched.out.slice(0, 200)}` };
  const ahead = await run('git', ['rev-list', '--count', 'origin/main..HEAD'], repo);
  if (Number(ahead.out) > 0) return { state: 'skipped', why: 'local commits not on origin/main' };
  const behind = await run('git', ['rev-list', '--count', 'HEAD..origin/main'], repo);
  const commits = Number(behind.out) || 0;
  return commits > 0 ? { state: 'behind', commits } : { state: 'current' };
}

/** Fast-forward, install and build; the error says which step failed. */
export async function applyUpdate(
  repo: string,
  log: (m: string) => void,
  run: Exec = exec,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const steps: Array<[string, string[], number]> = [
    ['git', ['merge', '--ff-only', 'origin/main'], 60_000],
    ['pnpm', ['install', '--frozen-lockfile'], 600_000],
    ['pnpm', ['build'], 600_000],
  ];
  for (const [cmd, args, timeout] of steps) {
    log(`update: ${cmd} ${args.join(' ')}`);
    const r = await run(cmd, args, repo, timeout);
    if (!r.ok) return { ok: false, error: `${cmd} ${args[0]} failed: ${r.out.slice(-500)}` };
  }
  return { ok: true };
}

/** Off with `"autoUpdate": false` in ~/.dodo/config.json or DODO_AUTO_UPDATE=0. */
export const autoUpdateOn = (config: { autoUpdate?: boolean }) =>
  config.autoUpdate !== false && process.env.DODO_AUTO_UPDATE !== '0';

export const UPDATE_CHECK_MS = 15 * 60_000;
