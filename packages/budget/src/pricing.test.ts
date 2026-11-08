import { eur } from '@dodo/core';
import { describe, expect, it } from 'vitest';
import {
  affordableSeconds,
  computeCost,
  maxAffordableOutputTokens,
  tokenCost,
  UnknownModelError,
} from './pricing.js';

describe('pricing', () => {
  it('prices tokens and rounds up', () => {
    expect(tokenCost('gemini-2.5-flash', 1_000_000, 0)).toBe(eur(0.3));
    expect(tokenCost('gemini-2.5-flash', 1, 0)).toBe(1);
  });

  it('bills cached input tokens at a tenth of the input price', () => {
    expect(tokenCost('gemini-2.5-flash', 1_000_000, 0, 1_000_000)).toBe(eur(0.03));
    expect(tokenCost('gemini-2.5-flash', 1_000_000, 0, 500_000)).toBe(eur(0.165));
    // Never more cached than the prompt, never less than nothing.
    expect(tokenCost('gemini-2.5-flash', 1_000_000, 0, 2_000_000)).toBe(eur(0.03));
    expect(tokenCost('gemini-2.5-flash', 1_000_000, 0, -5)).toBe(eur(0.3));
  });

  it('refuses unknown models', () => {
    expect(() => tokenCost('mystery-model', 1, 1)).toThrow(UnknownModelError);
  });

  it('caps output tokens to what the budget allows', () => {
    const n = maxAffordableOutputTokens('gemini-2.5-flash', 10_000, eur(0.01));
    expect(tokenCost('gemini-2.5-flash', 10_000, n)).toBeLessThanOrEqual(eur(0.01) + 1);
    expect(maxAffordableOutputTokens('gemini-2.5-flash', 10_000_000, eur(0.01))).toBe(0);
    expect(maxAffordableOutputTokens('gemini-2.5-flash', 10, eur(100))).toBe(65_536);
  });

  it('turns a budget into a compute timeout', () => {
    const s = affordableSeconds(eur(0.05), 1, 2);
    expect(computeCost(s, 1, 2)).toBeLessThanOrEqual(eur(0.05));
    expect(s).toBeGreaterThan(2000);
  });
});
