import { describe, expect, it } from 'vitest';
import {
  handleBudgetNotification,
  handleMessage,
  type KillSwitchDeps,
  parseMessage,
  parseNotification,
} from './kill-switch.js';

const config = { haltAt: 40, detachAt: 45, currency: 'EUR' };

function fakeDeps(initial: { halted?: boolean; billing?: boolean } = {}) {
  const state = {
    halted: initial.halted ?? false,
    billing: initial.billing ?? true,
    reasons: [] as string[],
    cancels: 0,
  };
  const deps: KillSwitchDeps = {
    isHalted: async () => state.halted,
    halt: async (r) => {
      state.halted = true;
      state.reasons.push(r);
    },
    cancelRunningExecutions: async () => {
      state.cancels++;
      return 0;
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
    expect(state).toMatchObject({ halted: true, billing: true, cancels: 1 });
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

  it('halts and cancels executions on an open monitoring incident', async () => {
    const { state, deps } = fakeDeps();
    const msg = parseMessage({
      incident: { policy_name: 'Vertex tokens per hour', state: 'open' },
    });
    expect(await handleMessage(msg, config, deps)).toBe('halted');
    expect(state).toMatchObject({ halted: true, billing: true, cancels: 1 });
  });

  it('ignores closed incidents', async () => {
    const { state, deps } = fakeDeps();
    const msg = parseMessage({ incident: { policy_name: 'x', state: 'closed' } });
    expect(await handleMessage(msg, config, deps)).toBe('none');
    expect(state.halted).toBe(false);
  });

  it('routes budget messages through the budget handler', async () => {
    const { state, deps } = fakeDeps();
    expect(
      await handleMessage(parseMessage({ costAmount: 46, currencyCode: 'EUR' }), config, deps),
    ).toBe('detached');
    expect(state.billing).toBe(false);
  });
});
