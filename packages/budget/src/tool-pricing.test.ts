import { eur } from '@dodo/core';
import { describe, expect, it } from 'vitest';
import { tokenCost } from './pricing.js';
import { toolCost, toolReservation, UnknownToolPriceError } from './tool-pricing.js';

describe('tool pricing', () => {
  it('charges web search per query plus its own model tokens', () => {
    expect(toolCost('web_search', 1)).toBe(eur(0.014));
    expect(toolCost('web_search', 2, { input: 100, output: 400 })).toBe(
      eur(0.028) + tokenCost('gemini-3.5-flash-lite', 100, 400),
    );
    // No cited source: Google bills no query, only the tokens are charged.
    expect(toolCost('web_search', 0, { input: 100, output: 10 })).toBe(
      tokenCost('gemini-3.5-flash-lite', 100, 10),
    );
  });

  it('reserves the most one call can cost', () => {
    const reserve = toolReservation('web_search');
    expect(reserve).toBeGreaterThanOrEqual(
      toolCost('web_search', 5, { input: 2048, output: 2048 }),
    );
    expect(reserve).toBeLessThan(eur(0.1));
  });

  it('refuses tools without a cost model', () => {
    expect(() => toolReservation('maps')).toThrow(UnknownToolPriceError);
  });
});
