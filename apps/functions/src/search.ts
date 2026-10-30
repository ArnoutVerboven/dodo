import {
  BudgetExceededError,
  type CostGate,
  HaltedError,
  toolCost,
  toolPrice,
  toolReservation,
} from '@dodo/budget';
import { type MicroEur, paths, type SearchResponse } from '@dodo/core';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  budgetExhausted,
  type GatewayContext,
  returnGovernor,
  takeGovernor,
  tightestScope,
} from './gateway.js';
import type { SearchProvider } from './model-provider.js';

/**
 * The web_search tool's paid call (#13, #15): Gemini with Grounding with Google Search, on the
 * same Vertex project and GCP cap as every model call. reserve → search → settle through the
 * CostGate with the tool's cost model (TOOL_PRICES.web_search), under the hourly governor, and
 * added to the run's spend like a model step.
 */
export interface SearchDeps {
  db: Firestore;
  costGate: CostGate;
  provider: SearchProvider;
  hourlyCap: MicroEur;
  now?: () => number;
}

export const SEARCH_TOOL = 'web_search';

export async function searchWithBudget(
  deps: SearchDeps,
  ctx: GatewayContext,
  query: string,
): Promise<SearchResponse> {
  const now = deps.now ?? Date.now;
  const price = toolPrice(SEARCH_TOOL);
  const model = price.model as NonNullable<typeof price.model>;
  const amount = toolReservation(SEARCH_TOOL);

  const available = await deps.costGate.available(ctx.scopes);
  if (available < amount) {
    const tightest = await tightestScope(deps.costGate, ctx.scopes);
    throw budgetExhausted(tightest.key, tightest.room, amount);
  }
  await takeGovernor(deps, amount, now());
  let reservation: { id: string; amount: MicroEur };
  try {
    reservation = await deps.costGate.reserve({
      scopes: ctx.scopes,
      category: 'action',
      amount,
      description: ctx.description,
      taskId: ctx.taskId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      model: model.name,
    });
  } catch (err) {
    await returnGovernor(deps, amount, now());
    if (err instanceof BudgetExceededError)
      throw budgetExhausted(err.scopeKey, err.available, err.requested);
    if (err instanceof HaltedError) throw new HttpsError('unavailable', 'halted');
    throw err;
  }

  let actual = reservation.amount; // a failed search is charged in full: safe and visible
  try {
    const result = await deps.provider.search({
      model: model.name,
      query,
      maxOutputTokens: model.maxOutputTokens,
    });
    // Google bills the queries only when the answer cites a web source.
    const billed = result.sources.length > 0 ? Math.max(1, result.queries.length) : 0;
    actual = toolCost(SEARCH_TOOL, billed, {
      input: result.usage.inputTokens,
      output: result.usage.outputTokens,
    });
    if (ctx.runId) {
      await deps.db.doc(paths.run(ctx.runId)).update({
        spent: FieldValue.increment(actual),
        updatedAt: now(),
      });
    }
    return {
      answer: result.answer,
      sources: result.sources,
      queries: result.queries,
      cost: actual,
      remaining: Math.max(0, available - actual),
    };
  } finally {
    await deps.costGate.settle(reservation.id, actual);
    await returnGovernor(deps, reservation.amount - actual, now());
  }
}
