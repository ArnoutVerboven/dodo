import type { Content } from './run.js';

/**
 * Context compaction: when a task's conversation grows large, it is replaced by a summary
 * the model writes of it. Every model call re-sends the whole conversation, so compacting
 * well before the model's window is full also keeps each step cheap.
 */

/** Compact automatically once the conversation reaches this many tokens... */
export const AUTO_COMPACT_TOKENS = 200_000;
/** ...or this share of the model's context window, whichever comes first. */
export const AUTO_COMPACT_SHARE = 0.8;

export function compactThreshold(contextWindow: number): number {
  return Math.min(Math.floor(contextWindow * AUTO_COMPACT_SHARE), AUTO_COMPACT_TOKENS);
}

export const COMPACT_SYSTEM =
  'You summarise an AI agent’s work on a task so it can continue from the summary alone. ' +
  'Reply with the summary in Markdown and nothing else. Do not call tools.';

const COMPACT_INSTRUCTION = `Below is the transcript of your work on this task so far. It is about to be replaced by your summary of it, so the summary must hold everything needed to continue without the transcript:

1. The task and what the user wants, including every instruction, preference and answer the user gave (quote them where the wording matters).
2. What has been done, what was found, and decisions made with their reasons.
3. Current state: files, artifacts, links, ids, commands and values still needed (exact names and paths).
4. Open questions, errors still unresolved, and the next steps.

Be specific and complete, but leave out dead ends that no longer matter.`;

/** Header of the user turn that replaces a compacted conversation; also how one is recognised. */
export const COMPACTED_HEADER = 'This conversation was compacted to save context.';

const PART_LIMIT = 3_000;
const FIRST_LIMIT = 20_000;
/** About 100k tokens: the compaction call itself stays cheap and well inside any window. */
const TRANSCRIPT_LIMIT = 400_000;

const cut = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n)}… [${s.length - n} more characters]` : s;

/** One line per part: the conversation as plain text, tool calls and results included. */
export function renderEntry(c: Content, limit = PART_LIMIT): string {
  const lines: string[] = [];
  for (const p of c.parts) {
    if (p.thought) continue;
    if (p.text) lines.push(`[${c.role === 'model' ? 'agent' : 'user'}] ${cut(p.text, limit)}`);
    if (p.functionCall)
      lines.push(
        `[agent → ${p.functionCall.name}] ${cut(JSON.stringify(p.functionCall.args ?? {}), limit)}`,
      );
    if (p.functionResponse)
      lines.push(
        `[${p.functionResponse.name} result] ${cut(JSON.stringify(p.functionResponse.response), limit)}`,
      );
  }
  return lines.join('\n');
}

/**
 * The conversation as a transcript: the opening turn (the task) in full, then as many of the
 * latest turns as fit. Older turns in between are dropped with a note.
 */
export function renderTranscript(session: Content[], maxChars = TRANSCRIPT_LIMIT): string {
  if (session.length === 0) return '';
  const first = renderEntry(session[0] as Content, FIRST_LIMIT);
  const tail: string[] = [];
  let used = first.length;
  for (let i = session.length - 1; i >= 1; i--) {
    const line = renderEntry(session[i] as Content);
    if (used + line.length > maxChars) {
      tail.unshift(`[… ${i} earlier turns omitted …]`);
      break;
    }
    used += line.length;
    tail.unshift(line);
  }
  return [first, ...tail].filter(Boolean).join('\n');
}

/** The single-turn request that asks the model for the summary. No tools, plain text. */
export function compactionRequest(session: Content[]): Content[] {
  return [
    {
      role: 'user',
      parts: [
        {
          text: `${COMPACT_INSTRUCTION}\n\n<transcript>\n${renderTranscript(session)}\n</transcript>`,
        },
      ],
    },
  ];
}

/** The text of the model's summary reply, without thoughts. */
export function summaryText(reply: Content): string {
  return reply.parts
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join('')
    .trim();
}

/** What the conversation becomes after compaction: one user turn holding the summary. */
export function compactedSession(summary: string): Content[] {
  return [
    {
      role: 'user',
      parts: [
        {
          text: `${COMPACTED_HEADER} Summary of everything so far:\n\n${summary}\n\nContinue the task from here.`,
        },
      ],
    },
  ];
}

/** "8k", "0.21M": token counts as the task view shows them. */
export function formatTokens(n: number): string {
  if (n >= 100_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}
