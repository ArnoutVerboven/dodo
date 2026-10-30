import { createHash } from 'node:crypto';
import {
  AnswerResolveRequest,
  BrowserStateRequest,
  DeviceClaimRequest,
  DeviceEgressRequest,
  DeviceRegisterRequest,
  DeviceReleaseRequest,
  EmailCodeRequest,
  FinishRequest,
  GenerateRequest,
  GitHubTokenRequest,
  GoogleToolRequest,
  googleOnlyState,
  HeartbeatRequest,
  McpServerIdRequest,
  McpServerSaveRequest,
  NotionConnectRequest,
  NotionToolRequest,
  paths,
  RequestInputRequest,
  SearchRequest,
  SecretAnswerRequest,
  SHARED_GOOGLE_STATE,
  TranscribeRequest,
  VaultDeleteRequest,
  VaultResolveRequest,
} from '@dodo/core';
import { CloudBillingClient } from '@google-cloud/billing';
import { ExecutionsClient, JobsClient } from '@google-cloud/run';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { getStorage } from 'firebase-admin/storage';
import { defineInt, defineString } from 'firebase-functions/params';
import { logger, setGlobalOptions } from 'firebase-functions/v2';
import { onDocumentCreated, onDocumentWritten } from 'firebase-functions/v2/firestore';
import { HttpsError, onCall, onRequest } from 'firebase-functions/v2/https';
import { onMessagePublished } from 'firebase-functions/v2/pubsub';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import {
  firestoreDevKey,
  loadBrowserState,
  onTaskClosed,
  saveBrowserState,
  secretManagerKey,
  taskClosing,
} from './browser-state.js';
import { claimOwnership as claim } from './claim-ownership.js';
import { compactTask } from './compact.js';
import { claimRun, egressCheck, onDeviceChanged, registerDevice, releaseRun } from './devices.js';
import { dispatch, type Executor } from './dispatcher.js';
import { emailCodeForRun } from './email-code.js';
import { DEFAULT_HOURLY_CAP, generateWithBudget } from './gateway.js';
import {
  completeGitHubConnect,
  disconnectGitHub,
  GITHUB_SECRET,
  type GitHubDeps,
  GitHubError,
  openPullRequest,
  runGitHubToken,
  startGitHubConnect,
  syncRepos,
} from './github.js';
import { runGoogleTool } from './google-tools.js';
import { createApiToken, handleApiRequest, IngestError } from './ingest.js';
import {
  completeGoogleConnect,
  disconnectGoogle,
  FirestoreTokenStore,
  gmailFor,
  type JobsShared,
  onReplyAnswered,
  runJob,
  SecretManagerTokenStore,
  startGoogleConnect,
  tick,
} from './jobs.js';
import { handleMessage, parseMessage } from './kill-switch.js';
import { deleteMcpServer, type McpDeps, McpError, refreshMcpServer, saveMcpServer } from './mcp.js';
import {
  FakeProvider,
  type ModelProvider,
  type SearchProvider,
  type TranscribeProvider,
  VertexProvider,
} from './model-provider.js';
import { connectNotion, runNotionTool } from './notion.js';
import { notifyPush, type PushDeps } from './push.js';
import { needsBrowser } from './routing.js';
import {
  finish,
  heartbeat,
  RequestInputError,
  reapIfStale,
  reapStaleRuns,
  requestInput,
  start,
} from './run-control.js';
import { costGateFor, loadRunForCaller, scopesForRun } from './runtime.js';
import { SEARCH_TOOL, searchWithBudget } from './search.js';
import {
  deleteSecretAnswers,
  resolveSecretAnswer,
  SecretAnswerError,
  saveSecretAnswer,
} from './secret-answers.js';
import {
  ackTelegram,
  handleTelegramUpdate,
  notifyTelegram,
  telegramApi,
  telegramUpload,
} from './telegram.js';
import { generateTitle } from './title.js';
import { transcribeWithBudget } from './transcribe.js';
import { onInputAnswered, onTaskChanged, onUserMessage } from './triggers.js';
import {
  deleteVaultEntry,
  firestoreDevStore,
  resolveVaultValue,
  saveVaultEntry,
  secretManagerStore,
  type VaultDeps,
  VaultError,
} from './vault.js';

initializeApp();
setGlobalOptions({ region: 'europe-west1', maxInstances: 2 });

