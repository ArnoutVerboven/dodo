import {
  FinishRequest,
  GenerateRequest,
  HeartbeatRequest,
  paths,
  RequestInputRequest,
} from '@dodo/core';
import { CloudBillingClient } from '@google-cloud/billing';
import { ExecutionsClient, JobsClient } from '@google-cloud/run';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { defineInt, defineString } from 'firebase-functions/params';
import { logger, setGlobalOptions } from 'firebase-functions/v2';
import { onDocumentCreated, onDocumentWritten } from 'firebase-functions/v2/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onMessagePublished } from 'firebase-functions/v2/pubsub';
import { claimOwnership as claim } from './claim-ownership.js';
import { dispatch, type Executor } from './dispatcher.js';
import { DEFAULT_HOURLY_CAP, generateWithBudget } from './gateway.js';
import { handleMessage, parseMessage } from './kill-switch.js';
import { FakeProvider, type ModelProvider, VertexProvider } from './model-provider.js';
import { finish, heartbeat, reapIfStale, requestInput, start } from './run-control.js';
import { costGateFor, loadRunForCaller, scopesForRun } from './runtime.js';
import { generateTitle } from './title.js';
import { onInputAnswered, onTaskChanged, onUserMessage } from './triggers.js';

initializeApp();
setGlobalOptions({ region: 'europe-west1', maxInstances: 2 });

const HALT_AT = defineInt('BUDGET_HALT_AT', { default: 40 });
const DETACH_AT = defineInt('BUDGET_DETACH_AT', { default: 45 });
const CURRENCY = defineString('BUDGET_CURRENCY', { default: 'EUR' });
const OWNER_EMAIL = defineString('OWNER_EMAIL', { default: '' });
/** `fake` runs the scripted model (emulator, tests); anything else uses Vertex AI. */
const MODEL_BACKEND = defineString('MODEL_BACKEND', { default: 'vertex' });
const REGION = 'europe-west1';
const WORKER_JOB = 'dodo-worker';
const GATEWAY_SA = 'dodo-gateway@';
const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true';

const projectId = () => {
  const id = process.env.GCLOUD_PROJECT ?? process.env.GCP_PROJECT;
  if (!id) throw new Error('Project id not available');
  return id;
};

let providerInstance: ModelProvider | undefined;
const provider = (): ModelProvider => {
  providerInstance ??=
    MODEL_BACKEND.value() === 'fake' || isEmulator
      ? new FakeProvider()
      : new VertexProvider(projectId(), REGION);
  return providerInstance;
};

const controlDeps = () => {
  const db = getFirestore();
  return {
    db,
    auth: getAuth(),
    storage: getStorage(),
    costGate: costGateFor(db),
    log: logger.warn,
  };
};

const caller = (auth: { uid: string; token: Record<string, unknown> } | undefined) =>
  auth ? { uid: auth.uid, claims: auth.token } : undefined;

const parseOr = <T>(
  schema: {
    safeParse: (d: unknown) => { success: boolean; data?: T; error?: { message: string } };
  },
  data: unknown,
): T => {
  const r = schema.safeParse(data);
  if (!r.success || r.data === undefined)
    throw new HttpsError('invalid-argument', r.error?.message ?? 'Invalid request');
  return r.data;
};

/* ----------------------------- owner ----------------------------- */

export const claimOwnership = onCall({ maxInstances: 1 }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first');
  const auth = getAuth();
  const result = await claim(uid, {
    ownerEmail: OWNER_EMAIL.value(),
    getUser: async (id) => {
      const u = await auth.getUser(id);
      return { email: u.email, emailVerified: u.emailVerified, claims: u.customClaims ?? {} };
    },
    setClaims: (id, claims) => auth.setCustomUserClaims(id, claims),
  });
  if (!result.ok) {
    logger.warn('Ownership claim refused', { uid, reason: result.reason });
    throw new HttpsError('permission-denied', result.reason);
  }
  if (!result.alreadyOwner) logger.info('Ownership granted', { uid });
  return result;
});

