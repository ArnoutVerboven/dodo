import {
  BudgetExceededError,
  type CostGate,
  HaltedError,
  maxAffordableOutputTokens,
  modelPrice,
  type Scope,
  tokenCost,
  UnknownModelError,
} from '@dodo/budget';
import { eur, type GenerateRequest, type GenerateResponse, type MicroEur, paths } from '@dodo/core';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import type { ModelProvider } from './model-provider.js';

/**
 * The model gateway: the only path to Vertex AI. reserve → call → settle around every call,
 * with an output cap sized to the remaining budget, plus an independent hourly rate governor
 * that does not share the CostGate's code path.
 */
export interface GatewayDeps {
  db: Firestore;
  costGate: CostGate;
  provider: ModelProvider;
  /** Hard cap on model spend per clock hour across all runs. */
  hourlyCap: MicroEur;
  now?: () => number;
}

export const DEFAULT_HOURLY_CAP = eur(2);
/** Below this many affordable output tokens a call is pointless; stop and ask for a top-up. */
const MIN_USEFUL_OUTPUT = 256;
/** Default output ceiling per call; keeps a runaway reply from eating a task budget in one go. */
const DEFAULT_MAX_OUTPUT = 8192;
const DEFAULT_THINKING = 1024;

export interface GatewayContext {
  scopes: Scope[];
  /** Absent for job runs, which are charged to the job's scope instead of a task. */
  taskId?: string;
  projectId?: string;
  runId?: string;
  description: string;
}

export async function generateWithBudget(
  deps: GatewayDeps,
  ctx: GatewayContext,
  req: Omit<GenerateRequest, 'runId'>,
): Promise<GenerateResponse> {
  const now = deps.now ?? Date.now;
  let price: ReturnType<typeof modelPrice>;
  try {
    price = modelPrice(req.model);
  } catch (err) {
    if (err instanceof UnknownModelError) throw new HttpsError('invalid-argument', err.message);
    throw err;
  }

  const inputTokens = await deps.provider.countTokens(req);
  const available = await deps.costGate.available(ctx.scopes);
  const affordable = maxAffordableOutputTokens(req.model, inputTokens, available);
  const maxOutputTokens = Math.min(
    req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT,
    price.maxOutputTokens,
    affordable,
  );
  if (maxOutputTokens < MIN_USEFUL_OUTPUT) {
    throw new HttpsError('resource-exhausted', 'budget_exhausted', { available, inputTokens });
  }
  const thinkingBudget = Math.min(
    req.thinkingBudget ?? DEFAULT_THINKING,
    Math.floor(maxOutputTokens / 2),
  );
  const reserveAmount = tokenCost(req.model, inputTokens, maxOutputTokens);

  await takeGovernor(deps, reserveAmount, now());

  let reservation: { id: string; amount: MicroEur };
  try {
    reservation = await deps.costGate.reserve({
      scopes: ctx.scopes,
      category: 'tokens',
      amount: reserveAmount,
      description: ctx.description,
      taskId: ctx.taskId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      model: req.model,
    });
  } catch (err) {
    await returnGovernor(deps, reserveAmount, now());
    if (err instanceof BudgetExceededError) {
      throw new HttpsError('resource-exhausted', 'budget_exhausted', { scope: err.scopeKey });
    }
    if (err instanceof HaltedError) throw new HttpsError('unavailable', 'halted');
    throw err;
  }

  let actual = reservation.amount; // a failed call is charged in full: safe and visible
  try {
    const result = await deps.provider.generate({
      model: req.model,
      systemInstruction: req.systemInstruction,
      contents: req.contents,
      tools: req.tools,
      maxOutputTokens,
      thinkingBudget,
      temperature: req.temperature,
    });
    actual = tokenCost(req.model, result.usage.inputTokens, result.usage.outputTokens);
    const remaining = Math.max(0, available - actual);
    if (ctx.runId) {
      await deps.db.doc(paths.run(ctx.runId)).update({
        spent: FieldValue.increment(actual),
        steps: FieldValue.increment(1),
        updatedAt: now(),
      });
    }
    return {
      content: result.content,
      finishReason: result.finishReason,
      usage: result.usage,
      cost: actual,
      remaining,
    };
  } finally {
    await deps.costGate.settle(reservation.id, actual);
    await returnGovernor(deps, reservation.amount - actual, now());
  }
}

const governorDoc = (db: Firestore, now: number) =>
  db.collection('governor').doc(new Date(now).toISOString().slice(0, 13));

/** Reserve against the hourly cap; refuses with resource-exhausted when it would be exceeded. */
async function takeGovernor(deps: GatewayDeps, amount: MicroEur, now: number) {
  const ref = governorDoc(deps.db, now);
  await deps.db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    const used = (snap.data()?.used as number | undefined) ?? 0;
    if (used + amount > deps.hourlyCap) {
      throw new HttpsError('resource-exhausted', 'rate_governor', { used, cap: deps.hourlyCap });
    }
    t.set(ref, { used: used + amount, cap: deps.hourlyCap, updatedAt: now }, { merge: true });
  });
}

async function returnGovernor(deps: GatewayDeps, amount: MicroEur, now: number) {
  if (amount <= 0) return;
  await governorDoc(deps.db, now).set({ used: FieldValue.increment(-amount) }, { merge: true });
}
