import type { RunInput } from './control-plane.js';
import { type LoopOptions, type LoopResult, runAgent } from './loop.js';

/**
 * What a harness can do, so the worker knows what to hand it and what to refuse. See the
 * harness spec: anything dodo must guarantee (budget, policy, credentials, the task contract)
 * stays outside the harness, in the gateway, `ToolRuntime` and `RunSupervisor`.
 */
export interface HarnessCapabilities {
  /** Wire formats it can send model calls in; every call goes through the gateway. */
  modelFormats: Array<'gemini' | 'anthropic' | 'openai'>;
  /** Can talk to the Mac's local model (an OpenAI-compatible server). */
  localModel: boolean;
  /**
   * Tools the harness brings itself (its own shell and file tools). Each one must pass
   * `ToolRuntime.gate`. Empty: it only runs dodo's tools.
   */
  builtinTools: string[];
  /** Comments during a run reach the next model call. */
  steering: boolean;
  /** Compacts its conversation when asked (the Compact button) as well as on its own. */
  programmaticCompaction: boolean;
  /** How it stores a conversation, so a resume on another harness knows to start fresh. */
  sessionFormat: 'gemini-contents' | string;
}

/**
 * The loop that drives a run: our own today, others (pi) behind the same call. The host is
 * still the loop's full options; it narrows to `HarnessHost` (model endpoint, tools via
 * `ToolRuntime`, supervisor, prompt) as the second harness lands.
 */
export interface AgentHarness {
  id: string;
  capabilities: HarnessCapabilities;
  run(input: RunInput, host: LoopOptions): Promise<LoopResult>;
}

/** dodo's own loop (loop.ts): Gemini format through the gateway, dodo's tools only. */
export const dodoLoopHarness: AgentHarness = {
  id: 'dodo-loop',
  capabilities: {
    modelFormats: ['gemini', 'openai'],
    localModel: true,
    builtinTools: [],
    steering: true,
    programmaticCompaction: true,
    sessionFormat: 'gemini-contents',
  },
  run: runAgent,
};

/** Every harness the worker can run; the conformance suite runs against each one. */
export const HARNESSES: AgentHarness[] = [dodoLoopHarness];

/** The harness a run uses. One for now; a task or project setting picks once there are more. */
export function harnessFor(id?: string): AgentHarness {
  return HARNESSES.find((h) => h.id === id) ?? dodoLoopHarness;
}
