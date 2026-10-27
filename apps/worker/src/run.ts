import { execFile } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  browserTools,
  connectBrowser,
  createSecretResolver,
  execTools,
  inheritedEnv,
  runAgent,
  taskTools,
} from '@dodo/agent';
import { Project, Task } from '@dodo/core';
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

const HEARTBEAT_MS = 15_000;
const execFileP = promisify(execFile);

/**
 * The project's repository is checked out into the task folder before the run. Only public
 * GitHub repos work until the credential vault (phase 5) provides a token. Configured by the
 * user on the project, so it needs no approval; later pushes still go through the policy.
 */
async function checkout(
  workdir: string,
  repo: string,
  log: (m: string) => void,
): Promise<string | undefined> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return `repo "${repo}" is not owner/name`;
  if ((await readdir(workdir)).length > 0) return undefined; // already there (same container)
  try {
    await execFileP(
      'git',
      ['clone', '--depth', '50', '--quiet', `https://github.com/${repo}.git`, '.'],
      {
        cwd: workdir,
        timeout: 120_000,
        env: { ...inheritedEnv(), GIT_TERMINAL_PROMPT: '0', HOME: workdir },
      },
    );
    log(`checked out ${repo}`);
    return undefined;
  } catch (err) {
    return `checkout of ${repo} failed: ${(err as Error).message.split('\n')[0]}`;
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
  const repo = task.ai.repo ?? project?.defaults.repo;
  const checkoutNote = repo ? await checkout(workdir, repo, (m) => console.log(m)) : undefined;
  const taskForRun = repo
    ? {
        ...task,
        description: `${task.description}\n\n(Repository ${repo} is ${checkoutNote ? `not available: ${checkoutNote}` : 'checked out in the task folder; use bash, read_file and write_file on it'}.)`,
      }
    : task;

  // The browser only when the task asked for it and the daemon handed us one.
  const browser =
    env.browserUrl && (task.ai.browser ?? project?.defaults.browser) === 'chrome'
      ? await connectBrowser(env.browserUrl).catch((err: Error) => {
          console.log(`browser unavailable: ${err.message}`);
          return undefined;
        })
      : undefined;
  const tools = [...taskTools, ...execTools, ...(browser ? await browserTools(browser) : [])];

  const result = await runAgent(
    {
      runId: env.runId,
      task: taskForRun,
      project,
      model: started.model,
      trigger: started.trigger,
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
      heartbeatMs: HEARTBEAT_MS,
      log: (m, d) => console.log(m, d ?? ''),
    },
  );
  await browser?.close();
  console.log(`run ${env.runId} ended: ${result.reason} after ${result.steps} steps`);
  return result.reason;
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
    ...overrides,
  };
}
