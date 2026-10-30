import {
  BudgetExceededError,
  type CostGate,
  HaltedError,
  monthKey,
  type Scope,
  toolCost,
  toolPrice,
  toolReservation,
} from '@dodo/budget';
import type { MicroEur, TranscribeRequest, TranscribeResponse } from '@dodo/core';
import type { Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { budgetExhausted, returnGovernor, takeGovernor, tightestScope } from './gateway.js';
import type { TranscribeProvider } from './model-provider.js';

/**
 * Push-to-talk (web app › new task, reply box): a voice note to text with Gemini audio input.
 * No task pays for it, since a new task has none yet and a reply should not eat the agent's
 * budget: it counts against the lifetime and monthly budgets only, reserve → call → settle
 * through the CostGate under the hourly governor like every other paid call.
 */
export interface TranscribeDeps {
  db: Firestore;
  costGate: CostGate;
  provider: TranscribeProvider;
  hourlyCap: MicroEur;
  now?: () => number;
}

export const TRANSCRIBE_TOOL = 'transcribe';
/** One billed unit is a minute of audio: 32 tokens a second. */
export const AUDIO_TOKENS_PER_UNIT = 1920;

export const transcribeScopes = (now: number): Scope[] => [
  { kind: 'total' },
  { kind: 'global', month: monthKey(now) },
];

/** What a transcription cost: every input token at the audio rate, plus the transcript. */
export const transcribeCost = (inputTokens: number, outputTokens: number): MicroEur =>
  toolCost(TRANSCRIBE_TOOL, inputTokens / AUDIO_TOKENS_PER_UNIT, {
    input: 0,
    output: outputTokens,
  });

export async function transcribeWithBudget(
  deps: TranscribeDeps,
  req: TranscribeRequest,
): Promise<TranscribeResponse> {
  const now = deps.now ?? Date.now;
  const price = toolPrice(TRANSCRIBE_TOOL);
  const model = price.model as NonNullable<typeof price.model>;
  const amount = toolReservation(TRANSCRIBE_TOOL);
  const scopes = transcribeScopes(now());

  const available = await deps.costGate.available(scopes);
  if (available < amount) {
    const tightest = await tightestScope(deps.costGate, scopes);
    throw budgetExhausted(tightest.key, tightest.room, amount);
  }
  // The credit goes back to the hour it was taken from, even if the call crosses the hour.
  const takenAt = now();
  await takeGovernor(deps, amount, takenAt);
  let reservation: { id: string; amount: MicroEur };
  try {
    reservation = await deps.costGate.reserve({
      scopes,
      category: 'action',
      amount,
      description: 'push-to-talk transcription',
      model: model.name,
    });
  } catch (err) {
    await returnGovernor(deps, amount, takenAt);
    if (err instanceof BudgetExceededError)
      throw budgetExhausted(err.scopeKey, err.available, err.requested);
    if (err instanceof HaltedError) throw new HttpsError('unavailable', 'halted');
    throw err;
  }

  let actual = reservation.amount; // a failed call is charged in full: safe and visible
  try {
    const result = await deps.provider.transcribe({
      model: model.name,
      audio: req.audio,
      mimeType: req.mimeType,
      language: req.language,
      maxOutputTokens: model.maxOutputTokens,
    });
    // Never settle above the reservation: a longer note than we sized for is still capped.
    actual = Math.min(
      reservation.amount,
      transcribeCost(result.usage.inputTokens, result.usage.outputTokens),
    );
    return { text: result.text, cost: actual };
  } finally {
    await deps.costGate.settle(reservation.id, actual);
    await returnGovernor(deps, reservation.amount - actual, takenAt);
  }
}
