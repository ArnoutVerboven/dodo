import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PolicyEngine } from '@dodo/policy';
import { describe, expect, it } from 'vitest';
import { classifyCommand, execTools, htmlToText, privateHost } from './exec-tools.js';
import { runAgent } from './loop.js';
import { FakeControlPlane, MemoryTaskStore, MemoryTrace, sampleTask } from './testing.js';
import { findTool, type ToolDef, taskTools } from './tools.js';

const W = '/work/task';

describe('classifyCommand', () => {
  it('treats read-only commands in the folder as sandbox', () => {
    expect(classifyCommand('ls -la', W)).toBe('sandbox');
    expect(classifyCommand('cat notes.md | grep todo', W)).toBe('sandbox');
    expect(classifyCommand('node script.js > out.txt', W)).toBe('sandbox');
  });
  it('flags network tools and subcommands as egress', () => {
    expect(classifyCommand('curl https://x.y', W)).toBe('egress');
    expect(classifyCommand('git push origin main', W)).toBe('egress');
    expect(classifyCommand('ls && npm install', W)).toBe('egress');
    expect(classifyCommand('git status', W)).toBe('sandbox');
  });
  it('flags paths outside the folder as writes', () => {
    expect(classifyCommand('rm -rf /etc/passwd', W)).toBe('write');
    expect(classifyCommand('cp a.txt ../other/', W)).toBe('write');
    expect(classifyCommand('echo hi > /tmp/x', W)).toBe('write');
    expect(classifyCommand('cat /etc/hostname', W)).toBe('sandbox');
  });
});

describe('file tools', () => {
  it('stay inside the task folder', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dodo-test-'));
    const write = findTool(execTools, 'write_file') as ToolDef;
    const read = findTool(execTools, 'read_file') as ToolDef;
    const ctx = { store: new MemoryTaskStore(sampleTask()), workdir: dir };
    await write.execute({ path: 'a/b.txt', content: 'hello' }, ctx);
    expect(await readFile(path.join(dir, 'a/b.txt'), 'utf8')).toBe('hello');
    expect((await read.execute({ path: 'a/b.txt' }, ctx)).result.text).toBe('hello');
    await expect(write.execute({ path: '../escape.txt', content: 'x' }, ctx)).rejects.toThrow(
      /outside/,
    );
    await expect(read.execute({ path: '/etc/passwd' }, ctx)).rejects.toThrow(/outside/);
  });
});

describe('http_fetch', () => {
  it('never reaches the machine, the private network or the metadata server', () => {
    for (const h of [
      'localhost',
      'LOCALHOST',
      'app.localhost',
      'localhost.',
      '127.0.0.1',
      '127.9.9.9',
      '0.0.0.0',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '[::1]',
      '::',
      '[::ffff:127.0.0.1]',
      '[::ffff:10.0.0.1]',
      'fd12::1',
      '[fe80::1]',
      'metadata.google.internal',
      'db.c.project.internal',
      'printer.local',
      '2130706433',
      '0x7f000001',
    ])
      expect(privateHost(h), h).toBe(true);
    for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '[2606:4700::1111]', '100.128.0.1'])
      expect(privateHost(h), h).toBe(false);
  });
  it('refuses such a URL and a non-http scheme before any request', async () => {
    const fetchTool = findTool(execTools, 'http_fetch') as ToolDef;
    const ctx = { store: new MemoryTaskStore(sampleTask()) };
    const metadata = await fetchTool.execute(
      { url: 'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/' },
      ctx,
    );
    expect(String(metadata.result.error)).toMatch(/private or local/);
    const local = await fetchTool.execute({ url: 'http://localhost:8080/' }, ctx);
    expect(String(local.result.error)).toMatch(/private or local/);
    const file = await fetchTool.execute({ url: 'file:///etc/passwd' }, ctx);
    expect(String(file.result.error)).toMatch(/Only http/);
  });
});

