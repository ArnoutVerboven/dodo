import type { RunEvent } from '@dodo/core';
import { describe, expect, it } from 'vitest';
import { traceSteps } from './trace';

let seq = 0;
const ev = (type: RunEvent['type'], summary: string, data: Record<string, unknown> = {}, cost?: number): RunEvent => ({
  id: `e${seq}`,
  runId: 'r',
  seq: seq++,
  type,
  summary,
  data,
  ...(cost !== undefined ? { cost } : {}),
  createdAt: 1000 + seq,
});

describe('traceSteps', () => {
  it('joins a tool call with its result and the model cost, and drops model calls', () => {
    const steps = traceSteps([
      ev('run_started', 'Run started (new, m)', { trigger: 'new' }),
      ev('model_call', 'Model call 1', { turns: 2 }),
      ev('model_response', '→ browser_navigate', { text: '', calls: ['browser_navigate'] }, 300),
      ev('tool_call', 'browser_navigate({"url":"https://a.b"})', { name: 'browser_navigate', args: { url: 'https://a.b' } }),
      ev('tool_result', 'browser_navigate → {"ok":true}', { name: 'browser_navigate', result: { ok: true } }, 200),
      ev('model_call', 'Model call 2'),
      ev('model_response', 'Text: Done.', { text: 'Done.', calls: [] }, 100),
    ]);
    expect(steps.map((s) => s.kind)).toEqual(['event', 'tool', 'text']);
    expect(steps[1]).toMatchObject({ name: 'browser_navigate', args: { url: 'https://a.b' }, result: { ok: true }, status: 'ok', cost: 500 });
    expect(steps[2]).toMatchObject({ text: 'Done.', cost: 100 });
  });

  it('marks blocked, failed and still-running tools', () => {
    const steps = traceSteps([
      ev('tool_call', 'bash(…)', { name: 'bash', args: { command: 'rm x' } }),
      ev('tool_result', 'bash needs approval: bash(rm *)', { name: 'bash' }),
      ev('tool_call', 'read(…)', { name: 'read', args: {} }),
      ev('tool_result', 'read → {"error":"nope"}', { name: 'read', result: { error: 'nope' } }),
      ev('tool_call', 'write(…)', { name: 'write', args: {} }),
    ]);
    expect(steps.map((s) => s.kind === 'tool' && s.status)).toEqual(['blocked', 'error', 'pending']);
    expect(steps[0]).toMatchObject({ note: 'bash needs approval: bash(rm *)' });
  });

  it('keeps a result whose call is outside the window', () => {
    const steps = traceSteps([ev('tool_result', 'x → 1', { name: 'x', result: 1 })]);
    expect(steps[0]).toMatchObject({ kind: 'event', summary: 'x → 1' });
  });
});
