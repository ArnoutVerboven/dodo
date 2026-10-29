import { execFile } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  authHeaderArgs,
  browserTools,
  connectBrowser,
  connectMcp,
  createSecretResolver,
  execTools,
  type GitHubAccess,
  githubTools,
  inheritedEnv,
  type McpClient,
  mcpTools,
  requestBrowserTool,
  runAgent,
  type ToolDef,
  takeScreenshot,
  taskTools,
} from '@dodo/agent';
import {
  CORE_TOOLS,
  type GitHubTokenResponse,
  Project,
  type RunToolAccess,
  repoFor,
  Task,
  toolAllowed,
} from '@dodo/core';
import { PolicyEngine } from '@dodo/policy';
import { initializeApp } from 'firebase/app';
import {
  CallableControlPlane,
  connect,
  FirestoreTaskStore,
  FirestoreTrace,
  signInAsRun,
  type WorkerEnv,
} from './adapters.js';
import { type HeadlessBrowser, startHeadlessBrowser } from './headless.js';

const HEARTBEAT_MS = 15_000;
/** How long a remote run with a browser holds its page open for an answer (MFA, a code). */
export const REMOTE_BROWSER_HOLD_MS = 10 * 60_000;
const execFileP = promisify(execFile);

/**
 * The task's (or project's) repository is checked out into the task folder before the run.
 * Private repos use a read-only token from the control plane (the dodo GitHub App), passed to
 * git for the clone only; the checkout keeps no credentials, so pushing goes through the
 * push_branch / open_pull_request tools and their approval. Configured by the user, so the
 * checkout itself needs no approval.
 */
async function checkout(
  workdir: string,
  repo: string,
  github: GitHubTokenResponse | undefined,
  log: (m: string) => void,
): Promise<string | undefined> {
  const env = { ...inheritedEnv(), GIT_TERMINAL_PROMPT: '0', HOME: workdir };
  const gitIn = (args: string[]) => execFileP('git', args, { cwd: workdir, timeout: 120_000, env });
  try {
    if ((await readdir(workdir)).length === 0) {
      await gitIn([
        ...(github?.token ? authHeaderArgs(github.token) : []),
        'clone',
        '--depth',
        '50',
        '--quiet',
        `https://github.com/${repo}.git`,
        '.',
      ]);
      log(`checked out ${repo}`);
    }
    // Commits are the app's bot (or plain dodo); only where this run cloned or a git repo exists.
    if (github?.botLogin && github.botEmail) {
      await gitIn(['config', 'user.name', github.botLogin]).catch(() => undefined);
      await gitIn(['config', 'user.email', github.botEmail]).catch(() => undefined);
    }
    return undefined;
  } catch (err) {
    const msg = (err as Error).message.split('\n')[0] ?? '';
    return `checkout of ${repo} failed: ${github?.token ? msg.split(github.token).join('***') : msg}${github?.note ? ` (${github.note})` : ''}`;
  }
}

