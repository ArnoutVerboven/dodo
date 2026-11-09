import {
  BudgetExceededError,
  type CostGate,
  contextWindow,
  HaltedError,
  maxAffordableOutputTokens,
  modelPrice,
  type Scope,
  scopeKey,
  tokenCost,
  UnknownModelError,
} from '@dodo/budget';
import {
  contextBreakdown,
  eur,
  type GenerateRequest,
  type GenerateResponse,
  isLocalModel,
  type MicroEur,
  paths,
  type Usage,
} from '@dodo/core';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { type ModelProvider, type ModelRequest, usageFromGemini } from './model-provider.js';

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

const fmtEur = (micro: MicroEur) => `€${(micro / 1_000_000).toFixed(2)}`;

/**
 * Which cap a budget scope key is, for the message the user reads and for what the run offers
 * next: a task's own budget can be topped up from the task; the others are raised in settings.
 */
export function scopeKind(key: string): 'total' | 'monthly' | 'project' | 'job' | 'task' {
  if (key === 'total') return 'total';
  if (key.startsWith('global_')) return 'monthly';
  if (key.startsWith('project_')) return 'project';
  if (key.startsWith('job_')) return 'job';
  return 'task';
}

const SCOPE_NAMES = {
  total: 'the lifetime budget',
  monthly: 'the monthly budget',
  project: "the project's monthly budget",
  job: "the job's monthly budget",
  task: "the task's budget",
} as const;

/**
 * The refusal a worker turns into a `budget_exhausted` end: `budget_exhausted(<kind>): <why>`.
 * The kind tells the run what to offer (a top-up only for the task's own budget), the rest is
 * what the user reads.
 */
export function budgetExhausted(
  key: string,
  room: MicroEur,
  needed: MicroEur,
  inputTokens?: number,
) {
  const kind = scopeKind(key);
  const why = `${SCOPE_NAMES[kind]} has ${fmtEur(room)} left and this call needs ${fmtEur(needed)}${
    inputTokens ? ` (${Math.round(inputTokens / 1000)}k input tokens)` : ''
  }`;
  return new HttpsError('resource-exhausted', `budget_exhausted(${kind}): ${why}`, {
    scope: key,
    available: room,
    needed,
    inputTokens,
  });
}

/** The scope with the least room; on a tie the task's own, which a top-up can fix. */
export async function tightestScope(
  costGate: Pick<CostGate, 'available'>,
  scopes: Scope[],
): Promise<{ key: string; room: MicroEur }> {
  let tightest = { key: scopeKey(scopes[0] as Scope), room: Number.POSITIVE_INFINITY };
  for (const s of scopes) {
    const key = scopeKey(s);
    const room = await costGate.available([s]);
    if (room < tightest.room || (room === tightest.room && scopeKind(key) === 'task'))
      tightest = { key, room };
  }
  return tightest;
}

export interface GatewayContext {
  scopes: Scope[];
  /** Absent for job runs, which are charged to the job's scope instead of a task. */
  taskId?: string;
  projectId?: string;
  runId?: string;
  description: string;
}

/** A call the budget has room for: its clamped limits and the money held for it. */
interface OpenCall {
  inputTokens: number;
  available: MicroEur;
  maxOutputTokens: number;
  thinkingBudget: number;
  reservation: { id: string; amount: MicroEur };
  takenAt: number;
}

/**
 * Everything before the provider is called: price check, output cap sized to the remaining
 * budget, the hourly governor and the reservation. The caller must `closeCall` it.
 */
async function openCall(
  deps: GatewayDeps,
  ctx: GatewayContext,
  req: Omit<GenerateRequest, 'runId'>,
): Promise<OpenCall> {
  const now = deps.now ?? Date.now;
  if (isLocalModel(req.model)) {
    // The worker on the Mac calls its own server; reaching the gateway means it has none.
    throw new HttpsError(
      'invalid-argument',
      'The local model runs only on a Mac with one set up (`dodo model set`).',
    );
  }
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
    // Name the tightest cap: a task top-up is no help when the month or the project is out.
    const tightest = await tightestScope(deps.costGate, ctx.scopes);
    throw budgetExhausted(
      tightest.key,
      tightest.room,
      tokenCost(req.model, inputTokens, MIN_USEFUL_OUTPUT),
      inputTokens,
    );
  }
  const thinkingBudget = Math.min(
    req.thinkingBudget ?? DEFAULT_THINKING,
    Math.floor(maxOutputTokens / 2),
  );
  const reserveAmount = tokenCost(req.model, inputTokens, maxOutputTokens);

  // The credit goes back to the hour it was taken from, even if the call crosses the hour.
  const takenAt = now();
  await takeGovernor(deps, reserveAmount, takenAt);

  try {
    const reservation = await deps.costGate.reserve({
      scopes: ctx.scopes,
      category: 'tokens',
      amount: reserveAmount,
      description: ctx.description,
      taskId: ctx.taskId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      model: req.model,
    });
    return { inputTokens, available, maxOutputTokens, thinkingBudget, reservation, takenAt };
  } catch (err) {
    await returnGovernor(deps, reserveAmount, takenAt);
    if (err instanceof BudgetExceededError) {
      throw budgetExhausted(err.scopeKey, err.available, err.requested, inputTokens);
    }
    if (err instanceof HaltedError) throw new HttpsError('unavailable', 'halted');
    throw err;
  }
}

