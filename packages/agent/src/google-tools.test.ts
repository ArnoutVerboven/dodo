import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GOOGLE_SCOPE, type GoogleOp } from '@dodo/core';
import { PolicyEngine } from '@dodo/policy';
import { describe, expect, it } from 'vitest';
import { googleTools } from './google-tools.js';
import { runAgent } from './loop.js';
import { FakeControlPlane, MemoryTaskStore, MemoryTrace, sampleTask } from './testing.js';
import { taskTools } from './tools.js';

const ALL = Object.values(GOOGLE_SCOPE);

async function setup(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
  respond: (c: GoogleOp) => Record<string, unknown>,
  opts: { scopes?: string[]; allow?: string[] } = {},
) {
  const control = new FakeControlPlane([
    ...calls.map((c) => ({ calls: [c] })),
    { calls: [{ name: 'finish', args: { outcome: 'done' } }] },
  ]);
  const store = new MemoryTaskStore(sampleTask());
  const trace = new MemoryTrace();
  const sent: GoogleOp[] = [];
  const workdir = await mkdtemp(path.join(os.tmpdir(), 'dodo-google-'));
  const tools = googleTools(
    async (c) => {
      sent.push(c);
      return respond(c);
    },
    { scopes: opts.scopes ?? ALL, folder: 'dodo', email: 'me@example.com' },
  );
  const run = () =>
    runAgent(
      {
        runId: 'r1',
        task: store.task,
        project: undefined,
        model: 'gemini-2.5-flash',
        trigger: 'new',
        session: [],
      },
      {
        control,
        store,
        trace,
        tools: [...taskTools, ...tools],
        policy: new PolicyEngine({ profile: 'agent-decides', allow: opts.allow ?? [], deny: [] }),
        workdir,
        heartbeatMs: 0,
      },
    );
  return { control, store, sent, run, tools, workdir };
}

describe('google tools', () => {
  it('searches Gmail without asking and says in the prompt what it has', async () => {
    const { control, sent, run } = await setup(
      [{ name: 'gmail_search', args: { query: 'from:derma' } }],
      () => ({ threads: [{ threadId: 't1', subject: 'Your appointment' }] }),
    );
    const result = await run();
    expect(result.reason).toBe('finished');
    expect(sent).toEqual([{ op: 'gmail_search', query: 'from:derma', max: 10 }]);
    const system = control.requests[0]?.systemInstruction ?? '';
    expect(JSON.stringify(system)).toContain('their \\"dodo\\" folder');
  });

  it('asks before adding a calendar event', async () => {
    const { control, sent, run } = await setup(
      [
        {
          name: 'calendar_create_event',
          args: { title: 'Dermatologist', start: '2026-11-03T10:00', end: '2026-11-03T10:30' },
        },
      ],
      () => ({ ok: true }),
    );
    const result = await run();
    expect(result.reason).toBe('waiting_input');
    expect(sent).toEqual([]);
    expect(control.inputRequests[0]?.suggestedRule).toBe('Calendar(create:Dermatologist)');
  });

  it('saves a task file to Drive and attaches the link', async () => {
    const { store, sent, run, workdir } = await setup(
      [{ name: 'drive_save_file', args: { path: 'report.md' } }],
      () => ({ ok: true, file: { name: 'report.md', url: 'https://drive.google.com/file/d/x' } }),
    );
    await writeFile(path.join(workdir, 'report.md'), '# Hi');
    await run();
    expect(sent[0]).toMatchObject({
      op: 'drive_save',
      name: 'report.md',
      mimeType: 'text/markdown',
      data: Buffer.from('# Hi').toString('base64'),
    });
    expect(store.artifacts[0]).toMatchObject({
      kind: 'link',
      url: 'https://drive.google.com/file/d/x',
    });
  });

  it('downloads into the task folder', async () => {
    const { run, workdir } = await setup(
      [
        {
          name: 'drive_download',
          args: { file: 'https://docs.google.com/document/d/abcdefghijk/edit' },
        },
      ],
      (c) => {
        expect(c).toEqual({
          op: 'drive_download',
          fileId: 'https://docs.google.com/document/d/abcdefghijk/edit',
        });
        return { name: 'notes.txt', data: Buffer.from('hello').toString('base64') };
      },
    );
    await run();
    expect(await readFile(path.join(workdir, 'notes.txt'), 'utf8')).toBe('hello');
  });

  it('asks before changing a Drive file, keyed by its id', async () => {
    const { control, run } = await setup(
      [
        {
          name: 'drive_update_file',
          args: { file: 'https://docs.google.com/document/d/abcdefghijk/edit', text: 'new' },
        },
      ],
      () => ({ ok: true }),
    );
    expect((await run()).reason).toBe('waiting_input');
    expect(control.inputRequests[0]?.suggestedRule).toBe('Drive(edit:abcdefghijk)');
  });

  it('leaves out the tools the connection has no scope for', async () => {
    const { tools } = await setup([], () => ({}), { scopes: [GOOGLE_SCOPE.gmailRead] });
    expect(tools.map((t) => t.name)).toEqual(['gmail_search', 'gmail_read_thread']);
  });
});