const HALT_AT = defineInt('BUDGET_HALT_AT', { default: 40 });
const DETACH_AT = defineInt('BUDGET_DETACH_AT', { default: 45 });
const CURRENCY = defineString('BUDGET_CURRENCY', { default: 'EUR' });
const OWNER_EMAIL = defineString('OWNER_EMAIL', { default: '' });
/** `fake` runs the scripted model (emulator, tests); anything else uses Vertex AI. */
const MODEL_BACKEND = defineString('MODEL_BACKEND', { default: 'vertex' });
/** Vertex endpoint for Gemini. `global` serves every current model and is ~10% cheaper than a
 * region; set a region (e.g. europe-west4) only if EU-only processing matters more. */
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'global';
const TELEGRAM_BOT_TOKEN = defineString('TELEGRAM_BOT_TOKEN', { default: '' });
const APP_URL = defineString('APP_URL', { default: 'https://dodo-app.web.app' });
/** The API-restricted worker key (Terraform), handed to a Mac when it pairs. */
const DEVICE_API_KEY = defineString('DEVICE_API_KEY', { default: '' });
/** Google OAuth client for Jobs (Gmail, Calendar); empty until set up (docs/JOBS.md). */
const GOOGLE_OAUTH_CLIENT_ID = defineString('GOOGLE_OAUTH_CLIENT_ID', { default: '' });
const GOOGLE_OAUTH_CLIENT_SECRET = defineString('GOOGLE_OAUTH_CLIENT_SECRET', { default: '' });
const REGION = 'europe-west1';
const JOBS_SA = 'dodo-jobs@';
/**
 * Cloud Scheduler needs the full address: the Firebase CLI expands the `name@` shorthand for
 * the function itself but passes it to the scheduler job unchanged, which rejects it (400).
 * The CLI sets GCLOUD_PROJECT while it loads the code for deploy.
 */
const PROJECT_ID = process.env.GCLOUD_PROJECT ?? process.env.GCP_PROJECT ?? '';
const JOBS_SA_EMAIL = PROJECT_ID ? `dodo-jobs@${PROJECT_ID}.iam.gserviceaccount.com` : JOBS_SA;
const WORKER_JOB = 'dodo-worker';
/** Same worker with headless Chromium and more memory; runs that want a browser go here. */
const WORKER_BROWSER_JOB = 'dodo-worker-browser';
const GATEWAY_SA = 'dodo-gateway@';
const GATEWAY_SA_EMAIL = PROJECT_ID
  ? `dodo-gateway@${PROJECT_ID}.iam.gserviceaccount.com`
  : GATEWAY_SA;
const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true';

const webhookSecret = (token: string) =>
  createHash('sha256').update(`dodo-webhook:${token}`).digest('hex').slice(0, 64);

const projectId = () => {
  const id = process.env.GCLOUD_PROJECT ?? process.env.GCP_PROJECT;
  if (!id) throw new Error('Project id not available');
  return id;
};

let providerInstance: (ModelProvider & SearchProvider & TranscribeProvider) | undefined;
const provider = (): ModelProvider & SearchProvider & TranscribeProvider => {
  providerInstance ??=
    MODEL_BACKEND.value() === 'fake' || isEmulator
      ? new FakeProvider()
      : new VertexProvider(projectId(), VERTEX_LOCATION);
  return providerInstance;
};

const telegramDeps = () => {
  const token = TELEGRAM_BOT_TOKEN.value() || undefined;
  return {
    db: getFirestore(),
    token,
    send: token ? telegramApi(token) : async () => undefined,
    upload: token ? telegramUpload(token) : undefined,
    saveSecret: (req: Parameters<typeof saveSecretAnswer>[1]) =>
      saveSecretAnswer(secretAnswerDeps(), req),
    log: logger.warn,
  };
};

const pushDeps = (): PushDeps => ({
  db: getFirestore(),
  send: async (messages) => {
    const res = await getMessaging().sendEach(messages);
    return res.responses.map((r) => ({
      success: r.success,
      error: r.error ? { code: r.error.code } : undefined,
    }));
  },
  log: logger.warn,
});

