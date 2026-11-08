import os from 'node:os';
import { AGENT_SYSTEM } from '@dodo/core';
import { PolicyEngine } from '@dodo/policy';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { GatewayBudgetError } from './control-plane.js';
import { execTools } from './exec-tools.js';
import { HARNESSES } from './harness.js';
import { systemPrompt } from './prompt.js';
import type { SecretResolver } from './secrets.js';
import { FakeControlPlane, MemoryTaskStore, MemoryTrace, sampleTask } from './testing.js';
import { define, type ToolDef, taskTools } from './tools.js';

/**
 * What every harness must do, whatever loop it runs (see the harness spec): model calls only
 * through the control plane, every tool through the policy, vault values never back to the
 * model or the trace, and the task contract's run endings.
 */

const SECRET = 'hunter2-very-secret';
const secrets = {
  resolve: async (t: string) => t,
  redact: (t: string) => t.split(SECRET).join('{{secret:bank.password}}'),
  keep: () => '',
} as unknown as SecretResolver;

let leaks = 0;
const leakyTool = define({
  name: 'read_bank_page',
  description: 'Test tool whose result contains a vault value.',
  schema: z.object({}),
  async execute() {
    return { result: { page: `Welcome! Your password is ${SECRET}.` } };
  },
});
const paidTool = define({
  name: 'paid_lookup',
  description: 'Test tool the budget refuses.',
  schema: z.object({}),
  async execute(): Promise<never> {
    throw new GatewayBudgetError('Task budget exhausted');
  },
});
const pushTool: ToolDef = {
  ...(execTools.find((t) => t.name === 'bash') as ToolDef),
  async execute() {
    leaks++;
    return { result: { ran: true } };
  },
};

describe.each(HARNESSES)('harness $id', (harness) => {
  const setup = (script: ConstructorParameters<typeof FakeControlPlane>[0]) => {
    const control = new FakeControlPlane(script);
    const store = new MemoryTaskStore(sampleTask());
    const trace = new MemoryTrace();
    const run = () =>
      harness.run(
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
          trace,
          tools: [...taskTools, leakyTool, paidTool, pushTool],
          policy: new PolicyEngine({
            profile: 'agent-decides',
            allow: [],
            deny: ['Bash(git push:*)'],
          }),
          secrets,
          workdir: os.tmpdir(),
          heartbeatMs: 0,
        },
      );
    return { control, store, trace, run };
  };

  it('makes every model call through the control plane and ends on finish', async () => {
    const { control, run } = setup([
      { calls: [{ name: 'set_status', args: { text: 'Working' } }] },
      { calls: [{ name: 'finish', args: { outcome: 'done' } }] },
    ]);
    const r = await run();
    expect(r.reason).toBe('finished');
    expect(control.requests).toHaveLength(2);
    expect(control.finishes[0]).toMatchObject({ reason: 'finished', outcome: 'done' });
  });

  it('never runs a call the policy denies', async () => {
    leaks = 0;
    const { run } = setup([
      { calls: [{ name: 'bash', args: { command: 'git push origin main' } }] },
      { calls: [{ name: 'finish', args: { outcome: 'blocked' } }] },
    ]);
    await run();
    expect(leaks).toBe(0);
  });

  it('keeps vault values out of the next model call and the trace', async () => {
    const { control, trace, run } = setup([
      { calls: [{ name: 'read_bank_page', args: {} }] },
      { calls: [{ name: 'finish', args: { outcome: 'done' } }] },
    ]);
    await run();
    expect(JSON.stringify(control.requests[1])).not.toContain(SECRET);
    expect(JSON.stringify(control.requests[1])).toContain('{{secret:bank.password}}');
    expect(JSON.stringify(trace.events)).not.toContain(SECRET);
  });

  it('ends on ask_user waiting for the answer, with a resumable session', async () => {
    const { control, run } = setup([
      { calls: [{ name: 'ask_user', args: { kind: 'text', prompt: 'Which account?' } }] },
    ]);
    const r = await run();
    expect(r.reason).toBe('waiting_input');
    expect(control.inputRequests[0]).toMatchObject({ prompt: 'Which account?' });
    expect(control.inputRequests[0]?.session.length).toBeGreaterThan(1);
  });

  it('ends as budget_exhausted when the budget refuses a paid tool', async () => {
    const { control, run } = setup([{ calls: [{ name: 'paid_lookup', args: {} }] }]);
    const r = await run();
    expect(r.reason).toBe('budget_exhausted');
    expect(control.finishes[0]?.reason).toBe('budget_exhausted');
  });

  it('stops when the run is interrupted, and steers with comments', async () => {
    const { control, trace, run } = setup([
      { calls: [{ name: 'set_status', args: { text: 'Working' } }] },
      { calls: [{ name: 'finish', args: { outcome: 'done' } }] },
    ]);
    control.flags = { pendingMessages: [{ id: 'm1', body: 'Use the EU site', createdAt: 0 }] };
    await run();
    expect(trace.types()).toContain('steer');
    expect(JSON.stringify(control.requests[0])).toContain('Use the EU site');

    const stopped = setup([{ calls: [{ name: 'set_status', args: { text: 'x' } }] }]);
    stopped.control.flags = { ok: false, reason: 'interrupted' };
    expect((await stopped.run()).reason).toBe('interrupted');
  });
});

describe('system prompt layers', () => {
  it('adds a harness section after the tool sections and before the project', () => {
    const project = {
      id: 'p',
      name: 'Home',
      description: '',
      instructions: 'Be brief.',
    } as unknown as Parameters<typeof systemPrompt>[1];
    const text = systemPrompt(sampleTask(), project, {
      notion: {},
      harness: 'HARNESS SECTION',
    });
    expect(text.startsWith(AGENT_SYSTEM)).toBe(true);
    const at = text.indexOf('HARNESS SECTION');
    expect(at).toBeGreaterThan(text.indexOf('Notion'));
    expect(at).toBeLessThan(text.indexOf('Be brief.'));
    expect(systemPrompt(sampleTask(), undefined, {})).toBe(AGENT_SYSTEM);
  });
});
