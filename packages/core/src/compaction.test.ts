import { describe, expect, it } from 'vitest';
import {
  compactedSession,
  compactionRequest,
  compactThreshold,
  formatTokens,
  renderTranscript,
} from './compaction.js';
import type { Content } from './run.js';

describe('compaction', () => {
  it('compacts at 200k tokens or 80% of a small window', () => {
    expect(compactThreshold(1_048_576)).toBe(200_000);
    expect(compactThreshold(100_000)).toBe(80_000);
  });

  it('renders tool calls and results, without thoughts', () => {
    const session: Content[] = [
      { role: 'user', parts: [{ text: 'Book a table' }] },
      {
        role: 'model',
        parts: [
          { text: 'secret reasoning', thought: true },
          { functionCall: { name: 'http_fetch', args: { url: 'https://x.test' } } },
        ],
      },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'http_fetch', response: { status: 200 } } }],
      },
    ];
    const t = renderTranscript(session);
    expect(t).toContain('[user] Book a table');
    expect(t).toContain('[agent → http_fetch] {"url":"https://x.test"}');
    expect(t).toContain('[http_fetch result] {"status":200}');
    expect(t).not.toContain('secret reasoning');
    expect(compactionRequest(session)[0]?.parts[0]?.text).toContain('<transcript>');
  });

  it('keeps the task and the latest turns when the transcript is too long', () => {
    const turn = (i: number): Content => ({
      role: 'model',
      parts: [{ text: `turn ${i} ${'x'.repeat(90)}` }],
    });
    const session = [
      { role: 'user' as const, parts: [{ text: 'The task' }] },
      ...Array.from({ length: 50 }, (_, i) => turn(i)),
    ];
    const t = renderTranscript(session, 1_000);
    expect(t.startsWith('[user] The task')).toBe(true);
    expect(t).toContain('turn 49');
    expect(t).not.toContain('turn 0 ');
    expect(t).toContain('earlier turns omitted');
  });

  it('replaces the conversation with one user turn', () => {
    const s = compactedSession('Did A, next B');
    expect(s).toHaveLength(1);
    expect(s[0]?.role).toBe('user');
    expect(s[0]?.parts[0]?.text).toContain('Did A, next B');
  });

  it('formats token counts', () => {
    expect(formatTokens(800)).toBe('800');
    expect(formatTokens(8_400)).toBe('8k');
    expect(formatTokens(212_000)).toBe('0.21M');
    expect(formatTokens(1_048_576)).toBe('1.05M');
  });
});