const controlDeps = () => {
  const db = getFirestore();
  return {
    db,
    auth: getAuth(),
    storage: getStorage(),
    costGate: costGateFor(db),
    log: logger.warn,
    mcpSecrets: vaultDeps().secrets,
    notify: async (n: Omit<Parameters<typeof notifyTelegram>[1], 'appUrl'>) => {
      const full = { ...n, appUrl: APP_URL.value() };
      await Promise.all([notifyTelegram(telegramDeps(), full), notifyPush(pushDeps(), full)]).catch(
        (err) => logger.warn('notify failed', { err: String(err) }),
      );
    },
    ackTelegram: (taskId: string) => ackTelegram(telegramDeps(), taskId),
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
    try {
      return await generateWithBudget(
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
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      // A provider failure would otherwise reach the worker as a bare INTERNAL [500]; the
      // message is what you need to see on the run.
      logger.error('gateway failed', { runId: run.id, model: req.model, err: String(err) });
      throw new HttpsError('unknown', `Model call failed: ${String(err).slice(0, 500)}`);
    }
  },
);

/** The web_search tool: a grounded Gemini call, charged per query to the run's budgets. */
export const gatewaySearch = onCall(
  { serviceAccount: GATEWAY_SA, memory: '512MiB', timeoutSeconds: 120, maxInstances: 5 },
  async (request) => {
    const req = parseOr<SearchRequest>(SearchRequest, request.data);
    const db = getFirestore();
    const run = await loadRunForCaller(db, caller(request.auth), req.runId);
    try {
      return await searchWithBudget(
        { db, costGate: costGateFor(db), provider: provider(), hourlyCap: DEFAULT_HOURLY_CAP },
        {
          scopes: scopesForRun(run),
          taskId: run.taskId,
          projectId: run.projectId,
          runId: run.id,
          description: `${SEARCH_TOOL}: ${req.query.slice(0, 120)}`,
        },
        req.query,
      );
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      logger.error('search failed', { runId: run.id, err: String(err) });
      throw new HttpsError('unknown', `Search failed: ${String(err).slice(0, 500)}`);
    }
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
    const { messageId } = await requestInput(deps, run, req).catch((err: Error) => {
      if (err instanceof RequestInputError) throw new HttpsError('invalid-argument', err.message);
      throw err;
    });
    return { ok: true, messageId };
  },
);

/** The remote browser's logins for the run's task: restored at start, kept at the end. */
const browserStateDeps = () => ({
  storage: getStorage(),
  key: browserKey(),
  log: logger.warn,
});

let browserKeyFn: (() => Promise<Buffer>) | undefined;
/** The browser-state key, also used for secret answers; cached per instance. */
function browserKey(): () => Promise<Buffer> {
  browserKeyFn ??= isEmulator ? firestoreDevKey(getFirestore()) : secretManagerKey(projectId());
  return browserKeyFn;
}

function secretAnswerDeps() {
  return { db: getFirestore(), key: browserKey(), log: logger.warn };
}

const secretAnswerCall = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SecretAnswerError) throw new HttpsError(err.code, err.message);
    throw err;
  }
};

/** The app answers a secret question (an MFA code): stored apart, the thread gets a reference. */
export const answerSecret = onCall(
  { serviceAccount: GATEWAY_SA, maxInstances: 2 },
  async (request) => {
    ownerOnly(request.auth);
    const req = parseOr<SecretAnswerRequest>(SecretAnswerRequest, request.data);
    await secretAnswerCall(() => saveSecretAnswer(secretAnswerDeps(), req));
    return { ok: true };
  },
);

/** A run's browser tool gets the value behind `{{answer:<id>}}` (only a run on that task). */
export const runSecretAnswer = onCall(
  { serviceAccount: GATEWAY_SA, maxInstances: 2 },
  async (request) => {
    const req = parseOr<AnswerResolveRequest>(AnswerResolveRequest, request.data);
    const c = caller(request.auth);
    // The owner's own account is not a run: values never go back to a browser session.
    if (!c || c.claims.run !== req.runId) throw new HttpsError('permission-denied', 'Runs only');
    const run = await loadRunForCaller(getFirestore(), c, req.runId);
    return secretAnswerCall(() => resolveSecretAnswer(secretAnswerDeps(), run, req.messageId));
  },
);

