// Bundles the CLI into dist/index.js (workspace packages and the Firebase client SDK inlined),
// so `pnpm dodo` only needs node.
import { chmod, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir(new URL('../dist', import.meta.url), { recursive: true });
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
await chmod(new URL('../dist/index.js', import.meta.url), 0o755);
console.log('cli bundled to dist/');