/* ------------------------- control plane ------------------------- */

/** The only path to Vertex AI. Workers call it with their per-run identity. */
export const gatewayGenerate = onCall(
  { serviceAccount: GATEWAY_SA, memory: '512MiB', timeoutSeconds: 300, maxInstances: 5 },
  async (request) => {
    const req = parseOr<GenerateRequest>(GenerateRequest, request.data);
    const db = getFirestore();
    const run = await loadRunForCaller(db, caller(request.auth), req.runId);
    return generateWithBudget(
      { db, costGate: costGateFor(db), provider: provider(), hourlyCap: DEFAULT_HOURLY_CAP },
      {
        scopes: scopesForRun(run),
        taskId: run.taskId,
        projectId: run.projectId,
        runId: run.id,
        description: `model call (${req.model})`,
      },
      req,
    );
  },
);

export const runStart = onCall(
  { serviceAccount: GATEWAY_SA, memory: '512MiB', maxInstances: 5 },
  async (request) => {
    const { runId } = parseOr<{ runId: string }>(HeartbeatRequest, request.data);
    const deps = controlDeps();
    const run = await loadRunForCaller(deps.db, caller(request.auth), runId, [
      'claimed',
      'dispatching',
    ]);
    return start(deps, run);
  },
);

export const runHeartbeat = onCall(
  { serviceAccount: GATEWAY_SA, maxInstances: 5 },
  async (request) => {
    const { runId } = parseOr<{ runId: string }>(HeartbeatRequest, request.data);
    const deps = controlDeps();
    const run = await loadRunForCaller(deps.db, caller(request.auth), runId);
    return heartbeat(deps, run);
  },
);

export const runRequestInput = onCall(
  { serviceAccount: GATEWAY_SA, memory: '512MiB', maxInstances: 5 },
  async (request) => {
    const req = parseOr<RequestInputRequest>(RequestInputRequest, request.data);
    const deps = controlDeps();
    const run = await loadRunForCaller(deps.db, caller(request.auth), req.runId);
    await requestInput(deps, run, req);
    return { ok: true };
  },
);

export const runFinish = onCall(
  { serviceAccount: GATEWAY_SA, memory: '512MiB', maxInstances: 5 },
  async (request) => {
    const req = parseOr<FinishRequest>(FinishRequest, request.data);
    const deps = controlDeps();
    const run = await loadRunForCaller(deps.db, caller(request.auth), req.runId, [
      'claimed',
      'running',
      'dispatching',
    ]);
    await finish(deps, run, req);
    return { ok: true };
  },
);

/* ---------------------------- triggers --------------------------- */

export const onTaskWritten = onDocumentWritten(
  { document: 'tasks/{taskId}', serviceAccount: GATEWAY_SA },
  async (event) => {
    const db = getFirestore();
    const before = event.data?.before.exists
      ? { id: event.params.taskId, ...event.data.before.data() }
      : undefined;
    const after = event.data?.after.exists
      ? { id: event.params.taskId, ...event.data.after.data() }
      : undefined;
    // biome-ignore lint/suspicious/noExplicitAny: Firestore data is validated downstream
    await onTaskChanged({ db, log: logger.info }, before as any, after as any);
    if (after && !before && (after as { titleSource?: string }).titleSource === 'ai') {
      await generateTitle(
        { db, costGate: costGateFor(db), provider: provider(), hourlyCap: DEFAULT_HOURLY_CAP },
        event.params.taskId,
      ).catch((err) => logger.warn('title generation failed', { err: String(err) }));
    }
  },
);

export const onMessageWritten = onDocumentWritten(
  { document: 'tasks/{taskId}/messages/{messageId}', serviceAccount: GATEWAY_SA },
  async (event) => {
    const db = getFirestore();
    const before = event.data?.before.exists ? event.data.before.data() : undefined;
    const after = event.data?.after.exists ? event.data.after.data() : undefined;
    if (!after) return;
    const deps = {
      db,
      log: logger.info,
      reap: (runId: string) => reapIfStale(controlDeps(), runId),
    };
    if (!before) {
      await onUserMessage(deps, event.params.taskId, after as { author: string; input?: unknown });
    } else {
      await onInputAnswered(
        deps,
        event.params.taskId,
        event.params.messageId,
        before as Parameters<typeof onInputAnswered>[3],
        after as Parameters<typeof onInputAnswered>[4],
      );
    }
  },
);

