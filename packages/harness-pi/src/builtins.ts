import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  asAgent,
  classifyCommand,
  inheritedEnv,
  inside,
  type PolicyClaim,
  prepareDir,
  readAsAgent,
  readableAsAgent,
  writeAsAgent,
} from '@dodo/agent';
import {
  type BashOperations,
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

/**
 * pi's own file and shell tools (read, edit, write, bash), with their operations swapped for
 * dodo's: in the cloud every one runs as the agent user, never as the worker that holds the
 * run's credential, and only inside the task folder. Each call still passes dodo's policy
 * (`claimFor`) before it runs.
 */

/** dodo's own tools these replace: the model sees one set of file tools, not two. */
export const REPLACED_TOOLS = ['bash', 'read_file', 'write_file', 'edit_file'];

export const BUILTIN_TOOLS = ['read', 'edit', 'write', 'bash'] as const;

const BASH_TIMEOUT_S = 120;

/** The policy question for a built-in call: the same keys as dodo's own tools ask. */
export function claimFor(
  tool: string,
  input: Record<string, unknown>,
  workdir: string,
): PolicyClaim | undefined {
  const p = typeof input.path === 'string' ? input.path : '.';
  if (tool === 'bash') {
    const command = String(input.command ?? '');
    return { tool: 'Bash', key: command, category: classifyCommand(command, workdir) };
  }
  if (tool === 'read') return { tool: 'Read', key: p, category: 'sandbox' };
  if (tool === 'write' || tool === 'edit') return { tool: 'Write', key: p, category: 'sandbox' };
  return undefined;
}

/** Runs a command as the agent user in the task folder, streaming its output to pi. */
function bashOperations(): BashOperations {
  return {
    exec: (command, cwd, { onData, signal, timeout }) =>
      new Promise((resolve) => {
        const child = spawn('bash', ['-c', command], {
          cwd,
          env: { ...inheritedEnv(), HOME: cwd, LANG: 'C.UTF-8', DODO: '1' },
          ...asAgent(),
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
        const kill = () => {
          try {
            if (child.pid) process.kill(-child.pid, 'SIGKILL');
          } catch {}
        };
        const limit = Math.min(timeout ?? BASH_TIMEOUT_S, BASH_TIMEOUT_S) * 1000;
        const timer = setTimeout(kill, limit);
        signal?.addEventListener('abort', kill, { once: true });
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('close', (code, sig) => {
          clearTimeout(timer);
          resolve({ exitCode: code ?? (sig ? 128 + 9 : null) });
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          onData(Buffer.from(String(err)));
          resolve({ exitCode: null });
        });
      }),
  };
}

/** The built-in tools, bound to the task folder. */
export function builtinTools(workdir: string): ToolDefinition[] {
  const within = (abs: string) => inside(workdir, abs);
  const read = async (abs: string) => readAsAgent(within(abs), 10_000_000);
  const access = async (abs: string) => {
    if (!(await readableAsAgent(within(abs)))) throw new Error(`Cannot read ${abs}`);
  };
  const write = async (abs: string, content: string) => writeAsAgent(within(abs), content);
  return [
    createReadToolDefinition(workdir, { operations: { readFile: read, access } }),
    createEditToolDefinition(workdir, {
      operations: { readFile: read, writeFile: write, access },
    }),
    createWriteToolDefinition(workdir, {
      // writeAsAgent makes the parent folders itself, as the agent user.
      operations: { writeFile: write, mkdir: async (dir) => void within(path.resolve(dir)) },
    }),
    createBashToolDefinition(workdir, { operations: bashOperations() }),
  ] as unknown as ToolDefinition[];
}

export { prepareDir };
