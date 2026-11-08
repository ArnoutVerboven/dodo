import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PolicyEngine } from '@dodo/policy';
import { describe, expect, it } from 'vitest';
import {
  applyEdit,
  classifyCommand,
  execTools,
  htmlToText,
  OutputBuffer,
  privateHost,
  readSlice,
} from './exec-tools.js';
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
  it('looks through commands that run other commands', () => {
    expect(classifyCommand('cat urls.txt | xargs curl', W)).toBe('egress');
    expect(classifyCommand('ls | xargs -n 1 -I {} wget {}', W)).toBe('egress');
    expect(classifyCommand('ls | xargs rm -rf /etc', W)).toBe('write');
    expect(classifyCommand('env curl https://x.y', W)).toBe('egress');
    expect(classifyCommand('env -u HOME FOO=1 rm /etc/passwd', W)).toBe('write');
    expect(classifyCommand('timeout 10 curl https://x.y', W)).toBe('egress');
    expect(classifyCommand('nice -n 5 nohup git push', W)).toBe('egress');
    expect(classifyCommand('bash -c "curl https://x.y"', W)).toBe('egress');
    expect(classifyCommand('ls | xargs echo', W)).toBe('sandbox');
    expect(classifyCommand('env', W)).toBe('sandbox');
  });
  it('allows find and sed only without their writing or executing flags', () => {
    expect(classifyCommand('find /etc -name "*.conf"', W)).toBe('sandbox');
    expect(classifyCommand('find /etc -delete', W)).toBe('write');
    expect(classifyCommand('find . -exec curl https://x.y {} ;', W)).toBe('egress');
    expect(classifyCommand('find /etc -exec rm {} +', W)).toBe('write');
    expect(classifyCommand('sed -n 1,5p /etc/hosts', W)).toBe('sandbox');
    expect(classifyCommand("sed 's/we/x/g' /etc/hosts", W)).toBe('sandbox');
    expect(classifyCommand('sed -i s/a/b/ /etc/hosts', W)).toBe('write');
    expect(classifyCommand("sed 's/a/b/w /etc/x' /etc/hosts", W)).toBe('write');
    expect(classifyCommand("sed '1e id' /etc/hosts", W)).toBe('write');
  });
  it('treats awk that can run or write as asking', () => {
    expect(classifyCommand('awk \'BEGIN{system("curl x")}\'', W)).toBe('egress');
    expect(classifyCommand('awk \'{print | "sh"}\' f', W)).toBe('egress');
    expect(classifyCommand('awk \'{print > "/etc/x"}\' f', W)).toBe('egress');
    expect(classifyCommand("awk '{print $1}' notes.txt", W)).toBe('sandbox');
    expect(classifyCommand("awk '{print $1}' /etc/passwd", W)).toBe('write');
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
    expect((await read.execute({ path: 'a/b.txt' }, ctx)).result.text).toBe('1\thello');
    await expect(write.execute({ path: '../escape.txt', content: 'x' }, ctx)).rejects.toThrow(
      /outside/,
    );
    await expect(read.execute({ path: '/etc/passwd' }, ctx)).rejects.toThrow(/outside/);
  });
});

