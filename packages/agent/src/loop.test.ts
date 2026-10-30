import { HEADLESS_RESTARTED } from '@dodo/core';
import { describe, expect, it } from 'vitest';
import { GatewayBudgetError, GatewayRateLimitError, LeaseLostError } from './control-plane.js';
import { HOLD_DEADLINE_MARGIN_MS, holdTime, runAgent } from './loop.js';
import { FakeControlPlane, MemoryTaskStore, MemoryTrace, sampleTask } from './testing.js';
import { requestBrowserTool, requestDeviceTool, taskTools, toDeclarations } from './tools.js';

function setup(script: ConstructorParameters<typeof FakeControlPlane>[0]) {
  const control = new FakeControlPlane(script);
  const store = new MemoryTaskStore(sampleTask());
  const trace = new MemoryTrace();
  const run = (
    extra: Partial<Parameters<typeof runAgent>[0]> = {},
    options: Partial<Parameters<typeof runAgent>[1]> = {},
  ) =>
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
      { control, store, trace, tools: taskTools, heartbeatMs: 0, ...options },
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

  it('holds for the answer after ask_user and continues in the same run', async () => {
    const { control, trace, run } = setup([
      { calls: [{ name: 'ask_user', args: { kind: 'text', prompt: 'Enter the SMS code' } }] },
      { calls: [{ name: 'finish', args: { outcome: 'done' } }] },
    ]);
    control.heldAnswers.push({ messageId: 'm1', prompt: 'Enter the SMS code', value: '123456' });
    const result = await run({}, { inputHoldMs: 5000, heartbeatMs: 10 });
    expect(result.reason).toBe('finished');
    expect(control.inputRequests[0]?.holdMs).toBe(5000);
    // One run: the question, the answer, then the second model call saw the answer.
    expect(control.requests).toHaveLength(2);
    expect(control.requests[1]?.contents.at(-1)?.parts[0]?.text).toContain('123456');
    expect(control.finishes[0]?.reason).toBe('finished');
    expect(trace.types()).toContain('steer');
  });

  it('parks the run when the hold runs out without an answer', async () => {
    const { control, run } = setup([
      { calls: [{ name: 'ask_user', args: { kind: 'text', prompt: 'Enter the SMS code' } }] },
    ]);
    const result = await run({}, { inputHoldMs: 30, heartbeatMs: 10 });
    expect(result.reason).toBe('waiting_input');
    expect(control.inputRequests).toHaveLength(1);
    // The question is already posted; the park goes through finish, with the session.
    expect(control.finishes[0]?.reason).toBe('waiting_input');
    expect(control.finishes[0]?.session.at(-1)?.parts[0]?.functionResponse?.name).toBe('ask_user');
  });

  it('does not hold past the worker deadline: it parks the run the old way', async () => {
    const { control, run } = setup([
      { calls: [{ name: 'ask_user', args: { kind: 'text', prompt: 'Enter the SMS code' } }] },
    ]);
    const result = await run(
      {},
      { inputHoldMs: 5000, heartbeatMs: 10, deadline: Date.now() + HOLD_DEADLINE_MARGIN_MS },
    );
    expect(result.reason).toBe('waiting_input');
    // No hold: the question goes with the park, not as a held request.
    expect(control.inputRequests[0]?.holdMs).toBeUndefined();
  });

  it('stops the hold when the heartbeat says interrupted', async () => {
    const { control, run } = setup([
      { calls: [{ name: 'ask_user', args: { kind: 'text', prompt: 'Enter the SMS code' } }] },
    ]);
    control.flags = { ok: false, reason: 'interrupted' };
    const result = await run({}, { inputHoldMs: 5000, heartbeatMs: 10 });
    expect(result.reason).toBe('interrupted');
    expect(control.finishes[0]?.reason).toBe('interrupted');
  });

  it("moves to the user's Mac when the agent asks for it", async () => {
    const { control, run } = setup([
      { calls: [{ name: 'request_device', args: { reason: 'itsme login' } }] },
    ]);
    const browserTool = { ...taskTools[0], name: 'browser_navigate' };
    const result = await run(
      {},
      { tools: [...taskTools, browserTool, requestDeviceTool], browserKind: 'headless' },
    );
    expect(result.reason).toBe('needs_device');
    expect(control.finishes[0]?.reason).toBe('needs_device');
    expect(control.finishes[0]?.session.at(-1)?.parts[0]?.functionResponse?.name).toBe(
      'request_device',
    );
    expect(control.requests[0]?.systemInstruction).toContain('request_device');
  });

  it('restarts with a browser when the agent asks for one', async () => {
    const { control, run } = setup([
      { calls: [{ name: 'request_browser', args: { reason: 'the site needs a login' } }] },
    ]);
    const result = await run({}, { tools: [...taskTools, requestBrowserTool] });
    expect(result.reason).toBe('needs_browser');
    expect(control.finishes[0]?.reason).toBe('needs_browser');
    expect(control.finishes[0]?.session.at(-1)?.parts[0]?.functionResponse?.name).toBe(
      'request_browser',
    );
    expect(control.requests[0]?.systemInstruction).toContain('request_browser');
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

  it('tells a resumed run with a headless browser that its pages are gone', async () => {
    const { control, run } = setup([{ calls: [{ name: 'finish', args: { outcome: 'done' } }] }]);
    const prior = [
      { role: 'user' as const, parts: [{ text: 'ctx' }] },
      { role: 'model' as const, parts: [{ functionCall: { name: 'ask_user', args: {} } }] },
      { role: 'user' as const, parts: [{ functionResponse: { name: 'ask_user', response: {} } }] },
    ];
    const browserTool = { ...taskTools[0], name: 'browser_navigate' };
    await run(
      { trigger: 'resume', session: prior, answer: { prompt: 'Which?', value: 'B' } },
      { tools: [...taskTools, browserTool], browserKind: 'headless' },
    );
    const last = control.requests[0]?.contents.at(-1);
    expect(last?.role).toBe('user');
    expect(JSON.stringify(last)).toContain('B');
    expect(JSON.stringify(last)).toContain(HEADLESS_RESTARTED);
    expect(JSON.stringify(last)).toContain('so are its logins');
    // With the task's logins and last page restored, the note says so.
    const { control: c3, run: run3 } = setup([
      { calls: [{ name: 'finish', args: { outcome: 'done' } }] },
    ]);
    await run3(
      { trigger: 'resume', session: prior, answer: { prompt: 'Which?', value: 'B' } },
      {
        tools: [...taskTools, browserTool],
        browserKind: 'headless',
        browserRestored: { logins: true, lastUrl: 'https://example.com/account' },
      },
    );
    const last3 = JSON.stringify(c3.requests[0]?.contents.at(-1));
    expect(last3).toContain('logins (cookies and local storage) are restored');
    expect(last3).toContain('Last time you were on https://example.com/account');
    // A window on the Mac keeps its tabs: no such note.
    const { control: c2, run: run2 } = setup([
      { calls: [{ name: 'finish', args: { outcome: 'done' } }] },
    ]);
    await run2(
      { trigger: 'resume', session: prior, answer: { prompt: 'Which?', value: 'B' } },
      { tools: [...taskTools, browserTool], browserKind: 'window' },
    );
    expect(JSON.stringify(c2.requests[0]?.contents)).not.toContain(HEADLESS_RESTARTED);
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

  it('survives a failed heartbeat while the lease is still safe', async () => {
    const { control, run } = setup([{ calls: [{ name: 'finish', args: { outcome: 'done' } }] }]);
    control.heartbeatErrors = [new Error('UNAVAILABLE: network blip')];
    const result = await run();
    // The first beat failed, the step's call went on; finish is the model's, not an error.
    expect(result.reason).toBe('finished');
    expect(control.finishes[0]?.outcome).toBe('done');
  });

  it('gives up when heartbeats keep failing past the tolerance', async () => {
    const { control, run } = setup([{ calls: [{ name: 'finish', args: { outcome: 'done' } }] }]);
    control.heartbeatErrors = [new Error('UNAVAILABLE')];
    const result = await run({}, { heartbeatToleranceMs: 0 });
    expect(result.reason).toBe('error');
    expect(control.requests).toHaveLength(0);
  });

  it('ends at once on a lost lease, whatever the tolerance', async () => {
    const { control, run } = setup([{ calls: [{ name: 'finish', args: { outcome: 'done' } }] }]);
    control.heartbeatErrors = [new LeaseLostError('lease_lost')];
    const result = await run({}, { heartbeatToleranceMs: 60_000 });
    expect(result.reason).toBe('lease_lost');
    expect(control.requests).toHaveLength(0);
  });

  it('never runs two heartbeats at once', async () => {
    const { control, run } = setup([
      { calls: [{ name: 'set_status', args: { text: 'a' } }] },
      { calls: [{ name: 'finish', args: { outcome: 'done' } }] },
    ]);
    let live = 0;
    let most = 0;
    const plain = control.heartbeat.bind(control);
    control.heartbeat = async () => {
      live++;
      most = Math.max(most, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return plain();
    };
    await run({}, { heartbeatMs: 1 });
    expect(most).toBe(1);
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

  it('compacts the conversation once it passes the threshold and carries on from the summary', async () => {
    const { control, trace, run } = setup([
      { calls: [{ name: 'set_status', args: { text: 'Reading' } }] },
      { text: 'Summary: read the document, next write the summary.' },
      { calls: [{ name: 'finish', args: { outcome: 'done' } }] },
    ]);
    control.inputTokens = 250_000;
    const result = await run();
    expect(result.reason).toBe('finished');
    const summaryCall = control.requests[1];
    expect(summaryCall?.purpose).toBe('compact');
    expect(summaryCall?.tools).toBeUndefined();
    expect(summaryCall?.contents).toHaveLength(1);
    expect(summaryCall?.contents[0]?.parts[0]?.text).toContain('[agent → set_status]');
    // The next step sees only the summary, not the old turns.
    const next = control.requests[2];
    expect(next?.contents[0]?.parts[0]?.text).toContain('This conversation was compacted');
    expect(next?.contents[0]?.parts[0]?.text).toContain('next write the summary');
    expect(next?.contents).toHaveLength(1);
    expect(trace.types()).toContain('compacted');
  });

  it('compacts on request from the heartbeat, below the threshold', async () => {
    const { control, run } = setup([
      { calls: [{ name: 'set_status', args: { text: 'Reading' } }] },
      { text: 'Summary of the work.' },
      { calls: [{ name: 'finish', args: { outcome: 'done' } }] },
    ]);
    const heartbeat = control.heartbeat.bind(control);
    control.heartbeat = async () => {
      const r = await heartbeat();
      return { ...r, compact: control.heartbeats === 2 };
    };
    const result = await run();
    expect(result.reason).toBe('finished');
    expect(control.requests[1]?.purpose).toBe('compact');
    expect(control.requests).toHaveLength(3);
  });

  it('keeps the conversation when the summary is empty and does not retry every step', async () => {
    const { control, run } = setup([
      { calls: [{ name: 'set_status', args: { text: 'Reading' } }] },
      { text: '' },
      { calls: [{ name: 'set_status', args: { text: 'Still going' } }] },
      { calls: [{ name: 'finish', args: { outcome: 'done' } }] },
    ]);
    control.inputTokens = 250_000;
    const result = await run();
    expect(result.reason).toBe('finished');
    expect(control.requests.filter((r) => r.purpose === 'compact')).toHaveLength(1);
    expect(control.requests[2]?.contents.length).toBeGreaterThan(1);
  });

  it('compacts a restored conversation that is already over the threshold', async () => {
    const { control, store, run } = setup([
      { text: 'Summary.' },
      { calls: [{ name: 'finish', args: { outcome: 'done' } }] },
    ]);
    store.messages.push({ author: 'user', body: 'Go on', createdAt: 1 });
    await run({
      trigger: 'comment',
      task: { ...store.task, context: { tokens: 300_000 } },
      session: [
        { role: 'user', parts: [{ text: 'Task' }] },
        { role: 'model', parts: [{ text: 'Working on it' }] },
      ],
    });
    expect(control.requests[0]?.purpose).toBe('compact');
    expect(control.requests[0]?.contents[0]?.parts[0]?.text).toContain('Go on');
  });
});

describe('holdTime', () => {
  it('holds the full time without a deadline', () => {
    expect(holdTime(600_000, undefined, 0)).toBe(600_000);
    expect(holdTime(undefined, 1e9, 0)).toBeUndefined();
  });

  it('cuts the hold to the time left before the deadline, minus the margin', () => {
    expect(holdTime(600_000, 10 * 60_000 + HOLD_DEADLINE_MARGIN_MS, 5 * 60_000)).toBe(300_000);
    expect(holdTime(600_000, 3_600_000, 0)).toBe(600_000);
  });

  it('does not hold when under a minute would be left', () => {
    expect(holdTime(600_000, HOLD_DEADLINE_MARGIN_MS + 30_000, 0)).toBeUndefined();
  });
});
