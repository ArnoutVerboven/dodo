import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  execTools,
  FakeControlPlane,
  GatewayBudgetError,
  GatewayRateLimitError,
  MemoryTaskStore,
  MemoryTrace,
  type ScriptedTurn,
  sampleTask,
  taskTools,
} from '@dodo/agent';
import type { Content } from '@dodo/core';
import { PolicyEngine } from '@dodo/policy';
import { describe, expect, it } from 'vitest';
import { endForModelError, piHarness, toGeminiContents, toPiMessages } from './index.js';

async function setup(
  script: ScriptedTurn[],
  session: Content[] = [],
  trigger: 'new' | 'resume' = 'new',
) {
  const workdir = await mkdtemp(path.join(os.tmpdir(), 'pi-test-'));
  const control = new FakeControlPlane(script);
  const store = new MemoryTaskStore(sampleTask());
  const trace = new MemoryTrace();
  const run = (answer?: { value: string; prompt: string }) =>
    piHarness.run(
      {
        runId: 'r1',
        task: store.task,
        project: undefined,
        model: 'gemini-3.8-flash',
        trigger,
        session,
        ...(answer ? { answer } : {}),
      },
      {
        control,
        store,
        trace,
        tools: [...taskTools, ...execTools],
        policy: new PolicyEngine({
          profile: 'agent-decides',
          allow: [],
          deny: ['Bash(git push:*)'],
        }),
        workdir,
        heartbeatMs: 0,
      },
    );
  return { workdir, control, store, trace, run };
}

const finish = { calls: [{ name: 'finish', args: { outcome: 'done' } }] };

describe('pi harness', () => {
  it('offers pi’s own file tools instead of dodo’s, and the rest of dodo’s tools', async () => {
    const { control, run } = await setup([finish]);
    await run();
    const names = (control.requests[0]?.tools ?? []).map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['read', 'edit', 'write', 'bash', 'finish', 'grep']),
    );
    expect(names).not.toContain('read_file');
    expect(control.requests[0]?.systemInstruction).toContain('Files and shell');
  });

  it('runs bash and the file tools in the task folder', async () => {
    const { workdir, control, run } = await setup([
      { calls: [{ name: 'bash', args: { command: 'echo hello-from-pi' } }] },
      { calls: [{ name: 'write', args: { path: 'notes.md', content: 'one\ntwo\n' } }] },
      {
        calls: [
          {
            name: 'edit',
            args: { path: 'notes.md', edits: [{ oldText: 'two', newText: 'three' }] },
          },
        ],
      },
      { calls: [{ name: 'read', args: { path: 'notes.md' } }] },
      finish,
    ]);
    const r = await run();
    expect(r.reason).toBe('finished');
    expect(JSON.stringify(control.requests[1])).toContain('hello-from-pi');
    expect(await readFile(path.join(workdir, 'notes.md'), 'utf8')).toBe('one\nthree\n');
    expect(JSON.stringify(control.requests[4])).toContain('three');
  });

  it('keeps the file tools inside the task folder', async () => {
    const outside = path.join(await mkdtemp(path.join(os.tmpdir(), 'pi-out-')), 'secret.txt');
    await writeFile(outside, 'do-not-read');
    const { control, run } = await setup([
      { calls: [{ name: 'read', args: { path: outside } }] },
      finish,
    ]);
    await run();
    const next = JSON.stringify(control.requests[1]);
    expect(next).not.toContain('do-not-read');
    expect(next).toContain('outside the task folder');
  });

  it('pauses for approval on a call the policy asks about, with the session to resume', async () => {
    const { control, run } = await setup([
      { calls: [{ name: 'bash', args: { command: 'curl https://example.com' } }] },
    ]);
    const r = await run();
    expect(r.reason).toBe('waiting_input');
    expect(control.inputRequests[0]).toMatchObject({ kind: 'approval' });
    expect(control.inputRequests[0]?.session.length).toBeGreaterThan(1);
  });

  it('resumes a stored conversation with the answer', async () => {
    const stored: Content[] = [
      { role: 'user', parts: [{ text: 'Book the table' }] },
      {
        role: 'model',
        parts: [{ functionCall: { name: 'ask_user', args: { kind: 'text', prompt: 'When?' } } }],
      },
      { role: 'user', parts: [{ functionResponse: { name: 'ask_user', response: { ok: true } } }] },
    ];
    const { control, run } = await setup([finish], stored, 'resume');
    await run({ value: '8pm', prompt: 'When?' });
    const sent = JSON.stringify(control.requests[0]?.contents);
    expect(sent).toContain('Book the table');
    expect(sent).toContain('8pm');
  });

  it('nudges a text-only reply once, then stops for review with the text posted', async () => {
    const { control, store, run } = await setup([
      { text: 'I think it is done.' },
      { text: 'Really done.' },
    ]);
    const r = await run();
    expect(r.reason).toBe('finished');
    expect(control.finishes[0]?.outcome).toBe('review');
    expect(store.messages.at(-1)?.body).toBe('Really done.');
  });

  it('ends on the gateway’s refusals the way dodo’s loop does', async () => {
    const budget = await setup([
      { error: new GatewayBudgetError("budget_exhausted(task): the task's budget has €0.00 left") },
    ]);
    expect((await budget.run()).reason).toBe('budget_exhausted');
    expect(budget.control.finishes[0]?.error).toMatch(/^budget_exhausted\(task\)/);
    const rate = await setup([{ error: new GatewayRateLimitError('the hourly cap is reached') }]);
    expect((await rate.run()).reason).toBe('error');
    expect(rate.control.finishes[0]?.error).toBe('the hourly cap is reached');
  });
});

describe('endForModelError', () => {
  it('reads the Gemini error body', () => {
    const body = (status: string, message: string) =>
      JSON.stringify({ error: { code: 1, status, message } });
    expect(endForModelError(body('UNAVAILABLE', 'halted')).reason).toBe('halted');
    expect(endForModelError(body('FAILED_PRECONDITION', 'lease_lost')).reason).toBe('lease_lost');
    expect(endForModelError('socket hang up')).toEqual({
      reason: 'error',
      error: 'socket hang up',
    });
  });
});

describe('session conversion', () => {
  it('round-trips Gemini contents through pi messages', () => {
    const contents: Content[] = [
      { role: 'user', parts: [{ text: 'Do it' }] },
      {
        role: 'model',
        parts: [
          { text: 'thinking…', thought: true, thoughtSignature: 'sig1' },
          {
            functionCall: { id: 'c1', name: 'set_status', args: { text: 'x' } },
            thoughtSignature: 'sig2',
          },
        ],
      },
      {
        role: 'user',
        parts: [{ functionResponse: { id: 'c1', name: 'set_status', response: { ok: true } } }],
      },
      { role: 'model', parts: [{ text: 'Done.' }] },
    ];
    expect(toGeminiContents(toPiMessages(contents, 'm'))).toEqual(contents);
  });

  it('gives calls without ids one, and matches their responses', () => {
    const msgs = toPiMessages(
      [
        {
          role: 'model',
          parts: [
            { functionCall: { name: 'a', args: {} } },
            { functionCall: { name: 'b', args: {} } },
          ],
        },
        {
          role: 'user',
          parts: [
            { functionResponse: { name: 'b', response: {} } },
            { functionResponse: { name: 'a', response: {} } },
          ],
        },
      ],
      'm',
    );
    const ids = (msgs[0] as { content: Array<{ id: string }> }).content.map((c) => c.id);
    expect(msgs.slice(1).map((m) => (m as { toolCallId: string }).toolCallId)).toEqual([
      ids[1],
      ids[0],
    ]);
  });
});