export const runBrowserState = onCall(
  { serviceAccount: GATEWAY_SA, memory: '512MiB', maxInstances: 5 },
  async (request) => {
    const req = parseOr<BrowserStateRequest>(BrowserStateRequest, request.data);
    const run = await loadRunForCaller(getFirestore(), caller(request.auth), req.runId);
    const deps = browserStateDeps();
    if (req.action === 'get') {
      const stored = await loadBrowserState(deps, run.taskId);
      return { ok: true, state: stored?.state, lastUrl: stored?.lastUrl };
    }
    // The user's shared Google session: any run may load it on demand, and only Google's
    // cookies are ever kept in it, whatever the run sends.
    // Only a run with the remote browser has a use for the Google cookies.
    if ((req.action === 'google-get' || req.action === 'google-put') && !run.browser) {
      throw new HttpsError('permission-denied', 'Only a run with the remote browser');
    }
    if (req.action === 'google-get') {
      const stored = await loadBrowserState(deps, SHARED_GOOGLE_STATE);
      return { ok: true, state: stored?.state };
    }
    if (req.action === 'google-put') {
      const google = req.state ? googleOnlyState(req.state) : undefined;
      if (!google) return { ok: true };
      await saveBrowserState(deps, SHARED_GOOGLE_STATE, { state: google });
      logger.info('shared google session saved', { runId: run.id, taskId: run.taskId });
      return { ok: true };
    }
    if (!req.state) throw new HttpsError('invalid-argument', 'put needs a state');
    await saveBrowserState(deps, run.taskId, { state: req.state, lastUrl: req.lastUrl });
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

/* ----------------------------- devices --------------------------- */

const deviceDeps = () => ({
  db: getFirestore(),
  auth: getAuth(),
  log: logger.info,
  clientConfig:
    !isEmulator && DEVICE_API_KEY.value()
      ? { apiKey: DEVICE_API_KEY.value(), projectId: projectId() }
      : undefined,
});

/** `dodo login <code>`: unauthenticated on purpose, the single-use code from Settings is the proof. */
export const deviceRegister = onCall(
  { serviceAccount: GATEWAY_SA, maxInstances: 1 },
  async (request) => {
    const req = parseOr<DeviceRegisterRequest>(DeviceRegisterRequest, request.data);
    return registerDevice(deviceDeps(), req);
  },
);

/** The daemon takes a queued run addressed to it and gets the run's own identity back. */
export const deviceClaim = onCall(
  { serviceAccount: GATEWAY_SA, maxInstances: 5 },
  async (request) => {
    const req = parseOr<DeviceClaimRequest>(DeviceClaimRequest, request.data);
    return claimRun(deviceDeps(), caller(request.auth), req);
  },
);

/** The Mac sandbox asks before it lets a run reach a host its base allowlist does not cover. */
export const deviceEgress = onCall(
  { serviceAccount: GATEWAY_SA, maxInstances: 5 },
  async (request) => {
    const req = parseOr<DeviceEgressRequest>(DeviceEgressRequest, request.data);
    return egressCheck(deviceDeps(), caller(request.auth), req);
  },
);

/** The daemon's worker exited without reporting: the run ends as failed instead of lingering. */
export const deviceRelease = onCall(
  { serviceAccount: GATEWAY_SA, memory: '512MiB', maxInstances: 5 },
  async (request) => {
    const req = parseOr<DeviceReleaseRequest>(DeviceReleaseRequest, request.data);
    const deps = controlDeps();
    return releaseRun(deps, caller(request.auth), req, (run, error) =>
      finish(deps, run, { reason: 'error', error, session: [] }),
    );
  },
);

export const onDeviceWritten = onDocumentWritten(
  { document: 'devices/{deviceId}', serviceAccount: GATEWAY_SA },
  async (event) => {
    const before = event.data?.before.exists ? event.data.before.data() : undefined;
    const after = event.data?.after.exists ? event.data.after.data() : undefined;
    await onDeviceChanged(
      deviceDeps(),
      event.params.deviceId,
      before as { state: 'approved' | 'revoked' } | undefined,
      after as { state: 'approved' | 'revoked' } | undefined,
    );
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
    await onTaskChanged(triggerDeps(db), before as any, after as any);
    await onTaskClosed(
      browserStateDeps(),
      event.params.taskId,
      before as { status?: string } | undefined,
      after as { status?: string } | undefined,
    );
    if (taskClosing(before as { status?: string }, after as { status?: string })) {
      await deleteSecretAnswers({ db }, event.params.taskId).catch((err) =>
        logger.warn('secret answers delete failed', { err: String(err) }),
      );
    }
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
      ...triggerDeps(db),
      reap: (runId: string) => reapIfStale(controlDeps(), runId),
    };
    if (!before) {
      await onUserMessage(
        deps,
        event.params.taskId,
        after as { author: string; input?: unknown; body?: string },
      );
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

/** Run triggers: the browser router (a small model call) is only used for `auto` on a new task. */
const triggerDeps = (db: Firestore) => ({
  db,
  log: logger.info,
  needsBrowser: (task: Parameters<typeof needsBrowser>[1]) =>
    needsBrowser(
      { db, costGate: costGateFor(db), provider: provider(), hourlyCap: DEFAULT_HOURLY_CAP },
      task,
    ),
});

/** Cloud Run Jobs executor: one execution per run, env carries the run identity. */
class CloudRunExecutor implements Executor {
  async start(run: { browser?: boolean }, env: Record<string, string>, timeoutSeconds: number) {
    const jobs = new JobsClient();
    const job = run.browser ? WORKER_BROWSER_JOB : WORKER_JOB;
    const name = `projects/${projectId()}/locations/${REGION}/jobs/${job}`;
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

/** Task view › Compact: summarise the conversation now, or at a working run's next step. */
export const taskCompact = onCall(
  { serviceAccount: GATEWAY_SA, memory: '512MiB', timeoutSeconds: 300, maxInstances: 2 },
  async (request) => {
    ownerOnly(request.auth);
    const { taskId } = (request.data ?? {}) as { taskId?: string };
    if (typeof taskId !== 'string' || !taskId) throw new HttpsError('invalid-argument', 'taskId');
    const db = getFirestore();
    return compactTask(
      {
        gateway: {
          db,
          costGate: costGateFor(db),
          provider: provider(),
          hourlyCap: DEFAULT_HOURLY_CAP,
        },
        storage: getStorage(),
      },
      taskId,
    );
  },
);

/** Push-to-talk in the web app: a voice note to text, charged to the month, not a task. */
export const transcribe = onCall(
  { serviceAccount: GATEWAY_SA, memory: '512MiB', timeoutSeconds: 120, maxInstances: 2 },
  async (request) => {
    ownerOnly(request.auth);
    const req = parseOr<TranscribeRequest>(TranscribeRequest, request.data);
    const db = getFirestore();
    try {
      return await transcribeWithBudget(
        { db, costGate: costGateFor(db), provider: provider(), hourlyCap: DEFAULT_HOURLY_CAP },
        req,
      );
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      logger.error('transcribe failed', { mimeType: req.mimeType, err: String(err) });
      throw new HttpsError('unknown', `Transcription failed: ${String(err).slice(0, 300)}`);
    }
  },
);

/* ---------------------------- task API --------------------------- */

/** The task ingest API (docs/JOBS.md §4): token per source, checked before any other work. */
export const taskApi = onRequest(
  { maxInstances: 2, invoker: 'public', serviceAccount: GATEWAY_SA, timeoutSeconds: 30 },
  async (req, res) => {
    try {
      const out = await handleApiRequest(
        { db: getFirestore() },
        {
          method: req.method,
          path: req.path,
          query: req.query as Record<string, unknown>,
          authorization: req.get('authorization'),
          body: req.body,
        },
      );
      res.status(out.status).json(out.body);
    } catch (err) {
      logger.error('taskApi failed', { err: String(err) });
      res.status(500).json({ error: 'internal' });
    }
  },
);

/** Settings › Task API: a new token, shown once. */
export const apiTokenCreate = onCall(
  { serviceAccount: GATEWAY_SA, maxInstances: 1 },
  async (request) => {
    if (request.auth?.token.dodo_owner !== true) {
      throw new HttpsError('permission-denied', 'Owner only');
    }
    try {
      return await createApiToken({ db: getFirestore() }, request.data);
    } catch (err) {
      if (err instanceof IngestError) throw new HttpsError('invalid-argument', err.message);
      throw err;
    }
  },
);

/* ----------------------------- vault ----------------------------- */

const vaultDeps = (): VaultDeps => {
  const db = getFirestore();
  return {
    db,
    secrets: isEmulator ? firestoreDevStore(db) : secretManagerStore(projectId()),
    log: logger.info,
  };
};

/* ------------------------------ jobs ----------------------------- */

const jobsShared = (): JobsShared => {
  const db = getFirestore();
  const id = GOOGLE_OAUTH_CLIENT_ID.value();
  const secret = GOOGLE_OAUTH_CLIENT_SECRET.value();
  const callback = isEmulator
    ? `http://127.0.0.1:5001/${projectId()}/${REGION}/jobsGoogleCallback`
    : `https://${REGION}-${projectId()}.cloudfunctions.net/jobsGoogleCallback`;
  return {
    db,
    gateway: () => ({
      db,
      costGate: costGateFor(db),
      provider: provider(),
      hourlyCap: DEFAULT_HOURLY_CAP,
    }),
    tokens: isEmulator ? new FirestoreTokenStore(db) : new SecretManagerTokenStore(projectId()),
    oauth: () =>
      id && secret ? { clientId: id, clientSecret: secret, redirectUri: callback } : undefined,
    notify: (n) => controlDeps().notify(n),
    appUrl: () => (isEmulator ? 'http://localhost:5173' : APP_URL.value()),
    log: (message, data) => logger.info(message, data),
  };
};

const ownerOnly = (auth: { token: Record<string, unknown> } | undefined) => {
  if (auth?.token.dodo_owner !== true) throw new HttpsError('permission-denied', 'Owner only');
};

const vaultCall = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof VaultError) throw new HttpsError(err.code, err.message);
    throw err;
  }
};

/** Settings › Vault: values go in, never come back out to the browser. */
export const vaultSave = onCall(
  { serviceAccount: GATEWAY_SA, maxInstances: 1 },
  async (request) => {
    ownerOnly(request.auth);
    return vaultCall(() => saveVaultEntry(vaultDeps(), request.data));
  },
);

export const vaultDelete = onCall(
  { serviceAccount: GATEWAY_SA, maxInstances: 1 },
  async (request) => {
    ownerOnly(request.auth);
    const { id } = parseOr<{ id: string }>(VaultDeleteRequest, request.data);
    await vaultCall(() => deleteVaultEntry(vaultDeps(), id));
    return { ok: true };
  },
);

/** A run's browser tool gets one value for the site it types it into (only the run itself). */
export const vaultResolve = onCall(
  { serviceAccount: GATEWAY_SA, maxInstances: 2 },
  async (request) => {
    const req = parseOr<VaultResolveRequest>(VaultResolveRequest, request.data);
    const c = caller(request.auth);
    // The owner's own account is not a run: values never go back to a browser session.
    if (!c || c.claims.run !== req.runId) throw new HttpsError('permission-denied', 'Runs only');
    const deps = vaultDeps();
    const run = await loadRunForCaller(deps.db, c, req.runId);
    return vaultCall(() => resolveVaultValue(deps, run, req));
  },
);

/* ------------------------------ tools ---------------------------- */

const mcpDeps = (): McpDeps => ({
  ...vaultDeps(),
  connect: async (url, headers) => {
    const { connectMcp } = await import('@dodo/agent');
    return connectMcp(url, { headers, name: 'dodo-tools' });
  },
});

const mcpCall = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof McpError) throw new HttpsError(err.code, err.message);
    throw err;
  }
};

