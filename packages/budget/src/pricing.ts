import { MICRO_PER_EUR, type MicroEur } from '@dodo/core';

/**
 * Prices used for budget reservations. Deliberately conservative:
 * USD prices are converted at 1 USD = 1 EUR, which overestimates cost in EUR.
 *
 * Verify against https://cloud.google.com/vertex-ai/generative-ai/pricing and
 * https://cloud.google.com/run/pricing before changing. A model missing from this table
 * cannot run, so new models must be priced first.
 */
export const PRICING_VERSION = '2026-10-26';
const USD_TO_EUR = 1.0;

export interface ModelPrice {
  /** USD per 1M input tokens (highest tier: long-context prices where they differ). */
  inputPerM: number;
  /** USD per 1M output tokens, including thinking tokens. */
  outputPerM: number;
  /** Max output tokens the model accepts; used to size reservations. */
  maxOutputTokens: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  // Global endpoint, standard tier, checked 2026-10-26. Regional endpoints cost about 10% more.
  // The 3.6–3.8 Flash prices are promotional until 2026-12-31; they double on 2027-01-01.
  'gemini-3.8-flash': { inputPerM: 0.75, outputPerM: 3.75, maxOutputTokens: 65_536 },
  'gemini-3.5-flash': { inputPerM: 1.5, outputPerM: 9, maxOutputTokens: 65_536 },
  'gemini-3.5-flash-lite': { inputPerM: 0.3, outputPerM: 2.5, maxOutputTokens: 65_536 },
  'gemini-3.1-flash-lite': { inputPerM: 0.25, outputPerM: 1.5, maxOutputTokens: 65_536 },
  'gemini-3.1-pro-preview': { inputPerM: 4, outputPerM: 18, maxOutputTokens: 65_536 },
  'gemini-2.5-flash-lite': { inputPerM: 0.1, outputPerM: 0.4, maxOutputTokens: 65_536 },
  'gemini-2.5-flash': { inputPerM: 0.3, outputPerM: 2.5, maxOutputTokens: 65_536 },
  'gemini-2.5-pro': { inputPerM: 2.5, outputPerM: 15, maxOutputTokens: 65_536 },
};

/** Cloud Run (jobs, tier 1 region) per-second prices in USD. */
export const CLOUD_RUN_PRICE = { vcpuSecond: 0.000018, gibSecond: 0.000002 };

const usdToMicroEur = (usd: number): MicroEur => Math.ceil(usd * USD_TO_EUR * MICRO_PER_EUR);

export class UnknownModelError extends Error {
  constructor(model: string) {
    super(`No price for model "${model}". Add it to MODEL_PRICES before using it.`);
  }
}

export function modelPrice(model: string): ModelPrice {
  const price = MODEL_PRICES[model];
  if (!price) throw new UnknownModelError(model);
  return price;
}

export function tokenCost(model: string, inputTokens: number, outputTokens: number): MicroEur {
  const p = modelPrice(model);
  return usdToMicroEur((inputTokens * p.inputPerM + outputTokens * p.outputPerM) / 1_000_000);
}

/**
 * Largest output token count that fits in `available` after paying for the input.
 * Returns 0 when not even the input fits.
 */
export function maxAffordableOutputTokens(
  model: string,
  inputTokens: number,
  available: MicroEur,
): number {
  const p = modelPrice(model);
  const inputCost = tokenCost(model, inputTokens, 0);
  if (inputCost >= available) return 0;
  const perOutputToken = (p.outputPerM * USD_TO_EUR * MICRO_PER_EUR) / 1_000_000;
  return Math.min(p.maxOutputTokens, Math.floor((available - inputCost) / perOutputToken));
}

export function computeCost(seconds: number, vcpu: number, memoryGib: number): MicroEur {
  return usdToMicroEur(
    seconds * (vcpu * CLOUD_RUN_PRICE.vcpuSecond + memoryGib * CLOUD_RUN_PRICE.gibSecond),
  );
}

/** Seconds of compute that fit in `available`. Used to set the Cloud Run execution timeout. */
export function affordableSeconds(available: MicroEur, vcpu: number, memoryGib: number): number {
  const perSecond = computeCost(1, vcpu, memoryGib);
  return perSecond === 0 ? Number.POSITIVE_INFINITY : Math.floor(available / perSecond);
}
