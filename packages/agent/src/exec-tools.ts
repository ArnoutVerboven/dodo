import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Decision } from '@dodo/policy';
import { z } from 'zod';
import { asAgent, prepareDir, readAsAgent, writeAsAgent } from './agent-user.js';
import { define, type ToolDef } from './tools.js';

/**
 * Phase 4 tools: shell, files and HTTP. Each declares a policy key and a category so the
 * loop can ask the policy engine before running it. They run inside the worker's task
 * folder; nothing here grants more than the process already has, which is why the worker
 * runs as an unprivileged user with no cloud roles.
 */

const MAX_OUTPUT = 20_000;
const BASH_TIMEOUT_MS = 120_000;
const HTTP_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

/**
 * Commands that only read: allowed without asking in the agent-decides profile. `sed` and `find`
 * are here only without their writing or executing flags (see `readOnlyUse`). Anything that can
 * run another command (`xargs`, `env`, `awk`) is not.
 */
const READ_ONLY_BINS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'grep',
  'rg',
  'find',
  'wc',
  'echo',
  'pwd',
  'stat',
  'file',
  'sort',
  'uniq',
  'cut',
  'tr',
  'diff',
  'du',
  'df',
  'date',
  'which',
  'tree',
  'jq',
  'sed',
  'printf',
  'true',
  'test',
  'basename',
  'dirname',
  'realpath',
  'md5sum',
  'sha256sum',
]);
/** Tools that reach the network: always egress. */
const NETWORK_BINS = new Set([
  'curl',
  'wget',
  'ssh',
  'scp',
  'rsync',
  'nc',
  'ncat',
  'telnet',
  'pip',
  'pip3',
  'apt',
  'apt-get',
  'brew',
]);
const NETWORK_SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set(['push', 'pull', 'fetch', 'clone', 'remote', 'ls-remote', 'submodule']),
  npm: new Set(['install', 'i', 'ci', 'publish', 'update', 'add', 'exec', 'x']),
  pnpm: new Set(['install', 'i', 'add', 'update', 'publish', 'dlx']),
  npx: new Set(['*']),
  gh: new Set(['*']),
  gcloud: new Set(['*']),
};

/**
 * Commands that run the command after their own options. Policy looks through them: `xargs curl`
 * is `curl`, `env FOO=1 rm /x` is `rm /x`. The value is the set of options that take an argument.
 */
const WRAPPERS: Record<string, Set<string>> = {
  xargs: new Set([
    '-I',
    '-i',
    '-n',
    '-P',
    '-d',
    '-L',
    '-l',
    '-s',
    '-E',
    '-e',
    '-a',
    '--arg-file',
    '--delimiter',
    '--max-args',
    '--max-procs',
    '--replace',
  ]),
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '-n', '-p']),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  nohup: new Set(),
  stdbuf: new Set(['-i', '-o', '-e']),
  setsid: new Set(),
  time: new Set(['-f', '-o']),
  command: new Set(),
  exec: new Set(['-a']),
  builtin: new Set(),
  chroot: new Set(),
};
/** Shells and interpreters whose `-c` / `-e` string is another command line. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
const AWKS = new Set(['awk', 'gawk', 'mawk', 'nawk']);
/** `find` actions that run a command or change files. */
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const FIND_WRITE = new Set(['-delete', '-fprint', '-fprint0', '-fprintf', '-fls']);

