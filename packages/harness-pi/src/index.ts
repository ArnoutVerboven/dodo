import type { AgentHarness, LoopOptions, LoopResult, RunInput } from '@dodo/agent';
import { BUILTIN_TOOLS } from './names.js';

export { toGeminiContents, toPiMessages } from './convert.js';
export { endForModelError } from './errors.js';

/**
 * pi (pi.dev) as a dodo harness (see run.ts). pi is loaded only when a run uses it: loading it
 * installs undici 8 as Node's global fetch dispatcher, which ignores the proxy the Mac sandbox
 * sets, so every other run would lose its network. The dispatcher is put back after loading.
 */
let loaded: Promise<typeof import('./run.js')> | undefined;
function loadPi() {
  loaded ??= (async () => {
    const key = Symbol.for('undici.globalDispatcher.1');
    const g = globalThis as Record<symbol, unknown>;
    const before = g[key];
    const mod = await import('./run.js');
    if (before !== undefined && g[key] !== before) g[key] = before;
    return mod;
  })();
  return loaded;
}

export const piHarness: AgentHarness = {
  id: 'pi',
  capabilities: {
    modelFormats: ['gemini'],
    localModel: false,
    builtinTools: [...BUILTIN_TOOLS],
    steering: true,
    programmaticCompaction: true,
    // Stored as Gemini contents, like dodo's loop, so a task moves between them freely.
    sessionFormat: 'gemini-contents',
  },
  run: async (input: RunInput, opts: LoopOptions): Promise<LoopResult> =>
    (await loadPi()).runPi(input, opts),
};
