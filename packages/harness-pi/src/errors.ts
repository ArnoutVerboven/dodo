import type { RunEndReason } from '@dodo/core';

/** Cut a long message, as dodo's traces do. */
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export type End = { reason: RunEndReason; outcome?: 'done' | 'review' | 'blocked'; error?: string };

/** A gateway refusal as pi reports it (the Gemini error body) as how the run ends. */
export function endForModelError(message: string): End {
  let status = '';
  let text = message;
  try {
    const e = (JSON.parse(message) as { error?: { status?: string; message?: string } }).error;
    status = e?.status ?? '';
    text = e?.message ?? message;
  } catch {
    status =
      /RESOURCE_EXHAUSTED|UNAVAILABLE|FAILED_PRECONDITION|PERMISSION_DENIED/.exec(message)?.[0] ??
      '';
  }
  if (status === 'RESOURCE_EXHAUSTED' || /budget_exhausted|rate_governor/.test(text)) {
    const rate = /rate_governor:\s*/.exec(text);
    return rate
      ? { reason: 'error', error: text.slice(rate.index + rate[0].length) }
      : { reason: 'budget_exhausted', error: text };
  }
  if (status === 'UNAVAILABLE' && /halted/.test(text)) return { reason: 'halted' };
  if (status === 'FAILED_PRECONDITION' || status === 'PERMISSION_DENIED') {
    return { reason: 'lease_lost' };
  }
  return { reason: 'error', error: cut(text, 500) };
}