type Category = 'sandbox' | 'write' | 'egress';
const RANK: Record<Category, number> = { sandbox: 0, write: 1, egress: 2 };
const worst = (a: Category, b: Category): Category => (RANK[b] > RANK[a] ? b : a);
const unquote = (t: string) => t.replace(/^['"]+|['"]+$/g, '');

/**
 * Whether a `sed` call only reads: no in-place edit, and no `w`/`W` (write a file) or `e`
 * (run a command) in its script, as a command or as an `s///` flag.
 */
function sedReadOnly(args: string[]): boolean {
  for (const a of args) {
    if (/^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place')) return false;
  }
  const script = args.filter((a) => !a.startsWith('-')).join(' ');
  return !/(^|[\s;{}'"/\d$!])[wWe](\s|$|['";}])/.test(script);
}

export function classifyCommand(command: string, workdir: string): Category {
  // awk's program can run anything (`system()`, `print | "cmd"`, `"cmd" | getline`), and the pipe
  // inside it would split the line below, so it is checked on the whole line first.
  if (
    /\b[gmn]?awk\b/.test(command) &&
    /system\s*\(|\|\s*getline|\|\s*["']|print[f]?[^;}]*>/.test(command)
  ) {
    return 'egress';
  }
  const segments = command.split(/\s*(?:\|\||&&|;|\||\n)\s*/).filter(Boolean);
  let category: Category = 'sandbox';
  for (const seg of segments) {
    category = worst(category, classifyTokens(seg.trim().split(/\s+/), workdir, 0));
    if (category === 'egress') return category;
  }
  return category;
}

function classifyTokens(tokens: string[], workdir: string, depth: number): Category {
  const outside = (p: string) => {
    const resolved = p.startsWith('/')
      ? path.resolve(p)
      : path.resolve(workdir, p.replace(/^~/, '/home/none'));
    return resolved !== workdir && !resolved.startsWith(`${workdir}${path.sep}`);
  };
  // Too deep a nest of wrappers is not something to reason about: ask.
  if (depth > 8) return 'egress';
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] as string)) i++;
  const bin = path.basename(unquote(tokens[i] ?? ''));
  const args = tokens.slice(i + 1);
  const sub = unquote(args[0] ?? '');
  if (!bin) return 'sandbox';
  if (NETWORK_BINS.has(bin)) return 'egress';
  const subs = NETWORK_SUBCOMMANDS[bin];
  if (subs && (subs.has('*') || subs.has(sub))) return 'egress';

  const wrapperOpts = WRAPPERS[bin];
  if (wrapperOpts) {
    let j = 0;
    while (j < args.length) {
      const a = unquote(args[j] as string);
      if (a === '--') {
        j++;
        break;
      }
      if (bin === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) j++;
      else if (a.startsWith('-')) j += wrapperOpts.has(a) ? 2 : 1;
      else break;
    }
    // timeout's first positional is the duration, chroot's is the new root.
    if ((bin === 'timeout' || bin === 'chroot') && j < args.length) j++;
    const inner = args.slice(j);
    // A wrapper with no command: xargs runs `echo`, env prints the environment.
    if (inner.length === 0) return 'sandbox';
    const own = bin === 'chroot' ? 'write' : 'sandbox';
    return worst(own, classifyTokens(inner, workdir, depth + 1));
  }

  if (SHELLS.has(bin)) {
    const c = args.findIndex((a) => /^-[a-zA-Z]*c$/.test(a));
    if (c >= 0) {
      const inner = args
        .slice(c + 1)
        .map(unquote)
        .join(' ');
      return classifyCommand(inner, workdir);
    }
  }

  let category: Category = 'sandbox';
  if (['sudo', 'su', 'chmod', 'chown', 'mount'].includes(bin)) category = 'write';
  let readOnly = READ_ONLY_BINS.has(bin);
  if (bin === 'sed' && !sedReadOnly(args)) readOnly = false;
  if (AWKS.has(bin)) readOnly = false;
  if (bin === 'find') {
    for (let k = 0; k < args.length; k++) {
      const a = args[k] as string;
      if (FIND_WRITE.has(a)) readOnly = false;
      if (FIND_EXEC.has(a)) {
        readOnly = false;
        let end = k + 1;
        while (end < args.length && args[end] !== ';' && args[end] !== '\\;' && args[end] !== '+')
          end++;
        category = worst(category, classifyTokens(args.slice(k + 1, end), workdir, depth + 1));
        k = end;
      }
    }
  }
  let redirecting = false;
  for (const raw of args) {
    const t = unquote(raw);
    const isRedirectOp = /^(\d?>>?|&>|<)$/.test(t);
    const inlineRedirect = /^(\d?>>?|&>)(.+)$/.exec(t);
    const target = inlineRedirect ? (inlineRedirect[2] as string) : t;
    const isTarget = redirecting || !!inlineRedirect;
    redirecting = isRedirectOp;
    if (isRedirectOp) continue;
    const looksLikePath = target.startsWith('/') || target.startsWith('~') || target.includes('..');
    if (!looksLikePath || !outside(target)) continue;
    // Reading outside the folder is fine; writing there (or an unknown binary touching it) is not.
    if (isTarget || !readOnly) category = worst(category, 'write');
  }
  return category;
}

/**
 * What a command the agent runs inherits from the worker's environment: nothing but the path and,
 * when the worker itself runs inside a sandbox, the way out of it. The sandbox hands the worker a
 * proxy and a trust store through these variables; a command without them has no network at all,
 * silently, instead of a refusal it can read.
 */
const INHERITED = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'ALL_PROXY',
  'all_proxy',
  'GRPC_PROXY',
  'grpc_proxy',
  'SANDBOX_RUNTIME',
  'TMPDIR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'NODE_EXTRA_CA_CERTS',
  'GIT_SSL_CAINFO',
  'GIT_SSH_COMMAND',
  'GIT_CONFIG_PARAMETERS',
];

export function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  for (const k of INHERITED) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

function run(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], {
      cwd,
      env: { ...inheritedEnv(), HOME: cwd, LANG: 'C.UTF-8', DODO: '1' },
      // In the cloud: another user than the worker, which holds the run's credential.
      ...asAgent(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const out = new OutputBuffer();
    let timedOut = false;
    const append = (chunk: Buffer) => out.push(chunk.toString('utf8'));
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.text(), timedOut });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, out: String(err), timedOut: false });
    });
  });
}

