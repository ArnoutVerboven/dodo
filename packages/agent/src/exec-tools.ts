import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
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

/** Commands that only read: allowed without asking in the agent-decides profile. */
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
  'env',
  'which',
  'tree',
  'jq',
  'awk',
  'sed',
  'printf',
  'true',
  'test',
  'xargs',
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

export function classifyCommand(command: string, workdir: string): 'sandbox' | 'write' | 'egress' {
  const segments = command.split(/\s*(?:\|\||&&|;|\||\n)\s*/).filter(Boolean);
  let category: 'sandbox' | 'write' | 'egress' = 'sandbox';
  const outside = (p: string) => {
    const resolved = p.startsWith('/')
      ? path.resolve(p)
      : path.resolve(workdir, p.replace(/^~/, '/home/none'));
    return resolved !== workdir && !resolved.startsWith(`${workdir}${path.sep}`);
  };
  for (const seg of segments) {
    const tokens = seg.trim().split(/\s+/);
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] as string)) i++;
    const bin = path.basename(tokens[i] ?? '');
    const sub = tokens[i + 1] ?? '';
    if (NETWORK_BINS.has(bin)) return 'egress';
    const subs = NETWORK_SUBCOMMANDS[bin];
    if (subs && (subs.has('*') || subs.has(sub))) return 'egress';
    if (['sudo', 'su', 'chmod', 'chown', 'mount'].includes(bin)) category = 'write';
    const readOnly = READ_ONLY_BINS.has(bin);
    let redirecting = false;
    for (const t of tokens.slice(i + 1)) {
      const isRedirectOp = /^(\d?>>?|&>|<)$/.test(t);
      const inlineRedirect = /^(\d?>>?|&>)(.+)$/.exec(t);
      const target = inlineRedirect ? (inlineRedirect[2] as string) : t;
      const isTarget = redirecting || !!inlineRedirect;
      redirecting = isRedirectOp;
      if (isRedirectOp) continue;
      const looksLikePath =
        target.startsWith('/') || target.startsWith('~') || target.includes('..');
      if (!looksLikePath || !outside(target)) continue;
      // Reading outside the folder is fine; writing there (or an unknown binary touching it) is not.
      if (isTarget || !readOnly) category = 'write';
    }
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
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let out = '';
    let timedOut = false;
    const append = (chunk: Buffer) => {
      if (out.length < MAX_OUTPUT * 2) out += chunk.toString('utf8');
    };
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
      resolve({ code, out, timedOut });
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

function inside(workdir: string, p: string): string {
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
      'Run a shell command in the task folder (bash, 120 s timeout, output truncated). Read-only commands run at once; writes outside the folder and anything reaching the network need approval, so prefer http_fetch for web requests.',
    schema: z.object({ command: z.string().min(1).max(4000) }),
    policy: ({ command }, ctx) => ({
      tool: 'Bash',
      key: command,
      category: classifyCommand(command, ctx.workdir ?? '/'),
    }),
    async execute({ command }, ctx) {
      const cwd = ctx.workdir ?? process.cwd();
      await mkdir(cwd, { recursive: true });
      const r = await run(command, cwd, BASH_TIMEOUT_MS);
      return { result: { exitCode: r.code, output: clip(r.out), timedOut: r.timedOut } };
    },
  }),
  define({
    name: 'read_file',
    description: 'Read a text file from the task folder.',
    schema: z.object({ path: z.string().min(1) }),
    policy: ({ path: p }) => ({ tool: 'Read', key: p, category: 'sandbox' }),
    async execute({ path: p }, ctx) {
      const file = inside(ctx.workdir ?? process.cwd(), p);
      return { result: { text: clip(await readFile(file, 'utf8')) } };
    },
  }),
  define({
    name: 'write_file',
    description: 'Write a text file in the task folder (creates parent folders).',
    schema: z.object({ path: z.string().min(1), content: z.string().max(500_000) }),
    policy: ({ path: p }) => ({ tool: 'Write', key: p, category: 'sandbox' }),
    async execute({ path: p, content }, ctx) {
      const file = inside(ctx.workdir ?? process.cwd(), p);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content, 'utf8');
      return { result: { ok: true, bytes: Buffer.byteLength(content) } };
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
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
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
