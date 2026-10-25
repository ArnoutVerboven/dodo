// Bundles the functions into lib/ with workspace packages inlined, and writes a
// package.json that lists only registry dependencies, so `firebase deploy` can
// install it without knowing about the pnpm workspace.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies);

await mkdir(new URL('../lib', import.meta.url), { recursive: true });
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external,
});
await writeFile(
  new URL('../lib/package.json', import.meta.url),
  JSON.stringify(
    { name: 'dodo-functions', private: true, type: 'module', main: 'index.js', engines: pkg.engines, dependencies: pkg.dependencies },
    null,
    2,
  ),
);
console.log('functions bundled to lib/');
