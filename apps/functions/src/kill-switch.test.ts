import { describe, expect, it } from 'vitest';
import { handleBudgetNotification, type KillSwitchDeps, parseNotification } from './kill-switch.js';

const config = { haltAt: 40, detachAt: 45, currency: 'EUR' };

function fakeDeps(initial: { halted?: boolean; billing?: boolean } = {}) {
  const state = {
    halted: initial.halted ?? false,
    billing: initial.billing ?? true,
    reasons: [] as string[],
  };
  const deps: KillSwitchDeps = {
    isHalted: async () => state.halted,
    halt: async (r) => {
      state.halted = true;
      state.reasons.push(r);
    },
    isBillingEnabled: async () => state.billing,
    detachBilling: async () => {
      state.billing = false;
    },
    log: () => {},
  };
  return { state, deps };
}

describe('kill switch', () => {
  it('does nothing below the halt threshold', async () => {
    const { state, deps } = fakeDeps();
    expect(
      await handleBudgetNotification({ costAmount: 12.3, currencyCode: 'EUR' }, config, deps),
    ).toBe('none');
    expect(state).toMatchObject({ halted: false, billing: true });
  });

  it('halts at the halt threshold but keeps billing', async () => {
    const { state, deps } = fakeDeps();
    expect(
      await handleBudgetNotification({ costAmount: 40, currencyCode: 'EUR' }, config, deps),
    ).toBe('halted');
    expect(state).toMatchObject({ halted: true, billing: true });
  });

  it('halts and detaches billing at the detach threshold', async () => {
    const { state, deps } = fakeDeps();
    expect(
      await handleBudgetNotification({ costAmount: 47.1, currencyCode: 'EUR' }, config, deps),
    ).toBe('detached');
    expect(state).toMatchObject({ halted: true, billing: false });
  });

  it('is idempotent for repeated notifications', async () => {
    const { state, deps } = fakeDeps({ halted: true, billing: false });
    expect(
      await handleBudgetNotification({ costAmount: 48, currencyCode: 'EUR' }, config, deps),
    ).toBe('none');
    expect(state.reasons).toHaveLength(0);
  });

  it('halts when the currency does not match', async () => {
    const { state, deps } = fakeDeps();
    expect(
      await handleBudgetNotification({ costAmount: 1, currencyCode: 'USD' }, config, deps),
    ).toBe('halted');
    expect(state.halted).toBe(true);
  });

  it('rejects malformed notifications', () => {
    expect(() => parseNotification({ costAmount: 'lots' })).toThrow();
    expect(parseNotification({ costAmount: 3 }).costAmount).toBe(3);
  });
});
