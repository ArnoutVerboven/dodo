// Bundles the worker into dist/ as single files (workspace packages and the Firebase client
// SDK inlined), so the container image is just node + two files.
import { mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir(new URL('../dist', import.meta.url), { recursive: true });
await build({
  entryPoints: ['src/index.ts', 'src/dev.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  // firebase-admin is only used by the dev loop and stays external (installed in the workspace);
  // @playwright/mcp and playwright are installed in the browser image only, resolved at runtime.
  external: ['firebase-admin', '@playwright/mcp', 'playwright'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
console.log('worker bundled to dist/');
