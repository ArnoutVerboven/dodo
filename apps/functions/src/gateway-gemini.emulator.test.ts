import { randomUUID } from 'node:crypto';
import { paths, type Run } from '@dodo/core';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_HOURLY_CAP } from './gateway.js';
import { type GeminiHttpResponse, handleGeminiRequest } from './gateway-gemini.js';
import { FakeProvider } from './model-provider.js';
import { costGateFor, scopesForRun } from './runtime.js';

const enabled = !!process.env.FIRESTORE_EMULATOR_HOST;
const app = enabled ? initializeApp({ projectId: 'demo-dodo' }, 'gateway-gemini-test') : undefined;
const db = app ? getFirestore(app) : undefined;

function recorder() {
  const out = { status: 0, headers: {} as Record<string, string>, body: '' };
  const res: GeminiHttpResponse = {
    headersSent: false,
    status(code) {
      out.status = code;
      return res;
    },
    setHeader(name, value) {
      out.headers[name] = value;
      return res;
    },
    write(chunk) {
      res.headersSent = true;
      out.body += chunk;
    },
    end(chunk) {
      res.headersSent = true;
      if (chunk) out.body += chunk;
    },
  };
  return { res, out };
}

const events = (body: string) =>
  body
    .split('\r\n\r\n')
    .filter((e) => e.startsWith('data: '))
    .map((e) => JSON.parse(e.slice(6)));

describe.skipIf(!enabled)('gatewayGemini', () => {
  afterAll(async () => {
    if (app) await deleteApp(app);
  });

  async function seed(taskBudget?: number): Promise<Run> {
    const d = db as NonNullable<typeof db>;
    const taskId = `t-${randomUUID()}`;
    const runId = `r-${randomUUID()}`;
    await d.doc(paths.task(taskId)).set({
      title: 'Stream me',
      status: 'in_progress',
      ai: { enabled: true, ...(taskBudget !== undefined ? { budget: taskBudget } : {}) },
      createdAt: 1,
      updatedAt: 1,
    });
    const run = {
      taskId,
      device: 'gcp',
      model: 'gemini-3.8-flash',
      state: 'running' as const,
      trigger: 'new' as const,
      generation: 1,
      interrupt: false,
      compact: false,
      attempts: 1,
      spent: 0,
      steps: 0,
      lease: { owner: 'run:x', expiresAt: Date.now() + 3_600_000 },
      createdAt: 1,
      updatedAt: 1,
    };
    await d.doc(paths.run(runId)).set(run);
    return { id: runId, ...run } as Run;
  }

  const call = async (run: Run, headers: Record<string, string> = {}, path?: string) => {
    const d = db as NonNullable<typeof db>;
    const { res, out } = recorder();
    const all: Record<string, string> = { 'x-goog-api-key': 'tok', ...headers };
    await handleGeminiRequest(
      {
        gateway: {
          db: d,
          costGate: costGateFor(d),
          provider: new FakeProvider(),
          hourlyCap: DEFAULT_HOURLY_CAP,
        },
        verifyToken: async () => ({ uid: `run:${run.id}`, claims: { run: run.id } }),
        loadRun: async () => run,
        context: (r, model) => ({
          scopes: scopesForRun(r),
          taskId: r.taskId,
          runId: r.id,
          description: `model call (${model})`,
        }),
      },
      {
        method: 'POST',
        path: path ?? '/v1beta/models/gemini-3.8-flash:streamGenerateContent',
        header: (n) => all[n.toLowerCase()],
        body: {
          contents: [{ role: 'user', parts: [{ text: 'Do the task' }] }],
          systemInstruction: { parts: [{ text: 'You are dodo.' }] },
          tools: [
            {
              functionDeclarations: [
                { name: 'set_status', description: 'Status', parametersJsonSchema: {} },
              ],
            },
          ],
        },
      },
      res,
    );
    return out;
  };

  it('streams Gemini chunks and charges the run, the task and the budget', async () => {
    const d = db as NonNullable<typeof db>;
    const run = await seed();
    const out = await call(run);
    expect(out.status).toBe(200);
    expect(out.headers['content-type']).toBe('text/event-stream');
    const chunks = events(out.body);
    expect(chunks[0].candidates[0].content.parts[0].functionCall.name).toBe('set_status');
    expect(chunks.at(-1).usageMetadata.promptTokenCount).toBeGreaterThan(0);

    const after = (await d.doc(paths.run(run.id)).get()).data();
    expect(after?.spent).toBeGreaterThan(0);
    expect(after?.steps).toBe(1);
    const task = (await d.doc(paths.task(run.taskId)).get()).data();
    expect(task?.context?.tokens).toBeGreaterThan(0);
    const budget = (await d.doc(`budgets/task_${run.taskId}`).get()).data();
    expect(budget?.spent).toBe(after?.spent);
    expect(budget?.reserved ?? 0).toBe(0);
  });

  it('marks a compaction call instead of measuring the conversation', async () => {
    const d = db as NonNullable<typeof db>;
    const run = await seed();
    await call(run, { 'x-dodo-purpose': 'compact' });
    const task = (await d.doc(paths.task(run.taskId)).get()).data();
    expect(task?.context?.compactedAt).toBeGreaterThan(0);
    expect(task?.context?.tokens).toBeUndefined();
  });

  it('answers a non-streaming call in Gemini form', async () => {
    const run = await seed();
    const out = await call(run, {}, '/v1beta/models/gemini-3.8-flash:generateContent');
    expect(out.status).toBe(200);
    const r = JSON.parse(out.body);
    expect(r.candidates[0].content.role).toBe('model');
    expect(r.usageMetadata.totalTokenCount).toBeGreaterThan(0);
  });

  it("refuses with 429 and the budget message when the task's budget is out", async () => {
    const run = await seed(1);
    const out = await call(run);
    expect(out.status).toBe(429);
    const err = JSON.parse(out.body).error;
    expect(err.status).toBe('RESOURCE_EXHAUSTED');
    expect(err.message).toMatch(/^budget_exhausted\(task\)/);
  });
});