/** What the call cost, written to the run (spend, steps) and the task (context size). */
async function recordUsage(
  deps: GatewayDeps,
  ctx: GatewayContext,
  req: Omit<GenerateRequest, 'runId'>,
  usage: Usage,
): Promise<MicroEur> {
  const now = deps.now ?? Date.now;
  const actual = tokenCost(
    req.model,
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedInputTokens,
  );
  if (ctx.runId) {
    await deps.db.doc(paths.run(ctx.runId)).update({
      spent: FieldValue.increment(actual),
      steps: FieldValue.increment(1),
      updatedAt: now(),
    });
  }
  if (ctx.runId && ctx.taskId) {
    // An agent step's conversation (not a title): what the next call carries is this
    // request plus the reply that joins it. A summary call says nothing of that size.
    const fields =
      req.purpose === 'compact'
        ? { 'context.compactedAt': now() }
        : {
            'context.tokens': usage.inputTokens + usage.outputTokens,
            'context.max': contextWindow(req.model),
            'context.model': req.model,
            'context.breakdown': contextBreakdown(req, usage.inputTokens, usage.outputTokens),
            'context.updatedAt': now(),
          };
    // A display value: never fail a paid-for call over it.
    await deps.db
      .doc(paths.task(ctx.taskId))
      .update(fields)
      .catch(() => undefined);
  }
  return actual;
}

/** Settle the reservation at what the call cost and give the rest back to the hour. */
async function closeCall(deps: GatewayDeps, open: OpenCall, actual: MicroEur) {
  await deps.costGate.settle(open.reservation.id, actual);
  await returnGovernor(deps, open.reservation.amount - actual, open.takenAt);
}

const modelRequest = (req: Omit<GenerateRequest, 'runId'>, open: OpenCall): ModelRequest => ({
  model: req.model,
  systemInstruction: req.systemInstruction,
  contents: req.contents,
  tools: req.tools,
  maxOutputTokens: open.maxOutputTokens,
  thinkingBudget: open.thinkingBudget,
  temperature: req.temperature,
});

export async function generateWithBudget(
  deps: GatewayDeps,
  ctx: GatewayContext,
  req: Omit<GenerateRequest, 'runId'>,
): Promise<GenerateResponse> {
  const open = await openCall(deps, ctx, req);
  let actual = open.reservation.amount; // a failed call is charged in full: safe and visible
  try {
    const result = await deps.provider.generate(modelRequest(req, open));
    actual = await recordUsage(deps, ctx, req, result.usage);
    return {
      content: result.content,
      finishReason: result.finishReason,
      usage: result.usage,
      cost: actual,
      remaining: Math.max(0, open.available - actual),
    };
  } finally {
    await closeCall(deps, open, actual);
  }
}

/** Extra Gemini settings a streamed call passes through untouched. */
export interface StreamExtras {
  toolConfig?: Record<string, unknown>;
  includeThoughts?: boolean;
}

/**
 * The same reserve → call → settle as `generateWithBudget`, for a harness that speaks
 * Gemini's own streaming API (pi): each chunk goes to `onChunk` as Gemini sent it, and the
 * usage on the last chunk settles the call. A stream that breaks off is charged in full.
 */
export async function streamWithBudget(
  deps: GatewayDeps,
  ctx: GatewayContext,
  req: Omit<GenerateRequest, 'runId'> & StreamExtras,
  onChunk: (chunk: Record<string, unknown>) => void | Promise<void>,
): Promise<{ usage: Usage; cost: MicroEur; remaining: MicroEur }> {
  const stream = deps.provider.generateStream;
  if (!stream) throw new HttpsError('unimplemented', 'This model backend cannot stream.');
  const open = await openCall(deps, ctx, req);
  let actual = open.reservation.amount;
  try {
    let usage: Usage | undefined;
    const chunks = await stream.call(deps.provider, {
      ...modelRequest(req, open),
      toolConfig: req.toolConfig,
      includeThoughts: req.includeThoughts,
    });
    for await (const chunk of chunks) {
      usage = usageFromGemini(chunk.usageMetadata) ?? usage;
      await onChunk(chunk);
    }
    // No usage at all: we cannot tell what it cost, so it stays charged in full.
    if (!usage) throw new Error('The model stream ended without usage');
    actual = await recordUsage(deps, ctx, req, usage);
    return { usage, cost: actual, remaining: Math.max(0, open.available - actual) };
  } finally {
    await closeCall(deps, open, actual);
  }
}

const governorDoc = (db: Firestore, now: number) =>
  db.collection('governor').doc(new Date(now).toISOString().slice(0, 13));

/** Reserve against the hourly cap (model calls and paid tools); refuses with resource-exhausted when it would be exceeded. */
export async function takeGovernor(
  deps: Pick<GatewayDeps, 'db' | 'hourlyCap'>,
  amount: MicroEur,
  now: number,
) {
  const ref = governorDoc(deps.db, now);
  await deps.db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    const used = (snap.data()?.used as number | undefined) ?? 0;
    if (used + amount > deps.hourlyCap) {
      // Not a budget: the same hour's cap across every run, over at the top of the hour. A
      // worker ends its run on this with the message, and a comment retries later.
      const next = new Date(now);
      next.setUTCHours(next.getUTCHours() + 1, 0, 0, 0);
      const at = `${String(next.getUTCHours()).padStart(2, '0')}:00 UTC`;
      throw new HttpsError(
        'resource-exhausted',
        `rate_governor: the hourly cap on model spend is reached (${fmtEur(used)} of ${fmtEur(deps.hourlyCap)} this hour); it resets at ${at}`,
        { used, cap: deps.hourlyCap },
      );
    }
    t.set(ref, { used: used + amount, cap: deps.hourlyCap, updatedAt: now }, { merge: true });
  });
}

export async function returnGovernor(
  deps: Pick<GatewayDeps, 'db' | 'hourlyCap'>,
  amount: MicroEur,
  now: number,
) {
  if (amount <= 0) return;
  await governorDoc(deps.db, now).set({ used: FieldValue.increment(-amount) }, { merge: true });
}
