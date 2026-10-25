/**
 * GCP safety net for the 50 EUR lifetime cap. Two kinds of messages arrive on the
 * `billing-alerts` topic:
 *
 *  - Cloud Billing budget notifications (lag: hours). cost >= haltAt halts; cost >= detachAt
 *    also unlinks the billing account from the project, which stops every paid service.
 *  - Cloud Monitoring alert incidents (lag: minutes), for example token usage per hour far
 *    above what the internal budgets allow. An open incident halts.
 *
 * Halting sets settings/global.halted (the CostGate then refuses every new cost and workers
 * abort) and cancels running Cloud Run executions so nothing keeps spending until a timeout.
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

export interface MonitoringIncident {
  policy_name?: string;
  state?: string;
  summary?: string;
}

export type KillSwitchMessage =
  | { kind: 'budget'; notification: BudgetNotification }
  | { kind: 'alert'; incident: MonitoringIncident };

export interface KillSwitchDeps {
  isHalted(): Promise<boolean>;
  halt(reason: string): Promise<void>;
  /** Cancel every running worker execution. Must succeed when there are none. */
  cancelRunningExecutions(): Promise<number>;
  isBillingEnabled(): Promise<boolean>;
  detachBilling(): Promise<void>;
  log(message: string, data?: object): void;
}

export type KillSwitchAction = 'none' | 'halted' | 'detached';

export function parseMessage(data: unknown): KillSwitchMessage {
  if (typeof data === 'object' && data !== null && 'incident' in data) {
    const incident = (data as { incident: unknown }).incident;
    if (typeof incident !== 'object' || incident === null) throw new Error('Alert has no incident');
    return { kind: 'alert', incident: incident as MonitoringIncident };
  }
  return { kind: 'budget', notification: parseNotification(data) };
}

export function parseNotification(data: unknown): BudgetNotification {
  if (typeof data !== 'object' || data === null)
    throw new Error('Budget notification is not an object');
  const costAmount = (data as Record<string, unknown>).costAmount;
  if (typeof costAmount !== 'number' || !Number.isFinite(costAmount)) {
    throw new Error('Budget notification has no numeric costAmount');
  }
  return data as BudgetNotification;
}

async function haltAndCancel(deps: KillSwitchDeps, reason: string): Promise<void> {
  await deps.halt(reason);
  const cancelled = await deps.cancelRunningExecutions();
  deps.log('Processing halted', { reason, cancelledExecutions: cancelled });
}

export async function handleMessage(
  m: KillSwitchMessage,
  config: KillSwitchConfig,
  deps: KillSwitchDeps,
): Promise<KillSwitchAction> {
  if (m.kind === 'budget') return handleBudgetNotification(m.notification, config, deps);
  if (m.incident.state && m.incident.state !== 'open') return 'none';
  if (await deps.isHalted()) {
    await deps.cancelRunningExecutions();
    return 'none';
  }
  await haltAndCancel(deps, `Usage alert: ${m.incident.policy_name ?? 'unknown policy'}`);
  return 'halted';
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
    await haltAndCancel(
      deps,
      `Budget notification in ${n.currencyCode}, expected ${config.currency}`,
    );
    return 'halted';
  }
  let action: KillSwitchAction = 'none';
  const cost = `${n.costAmount.toFixed(2)} ${config.currency}`;
  if (n.costAmount >= config.haltAt && !(await deps.isHalted())) {
    await haltAndCancel(deps, `GCP spend reached ${cost} (halt threshold ${config.haltAt})`);
    action = 'halted';
  }
  if (n.costAmount >= config.detachAt) {
    if (!(await deps.isHalted())) await haltAndCancel(deps, `GCP spend reached ${cost}`);
    if (await deps.isBillingEnabled()) {
      await deps.detachBilling();
      deps.log('Billing detached from project', { cost: n.costAmount });
      action = 'detached';
    }
  }
  return action;
}
