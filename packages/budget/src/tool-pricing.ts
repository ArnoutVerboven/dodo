import type { MicroEur } from '@dodo/core';
import { tokenCost } from './pricing.js';

/**
 * Cost models for tools that cost money (#15). A paid tool reserves before it runs and settles
 * after, through the CostGate, like a model call: the reservation is the most one call can
 * cost, the settlement what it did cost. Same conservative rules as MODEL_PRICES: USD at
 * 1 USD = 1 EUR, free tiers ignored (we cannot see how much of one is left).
 *
 * A tool may also make a model call of its own (web search runs a grounded Gemini call); its
 * tokens are part of the same reservation, so the task pays one entry per tool call.
 */
export const TOOL_PRICING_VERSION = '2026-10-30';

export interface ToolPrice {
  /** What one billed unit is, for the ledger and the trace. */
  unit: string;
  /** USD per billed unit. */
  perUnitUsd: number;
  /** The most units one call can be billed for; sizes the reservation. */
  maxUnitsPerCall: number;
  /** The tool's own model call: which model, and the output it may write. */
  model?: { name: string; maxOutputTokens: number; maxInputTokens: number };
}

export const TOOL_PRICES: Record<string, ToolPrice> = {
  /**
   * Grounding with Google Search on Vertex, Gemini 3 and later: $14 per 1,000 grounding
   * queries (5,000 a month free, not counted here), billed only when the answer cites at
   * least one web source. One prompt can run several queries; we let it run at most 5.
   * Grounded input tokens are free; the model's own tokens are charged as usual.
   * https://cloud.google.com/vertex-ai/generative-ai/pricing, checked 2026-10-30.
   */
  web_search: {
    unit: 'search query',
    perUnitUsd: 0.014,
    maxUnitsPerCall: 5,
    model: { name: 'gemini-3.5-flash-lite', maxOutputTokens: 2048, maxInputTokens: 2048 },
  },
  /**
   * Push-to-talk in the web app: a voice note sent to Gemini Flash-Lite as audio input. Audio
   * is 32 tokens a second (1,920 a minute) and priced above text, at most $1 per 1M tokens
   * across the Flash-Lite models; we bill every input token at that rate, so one unit is
   * 1,920 input tokens ($0.00192, about one minute of audio). Output tokens are the transcript.
   * Not charged to a task: it counts against the monthly and lifetime budgets only.
   * https://cloud.google.com/vertex-ai/generative-ai/pricing, checked 2026-10-30.
   */
  transcribe: {
    unit: 'minute of audio',
    perUnitUsd: 0.00192,
    maxUnitsPerCall: 4,
    model: { name: 'gemini-3.1-flash-lite', maxOutputTokens: 4096, maxInputTokens: 0 },
  },
};

export class UnknownToolPriceError extends Error {
  constructor(tool: string) {
    super(`No cost model for tool "${tool}". Add it to TOOL_PRICES before using it.`);
  }
}

export function toolPrice(tool: string): ToolPrice {
  const p = TOOL_PRICES[tool];
  if (!p) throw new UnknownToolPriceError(tool);
  return p;
}

const usd = (amount: number): MicroEur => Math.ceil(amount * 1_000_000);

/** What one call costs: its billed units plus the tokens of its own model call. */
export function toolCost(
  tool: string,
  units: number,
  tokens: { input: number; output: number } = { input: 0, output: 0 },
): MicroEur {
  const p = toolPrice(tool);
  const model = p.model ? tokenCost(p.model.name, tokens.input, tokens.output) : 0;
  return usd(Math.max(0, units) * p.perUnitUsd) + model;
}

/** The reservation for one call: every unit it may be billed for and a full model call. */
export function toolReservation(tool: string): MicroEur {
  const p = toolPrice(tool);
  return toolCost(tool, p.maxUnitsPerCall, {
    input: p.model?.maxInputTokens ?? 0,
    output: p.model?.maxOutputTokens ?? 0,
  });
}
