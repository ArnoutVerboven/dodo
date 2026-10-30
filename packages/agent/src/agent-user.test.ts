import { chmod, mkdtemp, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentUser, prepareDir } from './agent-user.js';
import type { TaskStore } from './control-plane.js';
import { execTools } from './exec-tools.js';

const isRoot = process.getuid?.() === 0;
const UID = 54_321;

describe('agentUser', () => {
  it('is off unless configured, and refuses a setting it cannot honour', () => {
    expect(agentUser({})).toBeUndefined();
    expect(() => agentUser({ DODO_AGENT_UID: 'abc' })).toThrow('positive integers');
    if (!isRoot) expect(() => agentUser({ DODO_AGENT_UID: '1000' })).toThrow('not running as root');
  });
});

// The cloud worker's split: it runs as root with the run's credential; the agent does not.
describe.skipIf(!isRoot)('agent commands as their own user', () => {
  afterEach(() => {
    delete process.env.DODO_AGENT_UID;
    delete process.env.DODO_AGENT_GID;
  });

  const tool = (name: string) => {
    const t = execTools.find((x) => x.name === name);
    if (!t) throw new Error(name);
    return t;
  };

  it('cannot read what only the worker may, by command, by symlink or under /proc', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dodo-agent-'));
    await chmod(root, 0o711); // like /tmp: others may pass through, not list or read
    const secret = path.join(root, 'secret');
    await writeFile(secret, 'run-token', { mode: 0o600 });
    const workdir = path.join(root, 'task', 'folder');
    process.env.DODO_AGENT_UID = String(UID);
    await prepareDir(workdir);
    expect((await stat(workdir)).uid).toBe(UID);
    expect((await stat(path.dirname(workdir))).uid).toBe(UID);
    const ctx = { store: {} as TaskStore, workdir };

    const bash = await tool('bash').execute(
      { command: `id -u; cat ${secret}; cat /proc/${process.pid}/environ` },
      ctx,
    );
    const out = String((bash.result as { output: string }).output);
    expect(out).toContain(String(UID));
    expect(out).not.toContain('run-token');
    expect(out).toMatch(/Permission denied/);
    expect(out).not.toContain('PATH=');

    await symlink(secret, path.join(workdir, 'link'));
    await expect(tool('read_file').execute({ path: 'link' }, ctx)).rejects.toThrow(
      /Permission denied/,
    );

    await tool('write_file').execute({ path: 'sub/note.txt', content: 'hi' }, ctx);
    expect((await stat(path.join(workdir, 'sub/note.txt'))).uid).toBe(UID);
    expect(await tool('read_file').execute({ path: 'sub/note.txt' }, ctx)).toEqual({
      result: { text: 'hi' },
    });
  });
});
