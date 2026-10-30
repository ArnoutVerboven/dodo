import { describe, expect, it } from 'vitest';
import { contextBreakdown, toolsetLabel } from './context-breakdown.js';
import { compactedTurn } from './prompts.js';

describe('toolsetLabel', () => {
  it('names built-in groups, MCP servers and the rest', () => {
    expect(toolsetLabel('finish')).toBe('Task basics');
    expect(toolsetLabel('browser_click')).toBe('Browser');
    expect(toolsetLabel('mcp__outlook__send_mail')).toBe('MCP: outlook');
    expect(toolsetLabel('something_new')).toBe('Other tools');
  });
});

describe('contextBreakdown', () => {
  const req = {
    systemInstruction: 'x'.repeat(400),
    tools: [
      { name: 'finish', description: 'd'.repeat(100) },
      { name: 'mcp__notes__read', description: 'd'.repeat(100) },
    ],
    contents: [
      { role: 'user' as const, parts: [{ text: 'task '.repeat(40) }] },
      { role: 'model' as const, parts: [{ functionCall: { name: 'finish', args: {} } }] },
      {
        role: 'user' as const,
        parts: [{ functionResponse: { name: 'finish', response: { ok: true } } }],
      },
    ],
  };

  it('splits the measured total so the parts add up to it', () => {
    const parts = contextBreakdown(req, 1000, 50);
    const prompt = parts.filter((p) => p.kind !== 'reply').reduce((s, p) => s + p.tokens, 0);
    expect(Math.abs(prompt - 1000)).toBeLessThanOrEqual(parts.length);
    expect(parts.find((p) => p.kind === 'reply')?.tokens).toBe(50);
    expect(parts.map((p) => p.label)).toEqual(
      expect.arrayContaining([
        'System prompt',
        'Task basics',
        'MCP: notes',
        'Task and thread',
        'Tool calls',
        'Tool results',
      ]),
    );
    const system = parts.find((p) => p.label === 'System prompt')?.tokens ?? 0;
    const task = parts.find((p) => p.label === 'Task and thread')?.tokens ?? 0;
    expect(system).toBeGreaterThan(task);
  });

  it('names a compacted conversation as the summary', () => {
    const parts = contextBreakdown(
      { contents: [{ role: 'user', parts: [{ text: compactedTurn('done so far') }] }] },
      100,
    );
    expect(parts).toEqual([{ kind: 'conversation', label: 'Summary (compacted)', tokens: 100 }]);
  });
});
