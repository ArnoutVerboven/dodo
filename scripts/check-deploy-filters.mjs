// Checks that each deploy target in .github/workflows/deploy.yml redeploys when any workspace
// package it depends on (directly or not) changes. A missing package means a change there
// ships to one side and not the other (the worker and the functions then run different code).
import { readFileSync } from 'node:fs';

const TARGETS = { worker: 'apps/worker', functions: 'apps/functions', hosting: 'apps/web' };

const deploy = readFileSync('.github/workflows/deploy.yml', 'utf8');
const pkg = (dir) => JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));

// Workspace packages by name, to their folder.
const dirs = new Map();
for (const name of ['agent', 'budget', 'core', 'jobs', 'policy']) {
  dirs.set(pkg(`packages/${name}`).name, `packages/${name}`);
}
for (const dir of Object.values(TARGETS)) dirs.set(pkg(dir).name, dir);

function workspaceDeps(dir, seen = new Set()) {
  const p = pkg(dir);
  for (const name of Object.keys({ ...p.dependencies, ...p.devDependencies })) {
    const d = dirs.get(name);
    if (d && !seen.has(d)) {
      seen.add(d);
      workspaceDeps(d, seen);
    }
  }
  return seen;
}

// Changes under these redeploy everything (the `ALL` list).
const all = /ALL='([^']+)'/.exec(deploy)?.[1];
if (!all) throw new Error('deploy.yml: no ALL list found');
const allRe = new RegExp(all);

let failed = false;
for (const [target, dir] of Object.entries(TARGETS)) {
  const line = deploy.split('\n').find((l) => l.includes(`echo "${target}=$(hit `));
  if (!line) throw new Error(`deploy.yml: no filter for ${target}`);
  // The regex is the first quoted argument of hit, with the shell's $FB left out.
  const raw = /hit ["']([^"']+)["']/.exec(line)?.[1]?.replace('|$FB', '');
  if (!raw) throw new Error(`deploy.yml: cannot read the ${target} filter`);
  const re = new RegExp(raw);
  for (const d of [dir, ...workspaceDeps(dir)]) {
    const probe = `${d}/src/index.ts`;
    if (!re.test(probe) && !allRe.test(probe)) {
      console.error(`deploy.yml: a change in ${d}/ does not redeploy ${target}`);
      failed = true;
    }
  }
}
if (failed) process.exit(1);
console.log('deploy filters cover every workspace dependency');