/** Tools › Add server: a remote MCP server; its header goes to Secret Manager. */
export const mcpServerSave = onCall(
  { serviceAccount: GATEWAY_SA, maxInstances: 1, timeoutSeconds: 60 },
  async (request) => {
    ownerOnly(request.auth);
    const req = parseOr<McpServerSaveRequest>(McpServerSaveRequest, request.data);
    return mcpCall(() => saveMcpServer(mcpDeps(), req));
  },
);

export const mcpServerDelete = onCall(
  { serviceAccount: GATEWAY_SA, maxInstances: 1 },
  async (request) => {
    ownerOnly(request.auth);
    const { id } = parseOr<{ id: string }>(McpServerIdRequest, request.data);
    await mcpCall(() => deleteMcpServer(mcpDeps(), id));
    return { ok: true };
  },
);

/** Tools › Refresh: fetch a remote server's tools now, or ask its Mac to for a local one. */
export const mcpRefresh = onCall(
  { serviceAccount: GATEWAY_SA, maxInstances: 2, timeoutSeconds: 60 },
  async (request) => {
    ownerOnly(request.auth);
    const { id } = parseOr<{ id: string }>(McpServerIdRequest, request.data);
    return mcpCall(() => refreshMcpServer(mcpDeps(), id));
  },
);

