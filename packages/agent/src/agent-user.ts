import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chown, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The user the agent's own work runs as, apart from the worker (docs/ARCHITECTURE.md §9.2).
 *
 * The cloud worker holds the run's credential: with it, anything can ask the control plane for
 * a vault value naming any site, or for the shared Google session. So the agent's commands
 * (bash, git) and its file reads and writes in the task folder run as another, unprivileged
 * user, set by `DODO_AGENT_UID` / `DODO_AGENT_GID` in the worker image. The worker itself runs
 * as root there, so that user cannot read the worker's environment or memory under /proc, nor
 * follow a symlink in the task folder to a file only the worker may read.
 *
 * Unset (a Mac, tests, the emulator): everything runs as the worker, as before; the Mac's
 * sandbox runtime is the boundary there.
 */
export interface AgentUser {
  uid: number;
  gid: number;
}

export function agentUser(env: NodeJS.ProcessEnv = process.env): AgentUser | undefined {
  if (!env.DODO_AGENT_UID) return undefined;
  const uid = Number(env.DODO_AGENT_UID);
  const gid = Number(env.DODO_AGENT_GID ?? env.DODO_AGENT_UID);
  if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid <= 0) {
    throw new Error('DODO_AGENT_UID / DODO_AGENT_GID must be positive integers');
  }
  // Only root can switch users; a worker that cannot must not pretend it did.
  if (process.getuid?.() !== 0) {
    throw new Error('DODO_AGENT_UID is set but the worker is not running as root');
  }
  return { uid, gid };
}

/** Spawn options that run a child as the agent's user, when there is one. */
export function asAgent(): { uid?: number; gid?: number } {
  const u = agentUser();
  return u ? { uid: u.uid, gid: u.gid } : {};
}

/** A folder the agent works in: created, and owned by the agent's user when there is one. */
export async function prepareDir(dir: string): Promise<void> {
  const first = await mkdir(dir, { recursive: true });
  const u = agentUser();
  if (!u) return;
  // The folder itself and every level this call created on the way to it.
  const dirs = [path.resolve(dir)];
  if (first) {
    const top = path.resolve(first);
    for (let d = path.dirname(dirs[0] as string); d.startsWith(top); d = path.dirname(d)) {
      dirs.push(d);
      if (d === top) break;
    }
  }
  for (const d of dirs) await chown(d, u.uid, u.gid);
}

/** Runs a child as the agent and collects its stdout; stdin gets `input` when given. */
function runAs(
  u: AgentUser,
  cmd: string,
  args: string[],
  input?: Buffer,
  maxBytes = Number.POSITIVE_INFINITY,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      uid: u.uid,
      gid: u.gid,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' },
      stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    let size = 0;
    let err = '';
    child.stdout?.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        child.kill('SIGKILL');
        reject(new Error(`file is over ${maxBytes} bytes`));
        return;
      }
      out.push(c);
    });
    child.stderr?.on('data', (c: Buffer) => {
      err += c.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(err.trim().split('\n')[0] || `${cmd} exited with ${code}`));
    });
    if (input) child.stdin?.end(input);
  });
}

/** Reads a file in the task folder with the agent's own rights. */
export async function readAsAgent(file: string, maxBytes?: number): Promise<Buffer> {
  const u = agentUser();
  if (!u) {
    if (maxBytes !== undefined) {
      const info = await stat(file);
      if (info.size > maxBytes) throw new Error(`file is over ${maxBytes} bytes`);
    }
    return readFile(file);
  }
  return runAs(u, 'cat', ['--', file], undefined, maxBytes);
}

/** Whether the agent's own user may read this file (a file the worker alone may read: no). */
export async function readableAsAgent(file: string): Promise<boolean> {
  const u = agentUser();
  try {
    if (!u) await access(file, constants.R_OK);
    else await runAs(u, 'test', ['-r', '--', file]);
    return true;
  } catch {
    return false;
  }
}

/** Writes a file in the task folder with the agent's own rights (creates parent folders). */
export async function writeAsAgent(file: string, data: string | Buffer): Promise<void> {
  const u = agentUser();
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  if (!u) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    return;
  }
  await runAs(
    u,
    'sh',
    ['-c', 'mkdir -p -- "$1" && cat > "$2"', 'sh', path.dirname(file), file],
    bytes,
  );
}
