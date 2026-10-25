/**
 * GCP backstop for the 50 EUR cap. Cloud Billing budgets publish to Pub/Sub several
 * times a day; this logic decides what to do with each notification.
 *
 *  - cost >= haltAt:   set settings/global.halted, so the CostGate refuses all new costs
 *                      and the dispatcher starts nothing new.
 *  - cost >= detachAt: unlink the billing account from the project. Every paid service stops.
 *
 * Billing data lags by hours, which is why both thresholds sit below the 50 EUR budget.
 */

export interface BudgetNotification {
  budgetDisplayName?: string;
  costAmount: number;
  budgetAmount?: number;
  currencyCode?: string;
  costIntervalStart?: string;
  alertThresholdExceeded?: number;
}

export interface KillSwitchConfig {
  haltAt: number;
  detachAt: number;
  currency: string;
}

export interface KillSwitchDeps {
  isHalted(): Promise<boolean>;
  halt(reason: string): Promise<void>;
  isBillingEnabled(): Promise<boolean>;
  detachBilling(): Promise<void>;
  log(message: string, data?: object): void;
}

export type KillSwitchAction = 'none' | 'halted' | 'detached';

export function parseNotification(data: unknown): BudgetNotification {
  if (typeof data !== 'object' || data === null)
    throw new Error('Budget notification is not an object');
  const costAmount = (data as Record<string, unknown>).costAmount;
  if (typeof costAmount !== 'number' || !Number.isFinite(costAmount)) {
    throw new Error('Budget notification has no numeric costAmount');
  }
  return data as BudgetNotification;
}

export async function handleBudgetNotification(
  n: BudgetNotification,
  config: KillSwitchConfig,
  deps: KillSwitchDeps,
): Promise<KillSwitchAction> {
  if (n.currencyCode && n.currencyCode !== config.currency) {
    // A currency mismatch means our thresholds are meaningless; fail safe by halting.
    deps.log('Currency mismatch, halting to be safe', {
      got: n.currencyCode,
      want: config.currency,
    });
    await deps.halt(`Budget notification in ${n.currencyCode}, expected ${config.currency}`);
    return 'halted';
  }
  let action: KillSwitchAction = 'none';
  const cost = `${n.costAmount.toFixed(2)} ${config.currency}`;
  if (n.costAmount >= config.haltAt && !(await deps.isHalted())) {
    await deps.halt(`GCP spend reached ${cost} (halt threshold ${config.haltAt})`);
    deps.log('Processing halted', { cost: n.costAmount });
    action = 'halted';
  }
  if (n.costAmount >= config.detachAt) {
    if (!(await deps.isHalted())) await deps.halt(`GCP spend reached ${cost}`);
    if (await deps.isBillingEnabled()) {
      await deps.detachBilling();
      deps.log('Billing detached from project', { cost: n.costAmount });
      action = 'detached';
    }
  }
  return action;
}