/** Cloud Run Jobs executor: one execution per run, env carries the run identity. */
class CloudRunExecutor implements Executor {
  async start(_run: unknown, env: Record<string, string>, timeoutSeconds: number) {
    const jobs = new JobsClient();
    const name = `projects/${projectId()}/locations/${REGION}/jobs/${WORKER_JOB}`;
    const [op] = await jobs.runJob({
      name,
      overrides: {
        taskCount: 1,
        timeout: { seconds: timeoutSeconds },
        containerOverrides: [{ env: Object.entries(env).map(([k, v]) => ({ name: k, value: v })) }],
      },
    });
    return op.name ?? 'execution';
  }
}

/** Emulator: the dev worker script watches for `dispatching` runs and reads the token itself. */
class LocalExecutor implements Executor {
  async start(run: { id: string }, env: Record<string, string>) {
    await getFirestore().doc(paths.run(run.id)).update({ localToken: env.DODO_RUN_TOKEN });
    return `local:${run.id}`;
  }
}

export const onRunCreated = onDocumentCreated(
  { document: 'runs/{runId}', serviceAccount: GATEWAY_SA },
  async (event) => {
    const deps = controlDeps();
    const result = await dispatch(
      {
        ...deps,
        executor: isEmulator ? new LocalExecutor() : new CloudRunExecutor(),
        log: logger.warn,
      },
      event.params.runId,
    );
    logger.info('dispatch', { runId: event.params.runId, result });
  },
);

/* --------------------------- kill switch ------------------------- */

export const killSwitch = onMessagePublished(
  { topic: 'billing-alerts', retry: true, maxInstances: 1, serviceAccount: 'dodo-killswitch@' },
  async (event) => {
    let message: ReturnType<typeof parseMessage>;
    try {
      message = parseMessage(event.data.message.json);
    } catch (err) {
      // Retrying a malformed message would never succeed; log it and stop.
      logger.error('Ignoring malformed kill switch message', { err: String(err) });
      return;
    }
    const db = getFirestore();
    const billing = new CloudBillingClient();
    const projectName = `projects/${projectId()}`;
    const settingsRef = db.doc(paths.settings());

    await handleMessage(
      message,
      { haltAt: HALT_AT.value(), detachAt: DETACH_AT.value(), currency: CURRENCY.value() },
      {
        isHalted: async () => (await settingsRef.get()).get('halted') === true,
        halt: async (reason) => {
          await settingsRef.set(
            { halted: true, haltReason: reason, haltedAt: Date.now() },
            { merge: true },
          );
        },
        cancelRunningExecutions: async () => {
          const runs = new ExecutionsClient();
          const parent = `projects/${projectId()}/locations/${REGION}/jobs/${WORKER_JOB}`;
          let cancelled = 0;
          try {
            for await (const execution of runs.listExecutionsAsync({ parent })) {
              const running = !execution.completionTime;
              if (running && execution.name) {
                await runs.cancelExecution({ name: execution.name });
                cancelled++;
              }
            }
          } catch (err) {
            // NOT_FOUND: the worker job does not exist yet. Nothing to cancel.
            if ((err as { code?: number }).code !== 5) throw err;
          }
          return cancelled;
        },
        isBillingEnabled: async () => {
          const [info] = await billing.getProjectBillingInfo({ name: projectName });
          return info.billingEnabled === true;
        },
        detachBilling: async () => {
          await billing.updateProjectBillingInfo({
            name: projectName,
            projectBillingInfo: { billingAccountName: '' },
          });
        },
        log: (message, data) => logger.warn(message, data),
      },
    );
  },
);
