import { describe, expect, it } from 'vitest';
import { GatewayBudgetError, GatewayRateLimitError } from './control-plane.js';
import { runAgent } from './loop.js';
import { FakeControlPlane, MemoryTaskStore, MemoryTrace, sampleTask } from './testing.js';
import { taskTools, toDeclarations } from './tools.js';

function setup(script: ConstructorParameters<typeof FakeControlPlane>[0]) {
  const control = new FakeControlPlane(script);
  const store = new MemoryTaskStore(sampleTask());
  const trace = new MemoryTrace();
  const run = (extra: Partial<Parameters<typeof runAgent>[0]> = {}) =>
    runAgent(
      {
        runId: 'r1',
        task: store.task,
        project: undefined,
        model: 'gemini-2.5-flash',
        trigger: 'new',
        session: [],
        ...extra,
      },
      { control, store, trace, tools: taskTools, heartbeatMs: 0 },
    );
  return { control, store, trace, run };
}

describe('runAgent', () => {
  it('runs tools until finish and reports the outcome', async () => {
    const { control, store, trace, run } = setup([
      { calls: [{ name: 'set_status', args: { text: 'Reading' } }] },
      {
        calls: [
          { name: 'update_summary', args: { markdown: '# Done\nSummary here' } },
          { name: 'finish', args: { outcome: 'done' } },
        ],
      },
    ]);
    const result = await run();
    expect(result.reason).toBe('finished');
    expect(result.steps).toBe(2);
    expect(store.status?.text).toBe('Reading');
    expect(store.summary).toContain('Summary here');
    expect(control.finishes[0]?.outcome).toBe('done');
    expect(control.finishes[0]?.session.length).toBe(result.session.length);
    expect(trace.types()).toEqual([
      'run_started',
      'model_call',
      'model_response',
      'tool_call',
      'tool_result',
      'model_call',
      'model_response',
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'run_finished',
    ]);
    // The first turn carries the task context and the tool declarations.
    expect(control.requests[0]?.contents[0]?.parts[0]?.text).toContain(
      'Summarise the attached document',
    );
    expect(control.requests[0]?.tools?.map((t) => t.name)).toContain('ask_user');
  });

  it('ends the run on ask_user and stores the session for the resume', async () => {
    const { control, run } = setup([
      {
        calls: [
          { name: 'ask_user', args: { kind: 'choice', prompt: 'Which?', options: ['A', 'B'] } },
        ],
      },
    ]);
    const result = await run();
    expect(result.reason).toBe('waiting_input');
    expect(control.inputRequests[0]?.prompt).toBe('Which?');
    expect(control.finishes).toHaveLength(0);
    // Session ends with the function response, so the resume can append the answer.
    expect(result.session.at(-1)?.parts[0]?.functionResponse?.name).toBe('ask_user');
  });

  it('attaches a browser screenshot to ask_user, cropped when a ref is given, never in the session', async () => {
    const control = new FakeControlPlane([
      {
        calls: [
          {
            name: 'ask_user',
            args: {
              kind: 'text',
              prompt: 'Scan the QR code with itsme',
              screenshot: true,
              screenshotElement: 'QR code',
              screenshotRef: 'e12',
            },
          },
        ],
      },
    ]);
    const store = new MemoryTaskStore(sampleTask());
    const targets: unknown[] = [];
    const result = await runAgent(
      {
        runId: 'r1',
        task: store.task,
        project: undefined,
        model: 'm',
        trigger: 'new',
        session: [],
      },
      {
        control,
        store,
        trace: new MemoryTrace(),
        tools: taskTools,
        heartbeatMs: 0,
        screenshot: async (target) => {
          targets.push(target);
          return { mimeType: 'image/png', data: 'iVBORw0KGgo=' };
        },
      },
    );
    expect(result.reason).toBe('waiting_input');
    expect(targets).toEqual([{ element: 'QR code', ref: 'e12' }]);
    expect(control.inputRequests[0]?.image).toEqual({
      mimeType: 'image/png',
      data: 'iVBORw0KGgo=',
    });
    expect(JSON.stringify(result.session)).not.toContain('iVBORw0KGgo=');
  });

  it('still asks when no screenshot can be taken', async () => {
    const { control, run } = setup([
      { calls: [{ name: 'ask_user', args: { kind: 'text', prompt: 'Log in', screenshot: true } }] },
    ]);
    const result = await run();
    expect(result.reason).toBe('waiting_input');
    expect(control.inputRequests[0]?.prompt).toBe('Log in');
    expect(control.inputRequests[0]?.image).toBeUndefined();
    expect(JSON.stringify(result.session)).toContain('No screenshot could be taken');
  });

  it('resumes with the answer', async () => {
    const { control, run } = setup([{ calls: [{ name: 'finish', args: { outcome: 'done' } }] }]);
    const prior = [
      { role: 'user' as const, parts: [{ text: 'ctx' }] },
      { role: 'model' as const, parts: [{ functionCall: { name: 'ask_user', args: {} } }] },
      { role: 'user' as const, parts: [{ functionResponse: { name: 'ask_user', response: {} } }] },
    ];
    await run({ trigger: 'resume', session: prior, answer: { prompt: 'Which?', value: 'B' } });
    const sent = control.requests[0]?.contents ?? [];
    expect(sent).toHaveLength(4);
    expect(sent[3]?.parts[0]?.text).toContain('B');
  });

  it('steers with comments from the heartbeat before the next model call', async () => {
    const { control, trace, run } = setup([
      { calls: [{ name: 'set_status', args: { text: 'x' } }] },
      { calls: [{ name: 'finish', args: { outcome: 'done' } }] },
    ]);
    control.flags = { pendingMessages: [{ id: 'm1', body: 'Use French', createdAt: 1 }] };
    await run();
    expect(trace.types().filter((t) => t === 'steer')).toHaveLength(1);
    expect(JSON.stringify(control.requests[0]?.contents)).toContain('Use French');
  });

  it('stops when the heartbeat says interrupted', async () => {
    const { control, run } = setup([{ calls: [{ name: 'finish', args: { outcome: 'done' } }] }]);
    control.flags = { ok: false, reason: 'interrupted' };
    const result = await run();
    expect(result.reason).toBe('interrupted');
    expect(control.requests).toHaveLength(0);
    expect(control.finishes[0]?.reason).toBe('interrupted');
  });

  it('stops when the gateway refuses for budget, and passes on which cap it was', async () => {
    const why = "budget_exhausted(project): the project's monthly budget has €0.01 left";
    const { control, run } = setup([{ error: new GatewayBudgetError(why) }]);
    expect((await run()).reason).toBe('budget_exhausted');
    expect(control.finishes[0]?.error).toBe(why);
  });

  it('ends the run as an error, not a budget, when the hourly cap is reached', async () => {
    const { control, run } = setup([{ error: new GatewayRateLimitError('the hourly cap') }]);
    expect((await run()).reason).toBe('error');
    expect(control.finishes[0]?.error).toBe('the hourly cap');
  });

  it('returns validation errors to the model instead of crashing', async () => {
    const { control, run } = setup([
      {
        calls: [
          { name: 'set_status', args: {} },
          { name: 'nope', args: {} },
        ],
      },
      { calls: [{ name: 'finish', args: { outcome: 'review' } }] },
    ]);
    const r = await run();
    expect(r.reason).toBe('finished');
    const fr = control.requests[1]?.contents.at(-1)?.parts ?? [];
    expect(JSON.stringify(fr[0]?.functionResponse?.response)).toContain('Invalid arguments');
    expect(JSON.stringify(fr[1]?.functionResponse?.response)).toContain('Unknown tool');
  });

  it('nudges a text-only reply once, then stops for review', async () => {
    const { control, store, run } = setup([{ text: 'I think...' }, { text: 'Final answer.' }]);
    const r = await run();
    expect(r.reason).toBe('finished');
    expect(control.finishes[0]?.outcome).toBe('review');
    expect(store.messages.at(-1)?.body).toBe('Final answer.');
  });

  it('caps the number of steps', async () => {
    const script = Array.from({ length: 5 }, () => ({
      calls: [{ name: 'set_status', args: { text: 'loop' } }],
    }));
    const control = new FakeControlPlane(script);
    const store = new MemoryTaskStore(sampleTask());
    const r = await runAgent(
      { runId: 'r', task: store.task, project: undefined, model: 'm', trigger: 'new', session: [] },
      { control, store, trace: new MemoryTrace(), tools: taskTools, maxSteps: 3, heartbeatMs: 0 },
    );
    expect(r.reason).toBe('max_steps');
    expect(r.steps).toBe(3);
  });
});

describe('toDeclarations', () => {
  it('produces Gemini-style function declarations', () => {
    const d = toDeclarations(taskTools).find((t) => t.name === 'ask_user');
    expect(d?.parameters).toMatchObject({ type: 'object' });
    expect(JSON.stringify(d?.parameters)).not.toContain('$schema');
  });
});