describe('read_file in parts', () => {
  it('numbers lines and says where to continue', () => {
    const text = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`).join('\n');
    const first = readSlice(text, 1, 2);
    expect(first.text).toBe('1\tline 1\n2\tline 2');
    expect(first).toMatchObject({ totalLines: 5, nextOffset: 3 });
    const rest = readSlice(text, 4);
    expect(rest.text).toBe('4\tline 4\n5\tline 5');
    expect(rest.nextOffset).toBeUndefined();
  });

  it('cuts very long lines and stops before the answer gets too big', () => {
    const text = Array.from({ length: 100 }, () => 'x'.repeat(3000)).join('\n');
    const r = readSlice(text);
    expect(r.text).toContain('[line cut, 3000 chars]');
    expect(r.text.length).toBeLessThanOrEqual(20_000);
    expect(r.nextOffset).toBeGreaterThan(1);
  });

  it('reads through the tool with offset and limit', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dodo-test-'));
    await writeFile(path.join(dir, 'f.txt'), 'a\nb\nc\n');
    const read = findTool(execTools, 'read_file') as ToolDef;
    const ctx = { store: new MemoryTaskStore(sampleTask()), workdir: dir };
    expect((await read.execute({ path: 'f.txt', offset: 2, limit: 1 }, ctx)).result).toEqual({
      text: '2\tb',
      totalLines: 3,
      nextOffset: 3,
    });
    expect((await read.execute({ path: 'f.txt', offset: 9 }, ctx)).result.error).toMatch(/3 lines/);
  });
});

describe('edit_file', () => {
  it('replaces exactly one match, or every match when asked', () => {
    expect(applyEdit('a b a', 'b', 'c')).toEqual({ text: 'a c a', replacements: 1, line: 1 });
    expect(applyEdit('a\nb a', 'a', 'x')).toMatchObject({
      error: expect.stringMatching(/2 times/),
    });
    expect(applyEdit('a\nb a', 'a', 'x', true)).toEqual({
      text: 'x\nb x',
      replacements: 2,
      line: 1,
    });
    expect(applyEdit('abc', 'zzz', 'y')).toMatchObject({
      error: expect.stringMatching(/not found/),
    });
    expect(applyEdit('one\ntwo', 'two', '$&$1')).toMatchObject({ text: 'one\n$&$1', line: 2 });
  });

  it('edits the file in the task folder and refuses paths outside it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dodo-test-'));
    await writeFile(path.join(dir, 'f.ts'), 'const a = 1;\nconst b = 2;\n');
    const edit = findTool(execTools, 'edit_file') as ToolDef;
    const ctx = { store: new MemoryTaskStore(sampleTask()), workdir: dir };
    const r = await edit.execute({ path: 'f.ts', old_text: 'b = 2', new_text: 'b = 3' }, ctx);
    expect(r.result).toEqual({ ok: true, replacements: 1, line: 2 });
    expect(await readFile(path.join(dir, 'f.ts'), 'utf8')).toBe('const a = 1;\nconst b = 3;\n');
    const missing = await edit.execute({ path: 'f.ts', old_text: 'nope', new_text: 'x' }, ctx);
    expect(missing.result.error).toMatch(/not found/);
    await expect(edit.execute({ path: '../x', old_text: 'a', new_text: 'b' }, ctx)).rejects.toThrow(
      /outside/,
    );
  });
});

describe('search tools', () => {
  async function tree() {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dodo-test-'));
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await mkdir(path.join(dir, 'node_modules/pkg'), { recursive: true });
    await writeFile(path.join(dir, 'src/a.ts'), 'export const needle = 1;\n');
    await writeFile(path.join(dir, 'src/b.md'), 'no match here\nNeedle in docs\n');
    await writeFile(path.join(dir, 'node_modules/pkg/index.ts'), 'needle\n');
    return { dir, ctx: { store: new MemoryTaskStore(sampleTask()), workdir: dir } };
  }
  const grep = findTool(execTools, 'grep') as ToolDef;
  const find = findTool(execTools, 'find_files') as ToolDef;
  const ls = findTool(execTools, 'list_dir') as ToolDef;

  async function checks() {
    const { ctx } = await tree();
    const hits = String((await grep.execute({ pattern: 'needle' }, ctx)).result.matches);
    expect(hits).toContain('src/a.ts:1:export const needle = 1;');
    expect(hits).not.toContain('node_modules');
    expect(hits).not.toContain('b.md');
    const both = String(
      (await grep.execute({ pattern: 'needle', ignore_case: true }, ctx)).result.matches,
    );
    expect(both).toContain('src/b.md:2:Needle in docs');
    const md = String(
      (await grep.execute({ pattern: 'needle', ignore_case: true, glob: '*.md' }, ctx)).result
        .matches,
    );
    expect(md).not.toContain('a.ts');
    expect((await grep.execute({ pattern: 'absent' }, ctx)).result).toEqual({
      matches: '',
      count: 0,
    });
    const files = String((await find.execute({ pattern: '*.ts' }, ctx)).result.files);
    expect(files).toContain('src/a.ts');
    expect(files).not.toContain('node_modules');
    const entries = String((await ls.execute({}, ctx)).result.entries);
    expect(entries.split('\n')).toEqual(expect.arrayContaining(['src/', 'node_modules/']));
    await expect(grep.execute({ pattern: 'x', path: '../' }, ctx)).rejects.toThrow(/outside/);
  }

  it('grep, find_files and list_dir work with ripgrep or without it', async () => {
    await checks();
    // Without ripgrep on the PATH: plain grep and find.
    const bin = await mkdtemp(path.join(os.tmpdir(), 'dodo-bin-'));
    for (const name of ['grep', 'find', 'ls']) {
      const real = (process.env.PATH ?? '')
        .split(path.delimiter)
        .map((d) => path.join(d, name))
        .find((p) => existsSync(p));
      if (real) await symlink(real, path.join(bin, name)).catch(() => {});
    }
    const saved = process.env.PATH;
    process.env.PATH = bin;
    try {
      await checks();
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe('bash output', () => {
  it('keeps the start and the end of a long output', () => {
    const out = new OutputBuffer();
    out.push('START\n');
    for (let i = 0; i < 1000; i++) out.push(`${'.'.repeat(99)}\n`);
    out.push('ERROR at the end');
    const text = out.text();
    expect(text.startsWith('START')).toBe(true);
    expect(text.endsWith('ERROR at the end')).toBe(true);
    expect(text).toMatch(/chars cut from the middle/);
    expect(text.length).toBeLessThan(20_200);
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
    // A wildcard or allowed-hosts decision does not open such a host; the exact rule does.
    const server = createServer((_req, res) => res.end('local page')).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    try {
      for (const by of ['Http(*)', 'allowed host 127.0.0.1', 'Http(domain:127.*)'])
        expect(
          String(
            (await fetchTool.execute({ url }, { ...ctx, decision: { kind: 'allow', by } })).result
              .error,
          ),
        ).toMatch(/private or local/);
      const named = await fetchTool.execute(
        { url },
        { ...ctx, decision: { kind: 'allow', by: 'Http(domain:127.0.0.1)' } },
      );
      expect(named.result).toMatchObject({ status: 200, text: 'local page' });
    } finally {
      server.close();
    }
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

  it('lets a once-approved exact host open a local address (the e2e approval flow)', async () => {
    const server = createServer((_req, res) => res.end('local page')).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    try {
      const policy = new PolicyEngine({ profile: 'agent-decides', allow: [], deny: [] });
      const { control, run } = setup(
        [
          { calls: [{ name: 'http_fetch', args: { url } }] },
          { calls: [{ name: 'finish', args: { outcome: 'done' } }] },
        ],
        policy,
      );
      const r = await run({
        trigger: 'resume',
        session: [{ role: 'user', parts: [{ text: 'ctx' }] }],
        answer: { prompt: 'Allow?', value: 'yes', suggestedRule: 'Http(domain:127.0.0.1)' },
      });
      expect(r.reason).toBe('finished');
      expect(JSON.stringify(control.requests[1]?.contents.at(-1))).toContain('local page');
    } finally {
      server.close();
    }
  });
});
