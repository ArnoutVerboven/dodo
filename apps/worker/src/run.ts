import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execTools, runAgent, taskTools } from '@dodo/agent';
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
  const workdir = path.join(os.tmpdir(), 'dodo-work', task.id);
  await mkdir(workdir, { recursive: true });
  const policy = new PolicyEngine(started.policy);

  const result = await runAgent(
    {
      runId: env.runId,
      task,
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
      tools: [...taskTools, ...execTools],
      policy,
      workdir,
      heartbeatMs: HEARTBEAT_MS,
      log: (m, d) => console.log(m, d ?? ''),
    },
  );
  console.log(`run ${env.runId} ended: ${result.reason} after ${result.steps} steps`);
  return result.reason;
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
    ...overrides,
  };
}