/** One run, start to finish. Used by the Cloud Run entrypoint and the emulator dev loop. */
export async function executeRun(env: WorkerEnv): Promise<string> {
  const app = initializeApp(
    { apiKey: env.firebase.apiKey, projectId: env.firebase.projectId, appId: env.firebase.appId },
    `run-${env.runId}`,
  );
  const clients = connect(app, env);
  await signInAsRun(clients, env.runToken);
  const control = new CallableControlPlane(clients.functions, env.runId);

  let started: Awaited<ReturnType<typeof control.start>>;
  try {
    started = await control.start();
  } catch (err) {
    // Could not even start: tell the control plane so the task is released, then give up.
    await control
      .finish({ reason: 'error', error: `start failed: ${(err as Error).message}`, session: [] })
      .catch(() => {});
    throw err;
  }
  const task = Task.parse(started.task);
  const project = started.project ? Project.parse(started.project) : undefined;
  const store = new FirestoreTaskStore(clients.db, task.id, env.runId, project?.id);
  const trace = new FirestoreTrace(clients.db, env.runId);
  const workdir = pickWorkdir(task.ai.folder ?? project?.defaults.folder, task.id, env);
  await mkdir(workdir, { recursive: true });
  const policy = new PolicyEngine(started.policy);
  const repo = repoFor(task, project);
  const github = repo
    ? await control.githubToken('read').catch((err: Error) => {
        console.log(`github token unavailable: ${err.message}`);
        return undefined;
      })
    : undefined;
  const checkoutNote = repo
    ? await checkout(workdir, repo, github, (m) => console.log(m))
    : undefined;
  // The browser only when the run wants one: the daemon's server on your Chrome, or headless
  // Chromium started here in the browser worker image.
  let headless: HeadlessBrowser | undefined;
  let browserUrl = env.browserUrl;
  if (started.browser && !browserUrl && env.headlessBrowser) {
    headless = await startHeadlessBrowser({
      outputDir: path.join(workdir, '.browser'),
      log: (m) => console.log(m),
    }).catch((err: Error) => {
      console.log(`headless browser unavailable: ${err.message}`);
      return undefined;
    });
    browserUrl = headless?.url;
  }
  const browser =
    started.browser && browserUrl
      ? await connectBrowser(browserUrl).catch((err: Error) => {
          console.log(`browser unavailable: ${err.message}`);
          return undefined;
        })
      : undefined;
  const mcp = await connectMcpServers(started.tools, env);
  const notes = [
    ...mcp.notes,
    repo
      ? `Repository ${repo} is ${checkoutNote ? `not available: ${checkoutNote}` : 'checked out in the task folder; use bash, read_file and write_file on it'}.`
      : undefined,
    started.browser && !browser
      ? 'A browser was requested for this run but none is available here; work without one and say so if the task needs it.'
      : undefined,
  ].filter(Boolean);
  const taskForRun = notes.length
    ? { ...task, description: `${task.description}\n\n(${notes.join(' ')})` }
    : task;
  const githubAccess: GitHubAccess | undefined =
    repo && !checkoutNote
      ? {
          repo,
          defaultBranch: github?.defaultBranch,
          writeToken: async () => {
            const t = await control.githubToken('write');
            if (!t.token) throw new Error(t.note ?? `No write access to ${repo}`);
            return t.token;
          },
          openPullRequest: (req) => control.githubOpenPr(req),
        }
      : undefined;
  const builtins = [
    ...taskTools,
    ...execTools,
    ...(githubAccess ? githubTools(githubAccess) : []),
    ...(browser ? await browserTools(browser) : []),
    // Browser "auto" without one yet: the agent can step up when the task needs it.
    ...(!browser && started.browserSetting === 'auto' ? [requestBrowserTool] : []),
  ];
  const tools = [...filterBuiltins(builtins, started.tools), ...mcp.tools];
  if (started.tools?.toolsets.length)
    console.log(`toolsets ${started.tools.toolsets.join(', ')}: ${tools.length} tools`);

  const result = await runAgent(
    {
      runId: env.runId,
      task: taskForRun,
      project,
      model: started.model,
      trigger: started.trigger,
      contextWindow: started.contextWindow,
      session: started.session,
      answer: started.answer,
    },
    {
      control,
      store,
      trace,
      tools,
      policy,
      workdir,
      secrets: createSecretResolver((entryId, field, host) =>
        control.resolveVault(entryId, field, host),
      ),
      screenshot: browser ? (target) => takeScreenshot(browser, target) : undefined,
      browserKind: headless ? 'headless' : 'window',
      // A headless page is lost with the run: hold it for the answer when the agent asks.
      inputHoldMs: browser && headless ? REMOTE_BROWSER_HOLD_MS : undefined,
      deadline: env.deadline,
      heartbeatMs: HEARTBEAT_MS,
      log: (m, d) => console.log(m, d ?? ''),
    },
  );
  await browser?.close();
  await headless?.stop();
  await Promise.all(mcp.clients.map((c) => c.close()));
  console.log(`run ${env.runId} ended: ${result.reason} after ${result.steps} steps`);
  return result.reason;
}