/* ----------------------------- Notion ---------------------------- */

/** Settings › Integrations › Notion: check and keep an integration token, or forget it. */
export const notionConnect = onCall(
  { serviceAccount: GATEWAY_SA, maxInstances: 1, timeoutSeconds: 30 },
  async (request) => {
    ownerOnly(request.auth);
    const { token } = parseOr<NotionConnectRequest>(NotionConnectRequest, request.data);
    return connectNotion(vaultDeps(), token);
  },
);

/** The agent's Notion tools: one operation for a run, done here with the token. */
export const notionTool = onCall(
  { serviceAccount: GATEWAY_SA, memory: '512MiB', timeoutSeconds: 120, maxInstances: 5 },
  async (request) => {
    const req = parseOr<NotionToolRequest>(NotionToolRequest, request.data);
    const c = caller(request.auth);
    if (!c || c.claims.run !== req.runId) throw new HttpsError('permission-denied', 'Runs only');
    const deps = vaultDeps();
    const run = await loadRunForCaller(deps.db, c, req.runId);
    return runNotionTool(deps, run, req.call);
  },
);

/* ----------------------------- GitHub ---------------------------- */

const githubDeps = (): GitHubDeps => {
  const db = getFirestore();
  return {
    db,
    secrets: isEmulator
      ? firestoreDevStore(db, 'githubDev/app')
      : secretManagerStore(projectId(), GITHUB_SECRET),
    appUrl: isEmulator ? 'http://localhost:5173' : APP_URL.value(),
    callbackUrl: isEmulator
      ? `http://127.0.0.1:5001/${projectId()}/${REGION}/githubCallback`
      : `https://${REGION}-${projectId()}.cloudfunctions.net/githubCallback`,
    projectId: projectId(),
    log: logger.info,
  };
};

