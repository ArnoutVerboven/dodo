import type { ThreadMessage } from '@dodo/core';

export interface PendingInputs {
  /** Unanswered questions with no later message from you: these still need you. */
  open: Set<string>;
  /** The latest open question, where "Answer" takes you. */
  latest?: string;
}

/**
 * Which questions in a thread still need you. A question stays open until it is answered, or
 * until you post any later message in the thread: that message is your reply, so the earlier
 * question no longer asks for its own answer.
 */
export function pendingInputs(
  messages: Pick<ThreadMessage, 'id' | 'author' | 'createdAt' | 'input'>[],
): PendingInputs {
  let lastUserAt = Number.NEGATIVE_INFINITY;
  for (const m of messages) if (m.author === 'user') lastUserAt = Math.max(lastUserAt, m.createdAt);
  const open = messages
    .filter((m) => m.input && !m.input.answer && m.createdAt > lastUserAt)
    .sort((a, b) => a.createdAt - b.createdAt);
  return { open: new Set(open.map((m) => m.id)), latest: open.at(-1)?.id };
}