const clip = (s: string) =>
  s.length > MAX_OUTPUT
    ? `${s.slice(0, MAX_OUTPUT)}\n…[truncated ${s.length - MAX_OUTPUT} chars]`
    : s;

/** How much of a long command output's start is kept; the rest of the budget goes to its end. */
const OUTPUT_HEAD = 4_000;

/**
 * Command output, kept as its start and its end: errors and results usually come last, so a
 * long build log must not lose them to the cut. Holds at most about MAX_OUTPUT characters.
 */
export class OutputBuffer {
  private head = '';
  private tail = '';
  private dropped = 0;

  push(chunk: string): void {
    if (this.head.length < OUTPUT_HEAD) {
      const room = OUTPUT_HEAD - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    if (!chunk) return;
    this.tail += chunk;
    const max = MAX_OUTPUT - OUTPUT_HEAD;
    if (this.tail.length > max) {
      this.dropped += this.tail.length - max;
      this.tail = this.tail.slice(this.tail.length - max);
    }
  }

  text(): string {
    if (!this.dropped) return this.head + this.tail;
    return `${this.head}\n…[${this.dropped} chars cut from the middle]…\n${this.tail}`;
  }
}

/** Lines read_file returns when no limit is given, and the most it returns in one call. */
const READ_LINES = 2_000;
/** A longer line is cut in read_file's output, so one minified file cannot fill the answer. */
const READ_LINE_CHARS = 2_000;

/**
 * A slice of a text file, numbered from 1 like an editor, and where to continue. Stops early
 * when the slice would pass MAX_OUTPUT characters, so the answer always says what is left.
 */
export function readSlice(
  text: string,
  offset = 1,
  limit = READ_LINES,
): {
  text: string;
  totalLines: number;
  nextOffset?: number;
} {
  const lines = text.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  const totalLines = lines.length;
  const start = Math.max(1, offset);
  const end = Math.min(totalLines, start - 1 + Math.min(limit, READ_LINES));
  const width = String(end).length;
  const out: string[] = [];
  let size = 0;
  let last = start - 1;
  for (let n = start; n <= end; n++) {
    let line = lines[n - 1] as string;
    if (line.length > READ_LINE_CHARS)
      line = `${line.slice(0, READ_LINE_CHARS)}…[line cut, ${line.length} chars]`;
    const numbered = `${String(n).padStart(width)}\t${line}`;
    if (size + numbered.length > MAX_OUTPUT && out.length) break;
    out.push(numbered);
    size += numbered.length + 1;
    last = n;
  }
  return {
    text: out.join('\n'),
    totalLines,
    ...(last < totalLines ? { nextOffset: last + 1 } : {}),
  };
}

/** Where `find` occurs in `text`, by character index. */
function occurrences(text: string, find: string): number[] {
  const at: number[] = [];
  for (let i = text.indexOf(find); i !== -1; i = text.indexOf(find, i + find.length)) at.push(i);
  return at;
}

/**
 * Replace an exact piece of text. One match is required unless `all` is set: an edit that
 * could land in two places is refused, so the agent adds context instead of guessing.
 */
export function applyEdit(
  text: string,
  oldText: string,
  newText: string,
  all = false,
): { text: string; replacements: number; line: number } | { error: string } {
  if (!oldText) return { error: 'old_text is empty; use write_file to create a file.' };
  if (oldText === newText) return { error: 'old_text and new_text are the same.' };
  const at = occurrences(text, oldText);
  if (at.length === 0) {
    return {
      error:
        'old_text was not found. It must match the file exactly, whitespace and line breaks included; read the file again and copy the text from it.',
    };
  }
  if (at.length > 1 && !all) {
    return {
      error: `old_text occurs ${at.length} times. Add surrounding lines so it is unique, or set replace_all.`,
    };
  }
  const line = text.slice(0, at[0]).split('\n').length;
  return { text: text.split(oldText).join(newText), replacements: at.length, line };
}

/** Folders a search never needs to look in. */
const SKIP_DIRS = ['.git', 'node_modules'];
/** The most matches or file names a search returns. */
const SEARCH_RESULTS = 200;
const SEARCH_TIMEOUT_MS = 30_000;

/** Runs a program (no shell) as the agent and returns what it printed, cut to MAX_OUTPUT. */
function runProgram(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = SEARCH_TIMEOUT_MS,
): Promise<{ code: number | null; out: string; missing: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...inheritedEnv(), HOME: cwd, LANG: 'C.UTF-8' },
      ...asAgent(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = new OutputBuffer();
    child.stdout.on('data', (c: Buffer) => out.push(c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => out.push(c.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.text(), missing: false });
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ code: null, out: String(err), missing: err.code === 'ENOENT' });
    });
  });
}