const githubCall = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GitHubError) throw new HttpsError(err.code, err.message);
    logger.error('github call failed', { err: String(err) });
    throw new HttpsError('unknown', String(err).slice(0, 300));
  }
};

/** Settings › GitHub: the manifest to create the app, or the page to install it. */
export const githubConnect = onCall(
  { serviceAccount: GATEWAY_SA, maxInstances: 1 },
  async (request) => {
    ownerOnly(request.auth);
    const { org } = (request.data ?? {}) as { org?: string };
    return githubCall(() => startGitHubConnect(githubDeps(), request.auth?.uid ?? '', org));
  },
);

/** GitHub redirects here after creating the app and after installing it. */
export const githubCallback = onRequest(
  { serviceAccount: GATEWAY_SA, maxInstances: 1, invoker: 'public', timeoutSeconds: 60 },
  async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const target = await completeGitHubConnect(githubDeps(), {
      code: q.code,
      state: q.state,
      installation_id: q.installation_id,
      setup_action: q.setup_action,
    });
    res.redirect(302, target);
  },
);

/** Settings › GitHub: refresh the repo list after you changed it on GitHub. */
export const githubSync = onCall(
  { serviceAccount: GATEWAY_SA, maxInstances: 1 },
  async (request) => {
    ownerOnly(request.auth);
    return githubCall(() => syncRepos(githubDeps()));
  },
);

export const githubDisconnect = onCall(
  { serviceAccount: GATEWAY_SA, maxInstances: 1 },
  async (request) => {
    ownerOnly(request.auth);
    return githubCall(() => disconnectGitHub(githubDeps()));
  },
);

/** A run's token for its own repo: read to clone, write to push after your approval. */
export const githubToken = onCall(
  { serviceAccount: GATEWAY_SA, maxInstances: 5 },
  async (request) => {
    const req = parseOr<GitHubTokenRequest>(GitHubTokenRequest, request.data);
    const c = caller(request.auth);
    if (!c || c.claims.run !== req.runId) throw new HttpsError('permission-denied', 'Runs only');
    const deps = githubDeps();
    const run = await loadRunForCaller(deps.db, c, req.runId);
    return githubCall(() => runGitHubToken(deps, run, req.access, req.repo));
  },
);

/** A run opens a pull request for the branch it pushed (after your approval). */
export const githubOpenPr = onCall(
  { serviceAccount: GATEWAY_SA, maxInstances: 2 },
  async (request) => {
    const data = (request.data ?? {}) as { runId?: string };
    const c = caller(request.auth);
    if (!c || !data.runId || c.claims.run !== data.runId)
      throw new HttpsError('permission-denied', 'Runs only');
    const deps = githubDeps();
    const run = await loadRunForCaller(deps.db, c, data.runId);
    return githubCall(() => openPullRequest(deps, run, data));
  },
);

/**
 * A run's browser tool fetches a sign-in code a site just emailed the user. Runs as the Jobs
 * account, the only one that can read the Gmail token; the code goes to that run only.
 */
export const runEmailCode = onCall(
  { serviceAccount: JOBS_SA, maxInstances: 2 },
  async (request) => {
    const req = parseOr<EmailCodeRequest>(EmailCodeRequest, request.data);
    const c = caller(request.auth);
    if (!c || c.claims.run !== req.runId) throw new HttpsError('permission-denied', 'Runs only');
    const shared = jobsShared();
    const run = await loadRunForCaller(shared.db, c, req.runId);
    return emailCodeForRun({ gmail: () => gmailFor(shared), log: logger.info }, run, req);
  },
);

/**
 * Lease sweep: a run whose worker died (OOM, crash, cancelled execution) is ended as
 * `lease_lost` within minutes, so its task shows what happened without waiting for a new
 * comment. The same check also runs before each enqueue (`reapIfStale`).
 */
export const reapRuns = onSchedule(
  {
    schedule: 'every 5 minutes',
    serviceAccount: GATEWAY_SA_EMAIL,
    timeoutSeconds: 120,
    maxInstances: 1,
    retryCount: 0,
  },
  async () => {
    const reaped = await reapStaleRuns(controlDeps());
    if (reaped.length) logger.info('reaped stale runs', { runs: reaped });
  },
);

/**
 * The agent's Google tools (Gmail, Calendar, Drive): one operation for a run, done here with the
 * Google token. Runs as the Jobs account, the only one that can read that token.
 */
