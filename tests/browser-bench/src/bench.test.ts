import { describe, expect, it } from 'vitest';
import { interactiveOnly, outline, pruneSnapshots } from './drivers/mcp.ts';
import type { Message } from './model.ts';
import { euro, type RunRecord, summarize } from './report.ts';
import { passed, TASKS } from './tasks.ts';

const YAML = `- generic [ref=e1]:
  - banner [ref=e2]:
    - link "Shop" [ref=e3]
    - generic [ref=e4]:
      - text: We use cookies
      - button "Accept all" [ref=e5]
  - main [ref=e6]:
    - heading "Welcome back!" [level=1] [ref=e7]
    - paragraph [ref=e8]: Or log in with
    - textbox "Email" [ref=e9]`;

describe('page shaping', () => {
  it('keeps only interactive elements and headings', () => {
    expect(interactiveOnly(YAML).split('\n')).toEqual([
      '    - link "Shop" [ref=e3]',
      '      - button "Accept all" [ref=e5]',
      '    - heading "Welcome back!" [level=1] [ref=e7]',
      '    - textbox "Email" [ref=e9]',
    ]);
  });

  it('outlines a page by its landmarks and headings', () => {
    expect(outline(YAML)).toContain('heading "Welcome back!"');
    expect(outline(YAML)).not.toContain('button');
  });

  it('prunes every page snapshot but the latest', () => {
    const page = (n: number) => `### Snapshot\n\`\`\`yaml\n- button "B${n}" [ref=e${n}]\n\`\`\``;
    const messages: Message[] = [
      { role: 'tool', tool_call_id: 'a', content: page(1) },
      { role: 'tool', tool_call_id: 'b', content: 'ok' },
      { role: 'tool', tool_call_id: 'c', content: page(2) },
    ];
    pruneSnapshots(messages);
    expect(messages[0]?.role === 'tool' && messages[0].content).toBe(
      '### Snapshot\n[older page snapshot removed]',
    );
    expect(messages[2]?.role === 'tool' && messages[2].content).toBe(page(2));
  });
});

describe('tasks', () => {
  it('checks the final page, not what the agent says', () => {
    const t = TASKS.find((x) => x.id === 'booking-google-login');
    if (!t) throw new Error('missing task');
    expect(
      passed(t, { url: 'https://account.booking.com/sign-in', text: 'Continue with Google' }),
    ).toBe(true);
    expect(passed(t, { url: 'https://account.booking.com/sign-in', text: 'Email address' })).toBe(
      false,
    );
    expect(passed(t, { url: 'https://www.booking.com/', text: 'Google' })).toBe(false);
  });

  it('gives every task a check and a unique id', () => {
    expect(TASKS.every((t) => t.url || t.text)).toBe(true);
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(TASKS.length);
  });
});

describe('report', () => {
  const rec = (approach: RunRecord['approach'], success: boolean, input: number): RunRecord => ({
    task: 't',
    approach,
    rep: 1,
    success,
    agentSaysDone: true,
    calls: 2,
    input,
    output: 100,
    cached: 0,
    maxInput: input,
    seconds: 1,
    asked: 0,
    observedChars: 0,
    toolSchemaChars: 0,
    estimated: false,
    finalUrl: '',
  });

  it('prices tokens at gemini-3.8-flash rates', () => {
    expect(euro({ input: 1_000_000, output: 0 })).toBeCloseTo(0.75);
    expect(euro({ input: 0, output: 1_000_000 })).toBeCloseTo(3.75);
  });

  it('puts approaches side by side with cost per success', () => {
    const md = summarize({ model: 'm' }, [
      rec('dodo-current', true, 20_000),
      rec('dodo-current', false, 20_000),
      rec('agent-browser', true, 4_000),
    ]);
    expect(md).toContain('| dodo-current | 1/2 |');
    expect(md).toContain('| agent-browser | 1/1 |');
  });
});

describe('model', () => {
  it('sends Gemini thought signatures back with the tool call they came with', async () => {
    const { openAiModel } = await import('./model.ts');
    const { runLoop } = await import('./loop.ts');
    const bodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
    const sig = { google: { thought_signature: 'abc' } };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      const name = bodies.length === 1 ? 'browser_navigate' : 'done';
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: `c${bodies.length}`,
                    type: 'function',
                    function: { name, arguments: '{}' },
                    extra_content: sig,
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 1 },
        }),
      );
    }) as unknown as typeof fetch;
    try {
      await runLoop({
        model: openAiModel({ url: 'http://x/v1', model: 'm' }),
        driver: {
          tools: [{ name: 'browser_navigate', description: '', parameters: { type: 'object' } }],
          call: async () => ({ text: 'ok', isError: false }),
          finalState: async () => ({ url: '', text: '' }),
          close: async () => {},
        },
        goal: 'g',
        start: 's',
        maxCalls: 3,
        interactive: false,
      });
    } finally {
      globalThis.fetch = realFetch;
    }
    const assistant = bodies[1]?.messages.find((m) => m.role === 'assistant') as {
      tool_calls: Array<{ extra_content?: unknown }>;
    };
    expect(assistant.tool_calls[0]?.extra_content).toEqual(sig);
  });
});
