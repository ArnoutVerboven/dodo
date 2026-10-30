/**
 * The local model: an OpenAI-compatible server on your Mac (mlx_lm.server, LM Studio, Ollama,
 * llama.cpp). Its runs always go to a Mac, and its calls go from the worker straight to that
 * server instead of through the gateway: nothing is billed, so there is nothing to reserve.
 */
export const LOCAL_MODEL = 'local';

/** `local`, or `local:<name>` for a specific model the Mac's server offers. */
export function isLocalModel(model: string | undefined): boolean {
  return model === LOCAL_MODEL || !!model?.startsWith(`${LOCAL_MODEL}:`);
}

/**
 * The context the agent plans with for a local model: far below what Gemini takes, because a
 * long prompt on a laptop is slow and every token of context costs memory.
 */
export const LOCAL_CONTEXT_WINDOW = 65_536;