export const googleTool = onCall(
  { serviceAccount: JOBS_SA, memory: '512MiB', timeoutSeconds: 180, maxInstances: 5 },
  async (request) => {
    const req = parseOr<GoogleToolRequest>(GoogleToolRequest, request.data);
    const c = caller(request.auth);
    if (!c || c.claims.run !== req.runId) throw new HttpsError('permission-denied', 'Runs only');
    const shared = jobsShared();
    const run = await loadRunForCaller(shared.db, c, req.runId);
    return runGoogleTool(
      { db: shared.db, oauth: shared.oauth, tokens: shared.tokens, log: shared.log },
      run,
      req.call,
    );
  },
);

/** Runs every enabled job that is due. Each job also has its own lease, budget and caps. */
export const jobsTick = onSchedule(
  {
    schedule: 'every 15 minutes',
    serviceAccount: JOBS_SA_EMAIL,
    timeoutSeconds: 540,
    memory: '512MiB',
    maxInstances: 1,
    retryCount: 0,
  },
  async () => tick(jobsShared()),
);

/** Jobs tab: Run now / Dry run. */
export const jobsRunNow = onCall(
  { serviceAccount: JOBS_SA, timeoutSeconds: 540, memory: '512MiB', maxInstances: 1 },
  async (request) => {
    ownerOnly(request.auth);
    const { jobId, dryRun } = (request.data ?? {}) as { jobId?: string; dryRun?: boolean };
    if (jobId !== 'gmail-followup') throw new HttpsError('invalid-argument', 'Unknown job');
    const run = await runJob(jobsShared(), jobId, 'gmail-followup', 'manual', dryRun === true);
    return { runId: run.id, state: run.state, error: run.error };
  },
);

export const jobsGoogleConnect = onCall(
  { serviceAccount: JOBS_SA, maxInstances: 1 },
  async (request) => {
    ownerOnly(request.auth);
    return startGoogleConnect(jobsShared(), request.auth?.uid ?? '');
  },
);

/** Google's consent screen redirects here; the single-use state proves the flow started in the app. */
export const jobsGoogleCallback = onRequest(
  { serviceAccount: JOBS_SA, maxInstances: 1, invoker: 'public', timeoutSeconds: 30 },
  async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const target = await completeGoogleConnect(jobsShared(), {
      code: q.code,
      state: q.state,
      error: q.error,
    });
    res.redirect(302, target);
  },
);

export const jobsGoogleDisconnect = onCall(
  { serviceAccount: JOBS_SA, maxInstances: 1 },
  async (request) => {
    ownerOnly(request.auth);
    return disconnectGoogle(jobsShared());
  },
);

/** An answered reply card on a job's task: send, rewrite or keep the draft. */
export const jobsOnTaskMessage = onDocumentWritten(
  {
    document: 'tasks/{taskId}/messages/{messageId}',
    serviceAccount: JOBS_SA,
    timeoutSeconds: 120,
    memory: '512MiB',
  },
  async (event) => {
    const before = event.data?.before.exists ? event.data.before.data() : undefined;
    const after = event.data?.after.exists ? event.data.after.data() : undefined;
    await onReplyAnswered(
      jobsShared(),
      event.params.taskId,
      event.params.messageId,
      before,
      after,
    ).catch((err) => logger.error('reply handling failed', { err: String(err) }));
  },
);

/* -------------------------- notifications ------------------------ */

/** Telegram webhook. The secret token in the header is the bot token's hash, set by setWebhook. */
export const telegramWebhook = onRequest(
  { maxInstances: 2, invoker: 'public' },
  async (req, res) => {
    const token = TELEGRAM_BOT_TOKEN.value();
    const expected = token ? webhookSecret(token) : '';
    if (!token || req.get('x-telegram-bot-api-secret-token') !== expected) {
      res.status(403).send('forbidden');
      return;
    }
    try {
      await handleTelegramUpdate(telegramDeps(), req.body ?? {});
    } catch (err) {
      logger.warn('telegram update failed', { err: String(err) });
    }
    res.status(200).send('ok');
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
          let cancelled = 0;
          for (const job of [WORKER_JOB, WORKER_BROWSER_JOB]) {
            const parent = `projects/${projectId()}/locations/${REGION}/jobs/${job}`;
            try {
              for await (const execution of runs.listExecutionsAsync({ parent })) {
                const running = !execution.completionTime;
                if (running && execution.name) {
                  await runs.cancelExecution({ name: execution.name });
                  cancelled++;
                }
              }
            } catch (err) {
              // NOT_FOUND: the job does not exist yet. Nothing to cancel.
              if ((err as { code?: number }).code !== 5) throw err;
            }
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
