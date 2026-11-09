import { type AgentHarness, type ControlPlane, harnessFor } from '@dodo/agent';
import { isLocalModel } from '@dodo/core';
import { piHarness } from '@dodo/harness-pi';

/**
 * The harness a run uses: the task's (or project's) setting, when this run can serve it. pi
 * calls the gateway with its own Gemini client, so it needs the Gemini endpoint and a Gemini
 * model; otherwise the run uses dodo's loop.
 */
export function pickHarness(
  wanted: string | undefined,
  control: ControlPlane,
  model: string,
): AgentHarness {
  if (wanted === piHarness.id && control.geminiEndpoint && !isLocalModel(model)) return piHarness;
  return harnessFor();
}