/** Keeps the first `max` lines of a program's output and says how many more there were. */
function firstLines(out: string, max: number): { text: string; more: number } {
  const lines = out.split('\n').filter(Boolean);
  return { text: lines.slice(0, max).join('\n'), more: Math.max(0, lines.length - max) };
}

/** A path inside the task folder as an argument: relative to it, and never read as an option. */
const relative = (workdir: string, p: string) => {
  const rel = path.relative(workdir, p);
  return rel ? `.${path.sep}${rel}` : '.';
};

/**
 * Hosts http_fetch reaches only when you approved that very host: the worker's own machine
 * and network, and the cloud metadata server that hands out the service account's tokens.
 * An allowed-hosts entry or a wildcard rule (`Http(*)`) never opens them; the exact rule
 * `Http(domain:127.0.0.1)`, from a card that names it, does (a local dev server on a Mac).
 * Judged on the name or address literal; a public name that resolves to a private address
 * (DNS rebinding) is not caught here.
 */
export function privateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === 'metadata.google.internal' || h.endsWith('.internal') || h.endsWith('.local'))
    return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 || // this network
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) || // link-local, metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      a >= 224 // multicast, reserved, broadcast
    );
  }
  if (h.startsWith('[') || h.includes(':')) {
    const ip = h.replace(/^\[|\]$/g, '');
    if (ip === '::' || ip === '::1') return true;
    if (/^::ffff:/i.test(ip)) return privateHost(ip.slice(7)); // v4-mapped
    return /^(fc|fd|fe[89ab])/i.test(ip); // unique local, link-local
  }
  // A bare number or hex literal is an IPv4 address in disguise (`2130706433`, `0x7f000001`).
  return /^(0x[0-9a-f]+|\d+)$/i.test(h);
}

