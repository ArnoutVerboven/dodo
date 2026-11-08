// Points git at the repo's hooks in .githooks (runs on `pnpm install`, via "prepare").
// Does nothing in CI, outside a git checkout, or when DODO_NO_HOOKS=1.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (process.env.CI || process.env.DODO_NO_HOOKS === '1' || !existsSync('.git')) process.exit(0);
try {
  const current = execFileSync('git', ['config', '--get', 'core.hooksPath'], { encoding: 'utf8' })
    .toString()
    .trim();
  if (current === '.githooks') process.exit(0);
} catch {
  // Not set yet.
}
try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks']);
  console.log('git hooks: using .githooks (pre-commit: lint staged files, pre-push: pnpm check)');
} catch {
  // No git on PATH: hooks are a convenience, never a reason to fail an install.
}
