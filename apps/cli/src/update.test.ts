import { describe, expect, it } from 'vitest';
import { applyUpdate, checkForUpdate, type Exec } from './update.js';

/** A fake git/pnpm: answers by command line, records what ran. */
function fake(answers: Record<string, string | false>) {
  const ran: string[] = [];
  const run: Exec = async (cmd, args) => {
    const line = `${cmd} ${args.join(' ')}`;
    ran.push(line);
    const a = Object.entries(answers).find(([k]) => line.startsWith(k))?.[1];
    return a === false ? { ok: false, out: 'boom' } : { ok: true, out: a ?? '' };
  };
  return { run, ran };
}

const clean = {
  'git rev-parse': 'main',
  'git status': '',
  'git fetch': '',
  'git rev-list --count origin/main..HEAD': '0',
};

describe('daemon self-update', () => {
  it('updates a clean main that is only behind', async () => {
    const f = fake({ ...clean, 'git rev-list --count HEAD..origin/main': '3' });
    expect(await checkForUpdate('/repo', f.run)).toEqual({ state: 'behind', commits: 3 });
    const g = fake({});
    expect(await applyUpdate('/repo', () => {}, g.run)).toEqual({ ok: true });
    expect(g.ran).toEqual([
      'git merge --ff-only origin/main',
      'pnpm install --frozen-lockfile',
      'pnpm build',
    ]);
  });

  it('leaves branches, local changes and local commits alone', async () => {
    expect(await checkForUpdate('/r', fake({ ...clean, 'git rev-parse': 'feature' }).run)).toEqual({
      state: 'skipped',
      why: 'on branch feature, not main',
    });
    expect(
      (await checkForUpdate('/r', fake({ ...clean, 'git status': ' M apps/cli/src/x.ts' }).run))
        .state,
    ).toBe('skipped');
    expect(
      await checkForUpdate(
        '/r',
        fake({ ...clean, 'git rev-list --count origin/main..HEAD': '1' }).run,
      ),
    ).toEqual({ state: 'skipped', why: 'local commits not on origin/main' });
    expect(
      await checkForUpdate(
        '/r',
        fake({ ...clean, 'git rev-list --count HEAD..origin/main': '0' }).run,
      ),
    ).toEqual({ state: 'current' });
  });

  it('stops at the first failing step', async () => {
    const f = fake({ 'pnpm install': false });
    expect(await applyUpdate('/repo', () => {}, f.run)).toEqual({
      ok: false,
      error: 'pnpm install failed: boom',
    });
    expect(f.ran).not.toContain('pnpm build');
  });
});