describe('bash tool', () => {
  it('runs in the folder with a timeout and captures output', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dodo-test-'));
    const bash = findTool(execTools, 'bash') as ToolDef;
    const ctx = { store: new MemoryTaskStore(sampleTask()), workdir: dir };
    const r = await bash.execute({ command: 'echo hi; pwd; exit 3' }, ctx);
    expect(r.result.exitCode).toBe(3);
    expect(String(r.result.output)).toContain('hi');
    expect(String(r.result.output)).toContain(dir);
  });
});

describe('htmlToText', () => {
  it('strips tags and scripts', () => {
    expect(htmlToText('<html><script>x()</script><h1>Hi</h1><p>there &amp; you</p></html>')).toBe(
      'Hi\nthere & you',
    );
  });
});

describe('policy in the loop', () => {
  const tools = [...taskTools, ...execTools];
  const setup = (
    script: ConstructorParameters<typeof FakeControlPlane>[0],
    policy: PolicyEngine,
  ) => {
    const control = new FakeControlPlane(script);
    const store = new MemoryTaskStore(sampleTask());
    const trace = new MemoryTrace();
    const run = (extra: Partial<Parameters<typeof runAgent>[0]> = {}) =>
      runAgent(
        {
          runId: 'r1',
          task: store.task,
          project: undefined,
          model: 'm',
          trigger: 'new',
          session: [],
          ...extra,
        },
        { control, store, trace, tools, policy, heartbeatMs: 0, workdir: os.tmpdir() },
      );
    return { control, store, trace, run };
  };

  it('turns an "ask" decision into an approval request and ends the run', async () => {
    const { control, run } = setup(
      [{ calls: [{ name: 'http_fetch', args: { url: 'https://example.com/x' } }] }],
      new PolicyEngine({ profile: 'agent-decides', allow: [], deny: [] }),
    );
    const r = await run();
    expect(r.reason).toBe('waiting_input');
    expect(control.inputRequests[0]).toMatchObject({
      kind: 'approval',
      suggestedRule: 'Http(domain:example.com)',
    });
  });

  it('denies by rule and tells the model', async () => {
    const { control, run } = setup(
      [
        { calls: [{ name: 'bash', args: { command: 'git push origin main' } }] },
        { calls: [{ name: 'finish', args: { outcome: 'blocked' } }] },
      ],
      new PolicyEngine({ profile: 'agent-decides', allow: [], deny: ['Bash(git push:*)'] }),
    );
    await run();
    const fr = control.requests[1]?.contents.at(-1)?.parts[0]?.functionResponse?.response;
    expect(JSON.stringify(fr)).toContain('Not allowed');
  });

  it('runs sandbox commands without asking', async () => {
    const { control, run } = setup(
      [
        { calls: [{ name: 'bash', args: { command: 'echo sandboxed' } }] },
        { calls: [{ name: 'finish', args: { outcome: 'done' } }] },
      ],
      new PolicyEngine({ profile: 'agent-decides', allow: [], deny: [] }),
    );
    expect((await run()).reason).toBe('finished');
    expect(JSON.stringify(control.requests[1]?.contents.at(-1))).toContain('sandboxed');
  });

  it('honours a one-time approval on resume', async () => {
    const policy = new PolicyEngine({ profile: 'agent-decides', allow: [], deny: [] });
    const { control, run } = setup(
      [
        { calls: [{ name: 'bash', args: { command: 'echo hi > /tmp/dodo-approved-once' } }] },
        { calls: [{ name: 'finish', args: { outcome: 'done' } }] },
      ],
      policy,
    );
    const r = await run({
      trigger: 'resume',
      session: [{ role: 'user', parts: [{ text: 'ctx' }] }],
      answer: {
        prompt: 'Allow?',
        value: 'yes',
        suggestedRule: 'Bash(echo hi > /tmp/dodo-approved-once)',
      },
    });
    expect(r.reason).toBe('finished');
    expect(control.inputRequests).toHaveLength(0);
  });
});