/** The built-ins the Tools view leaves this run; the core task tools always stay. */
export function filterBuiltins(tools: ToolDef[], access: RunToolAccess | undefined): ToolDef[] {
  if (!access) return tools;
  return tools.filter((t) => CORE_TOOLS.includes(t.name) || toolAllowed(access.builtins, t.name));
}

const MCP_CONNECT_MS = 15_000;

/**
 * Connect to the MCP servers this run may use: remote ones directly, this Mac's local ones
 * through the daemon. A server that does not answer is left out, and the agent is told.
 */
async function connectMcpServers(
  access: RunToolAccess | undefined,
  env: WorkerEnv,
): Promise<{ tools: ToolDef[]; clients: McpClient[]; notes: string[] }> {
  const out = { tools: [] as ToolDef[], clients: [] as McpClient[], notes: [] as string[] };
  const taken = new Set<string>();
  for (const server of access?.mcp ?? []) {
    const url = server.runsOn === 'local' ? env.mcpUrls?.[server.id] : server.url;
    if (!url) {
      out.notes.push(
        `MCP server ${server.name} is not running on this Mac; its tools are missing.`,
      );
      continue;
    }
    try {
      const client = await Promise.race([
        connectMcp(url, {
          headers: server.authorization ? { Authorization: server.authorization } : undefined,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('no answer')), MCP_CONNECT_MS),
        ),
      ]);
      out.clients.push(client);
      out.tools.push(...(await mcpTools(client, server, taken)));
    } catch (err) {
      console.log(`mcp ${server.slug} unavailable: ${(err as Error).message}`);
      out.notes.push(`MCP server ${server.name} is unavailable (${(err as Error).message}).`);
    }
  }
  return out;
}

/**
 * A task may name a folder, but only one the daemon allows (`dodo folders add`) counts; anything
 * else, and every cloud run, gets a scratch folder. Resolved so `..` cannot escape.
 */
export function pickWorkdir(folder: string | undefined, taskId: string, env: WorkerEnv): string {
  const root = env.workRoot ?? path.join(os.tmpdir(), 'dodo-work');
  if (!folder || !env.allowedFolders?.length) return path.join(root, taskId);
  const expanded =
    folder === '~'
      ? os.homedir()
      : folder.startsWith('~/')
        ? path.join(os.homedir(), folder.slice(2))
        : folder;
  const resolved = path.resolve(expanded);
  const allowed = env.allowedFolders.some(
    (a) => resolved === a || resolved.startsWith(`${a.replace(/\/$/, '')}${path.sep}`),
  );
  return allowed ? resolved : path.join(root, taskId);
}

export function envFromProcess(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`Missing env ${k}`);
    return v;
  };
  return {
    runId: overrides.runId ?? need('DODO_RUN_ID'),
    runToken: overrides.runToken ?? need('DODO_RUN_TOKEN'),
    firebase: {
      apiKey: process.env.FIREBASE_API_KEY ?? 'demo-key',
      projectId: need('FIREBASE_PROJECT_ID'),
      appId: process.env.FIREBASE_APP_ID,
    },
    region: process.env.FUNCTIONS_REGION ?? 'europe-west1',
    emulatorHost: process.env.FIREBASE_EMULATOR_HOST || undefined,
    workRoot: process.env.DODO_WORK_ROOT || undefined,
    allowedFolders: process.env.DODO_FOLDERS
      ? process.env.DODO_FOLDERS.split(':').filter(Boolean)
      : undefined,
    browserUrl: process.env.DODO_BROWSER_URL || undefined,
    headlessBrowser: process.env.DODO_BROWSER === 'headless',
    mcpUrls: process.env.DODO_MCP_URLS
      ? (JSON.parse(process.env.DODO_MCP_URLS) as Record<string, string>)
      : undefined,
    // The entrypoint's hard timeout (index.ts) fires 20 s before DODO_TIMEOUT_S.
    deadline: process.env.DODO_TIMEOUT_S
      ? Date.now() + (Number(process.env.DODO_TIMEOUT_S) - 20) * 1000
      : undefined,
    ...overrides,
  };
}