/** Whether a decision allows this host by name: the exact rule, or a once-approval of it. */
function namedHost(decision: Decision | undefined, host: string): boolean {
  return (
    decision?.kind === 'allow' &&
    (decision.by === `Http(domain:${host})` || decision.by === 'approved once')
  );
}

export function inside(workdir: string, p: string): string {
  const resolved = path.resolve(workdir, p);
  if (resolved !== workdir && !resolved.startsWith(`${workdir}${path.sep}`)) {
    throw new Error(`Path ${p} is outside the task folder`);
  }
  return resolved;
}

export const execTools = [
  define({
    name: 'bash',
    description:
      'Run a shell command in the task folder (bash, 120 s timeout; a long output keeps its start and its end). For files, prefer read_file, edit_file, grep and find_files. Read-only commands run at once; writes outside the folder and anything reaching the network need approval, so prefer http_fetch for web requests.',
    schema: z.object({ command: z.string().min(1).max(4000) }),
    policy: ({ command }, ctx) => ({
      tool: 'Bash',
      key: command,
      category: classifyCommand(command, ctx.workdir ?? '/'),
    }),
    async execute({ command }, ctx) {
      const cwd = ctx.workdir ?? process.cwd();
      await prepareDir(cwd);
      const r = await run(command, cwd, BASH_TIMEOUT_MS);
      return { result: { exitCode: r.code, output: clip(r.out), timedOut: r.timedOut } };
    },
  }),
  define({
    name: 'read_file',
    description:
      'Read a text file from the task folder. Lines come numbered from 1; a long file comes in parts of up to 2000 lines: continue with the offset the answer gives as nextOffset. Use grep to find the right part of a big file first.',
    schema: z.object({
      path: z.string().min(1),
      offset: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('First line to return, counted from 1. Default 1.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(READ_LINES)
        .optional()
        .describe(`Most lines to return. Default and maximum ${READ_LINES}.`),
    }),
    policy: ({ path: p }) => ({ tool: 'Read', key: p, category: 'sandbox' }),
    async execute({ path: p, offset, limit }, ctx) {
      const file = inside(ctx.workdir ?? process.cwd(), p);
      const text = (await readAsAgent(file, 50_000_000)).toString('utf8');
      const slice = readSlice(text, offset, limit);
      if (offset && offset > slice.totalLines) {
        return {
          result: {
            error: `The file has ${slice.totalLines} lines; offset ${offset} is past its end.`,
          },
        };
      }
      return { result: slice };
    },
  }),
  define({
    name: 'write_file',
    description:
      'Write a whole text file in the task folder (creates parent folders). To change part of an existing file, use edit_file instead.',
    schema: z.object({ path: z.string().min(1), content: z.string().max(500_000) }),
    policy: ({ path: p }) => ({ tool: 'Write', key: p, category: 'sandbox' }),
    async execute({ path: p, content }, ctx) {
      const file = inside(ctx.workdir ?? process.cwd(), p);
      await writeAsAgent(file, content);
      return { result: { ok: true, bytes: Buffer.byteLength(content) } };
    },
  }),
  define({
    name: 'edit_file',
    description:
      "Change part of a text file in the task folder: replace old_text, copied exactly from the file (whitespace included, without read_file's line numbers), with new_text. old_text must occur once; add surrounding lines to make it unique, or set replace_all to change every occurrence.",
    schema: z.object({
      path: z.string().min(1),
      old_text: z.string().min(1).max(100_000),
      new_text: z.string().max(100_000),
      replace_all: z.boolean().optional(),
    }),
    policy: ({ path: p }) => ({ tool: 'Write', key: p, category: 'sandbox' }),
    async execute({ path: p, old_text, new_text, replace_all }, ctx) {
      const file = inside(ctx.workdir ?? process.cwd(), p);
      const before = (await readAsAgent(file, 10_000_000)).toString('utf8');
      const edit = applyEdit(before, old_text, new_text, replace_all);
      if ('error' in edit) return { result: { error: edit.error } };
      await writeAsAgent(file, edit.text);
      return { result: { ok: true, replacements: edit.replacements, line: edit.line } };
    },
  }),
  define({
    name: 'grep',
    description: `Search file contents in the task folder for a regular expression; answers path:line:text, at most ${SEARCH_RESULTS} matches. Skips .git, node_modules and (where ripgrep is installed) whatever .gitignore lists.`,
    schema: z.object({
      pattern: z.string().min(1).max(1000).describe('A regular expression.'),
      path: z
        .string()
        .min(1)
        .optional()
        .describe('File or folder to search, relative to the task folder. Default: all of it.'),
      glob: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe('Only files whose name matches, like *.ts.'),
      ignore_case: z.boolean().optional(),
    }),
    policy: ({ path: p }) => ({ tool: 'Read', key: p ?? '.', category: 'sandbox' }),
    async execute({ pattern, path: p, glob, ignore_case }, ctx) {
      const workdir = ctx.workdir ?? process.cwd();
      const target = relative(workdir, inside(workdir, p ?? '.'));
      const rg = await runProgram(
        'rg',
        [
          '--line-number',
          '--no-heading',
          '--color=never',
          '--max-columns=500',
          '--max-columns-preview',
          ...(ignore_case ? ['-i'] : []),
          ...(glob ? ['--glob', glob] : []),
          ...SKIP_DIRS.flatMap((d) => ['--glob', `!${d}`]),
          '-e',
          pattern,
          '--',
          target,
        ],
        workdir,
      );
      const r = rg.missing
        ? await runProgram(
            'grep',
            [
              '-rnIE',
              ...(ignore_case ? ['-i'] : []),
              ...(glob ? [`--include=${glob}`] : []),
              ...SKIP_DIRS.map((d) => `--exclude-dir=${d}`),
              '-e',
              pattern,
              '--',
              target,
            ],
            workdir,
          )
        : rg;
      // Both exit 1 for no match and 2 for an error (a bad pattern, a missing path).
      if (r.code === 1) return { result: { matches: '', count: 0 } };
      if (r.code !== 0) return { result: { error: r.out.trim() || `search failed (${r.code})` } };
      const { text, more } = firstLines(r.out, SEARCH_RESULTS);
      return { result: { matches: text, ...(more ? { more } : {}) } };
    },
  }),
  define({
    name: 'find_files',
    description: `List files in the task folder whose name matches a glob (like *.md or test_*.py), at most ${SEARCH_RESULTS}. Skips .git, node_modules and (where ripgrep is installed) whatever .gitignore lists.`,
    schema: z.object({
      pattern: z.string().min(1).max(200).describe('A file-name glob, like *.ts.'),
      path: z
        .string()
        .min(1)
        .optional()
        .describe('Folder to look in, relative to the task folder. Default: all of it.'),
    }),
    policy: ({ path: p }) => ({ tool: 'Read', key: p ?? '.', category: 'sandbox' }),
    async execute({ pattern, path: p }, ctx) {
      const workdir = ctx.workdir ?? process.cwd();
      const target = relative(workdir, inside(workdir, p ?? '.'));
      const rg = await runProgram(
        'rg',
        [
          '--files',
          '--color=never',
          '--glob',
          pattern.includes('/') ? pattern : `**/${pattern}`,
          ...SKIP_DIRS.flatMap((d) => ['--glob', `!${d}`]),
          '--',
          target,
        ],
        workdir,
      );
      const r = rg.missing
        ? await runProgram(
            'find',
            [
              target,
              ...SKIP_DIRS.flatMap((d) => ['-name', d, '-prune', '-o']),
              '-type',
              'f',
              pattern.includes('/') ? '-path' : '-name',
              pattern,
              '-print',
            ],
            workdir,
          )
        : rg;
      // ripgrep exits 1 when no file matches.
      if (r.code === 1 && !rg.missing) return { result: { files: '', count: 0 } };
      if (r.code !== 0) return { result: { error: r.out.trim() || `search failed (${r.code})` } };
      const { text, more } = firstLines(r.out, SEARCH_RESULTS);
      return { result: { files: text, ...(more ? { more } : {}) } };
    },
  }),
  define({
    name: 'list_dir',
    description:
      'List a folder in the task folder: names, with a trailing / for folders. Hidden files included.',
    schema: z.object({
      path: z
        .string()
        .min(1)
        .optional()
        .describe('Folder relative to the task folder. Default: the task folder itself.'),
    }),
    policy: ({ path: p }) => ({ tool: 'Read', key: p ?? '.', category: 'sandbox' }),
    async execute({ path: p }, ctx) {
      const workdir = ctx.workdir ?? process.cwd();
      const target = relative(workdir, inside(workdir, p ?? '.'));
      const r = await runProgram('ls', ['-1Ap', '--', target], workdir);
      if (r.code !== 0) return { result: { error: r.out.trim() || `ls failed (${r.code})` } };
      const { text, more } = firstLines(r.out, 500);
      return { result: { entries: text, ...(more ? { more } : {}) } };
    },
  }),
  define({
    name: 'http_fetch',
    description:
      'Fetch a URL (GET) and return its text, with HTML reduced to readable text. Hosts not on the allowlist need approval once.',
    schema: z.object({ url: z.string().url() }),
    policy: ({ url }) => ({
      tool: 'Http',
      key: `domain:${new URL(url).hostname}`,
      category: 'egress',
    }),
    async execute({ url }, ctx) {
      let current = url;
      let hopDecision = ctx.decision;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const target = new URL(current);
        if (target.protocol !== 'https:' && target.protocol !== 'http:')
          return { result: { error: `Only http(s) URLs can be fetched, not ${target.protocol}` } };
        if (privateHost(target.hostname) && !namedHost(hopDecision, target.hostname)) {
          return {
            result: {
              error: `${target.hostname} is a private or local host; only an approval naming it exactly allows it.`,
            },
          };
        }
        const res = await fetch(current, {
          redirect: 'manual',
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
          headers: {
            'user-agent': 'dodo-agent/0.1 (+https://github.com/ArnoutVerboven/dodo)',
            accept: 'text/html,application/json,text/plain,*/*',
          },
        });
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          const next = new URL(res.headers.get('location') as string, current).toString();
          const host = new URL(next).hostname;
          // A redirect to another host is a new egress decision.
          if (host !== new URL(current).hostname && ctx.policy) {
            const d = ctx.policy.decide({
              tool: 'Http',
              key: `domain:${host}`,
              category: 'egress',
            });
            if (d.kind !== 'allow') {
              return {
                result: {
                  error: `Redirected to ${host}, which needs approval. Ask to fetch ${next} directly.`,
                },
              };
            }
            hopDecision = d;
          }
          current = next;
          continue;
        }
        const type = res.headers.get('content-type') ?? '';
        const body = await res.text();
        const text = /text\/html/.test(type) ? htmlToText(body) : body;
        return {
          result: { status: res.status, url: current, contentType: type, text: clip(text) },
        };
      }
      return { result: { error: 'Too many redirects' } };
    },
  }),
] as ToolDef[];

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|p|div|li|h[1-6]|tr|section|article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
