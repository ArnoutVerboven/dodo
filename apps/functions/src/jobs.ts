import { randomBytes } from 'node:crypto';
import { scopesForJob } from '@dodo/budget';
import { paths } from '@dodo/core';
import {
  authUrl,
  BudgetStop,
  CalendarClient,
  exchangeCode,
  type Generate,
  GmailClient,
  GoogleSession,
  handleEventAnswer,
  handleReplyAnswer,
  isEventAction,
  isReplyAction,
  type JobKind,
  jobPaths,
  missingScopes,
  type Notifier,
  type OAuthClient,
  revokeToken,
  runGmailJob,
  type TaskSink,
  type UserProfile,
} from '@dodo/jobs';
import { FirestoreJobStore } from '@dodo/jobs/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { type GatewayDeps, generateWithBudget } from './gateway.js';
import {
  getIngestedTask,
  ingestTask,
  postIngestMessage,
  searchOpenTasks,
  transitionMessageAction,
  updateIngestedTask,
} from './ingest.js';

/**
 * Jobs wiring (docs/JOBS.md): the logic lives in packages/jobs; this file connects it to
 * Firestore, the model gateway (charged to the job's own budget), the task ingest API,
 * notifications and the Google token in Secret Manager.
 */

/* ---------------------------- Google token ---------------------------- */

/** Where the Google refresh token lives. Only the dodo-jobs account can read it. */
export interface TokenStore {
  get(): Promise<string | undefined>;
  put(token: string): Promise<void>;
  clear(): Promise<void>;
}

const SECRET = 'dodo-google-token';

async function metadataToken(): Promise<string> {
  const res = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5_000) },
  );
  if (!res.ok) throw new Error(`metadata token: ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** Secret Manager over REST with the function's own identity: no client library to load. */
export class SecretManagerTokenStore implements TokenStore {
  constructor(private readonly projectId: string) {}
  private async call(path: string, init: RequestInit = {}) {
    const res = await fetch(
      `https://secretmanager.googleapis.com/v1/projects/${this.projectId}/secrets/${SECRET}${path}`,
      {
        ...init,
        headers: {
          authorization: `Bearer ${await metadataToken()}`,
          'content-type': 'application/json',
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    return res;
  }
  async get() {
    const res = await this.call('/versions/latest:access');
    if (res.status === 404 || res.status === 400 || res.status === 412) return undefined; // none, or disabled
    if (!res.ok) throw new Error(`Secret Manager access: ${res.status}`);
    const json = (await res.json()) as { payload?: { data?: string } };
    const value = json.payload?.data
      ? Buffer.from(json.payload.data, 'base64').toString('utf8')
      : '';
    return value && value !== 'disconnected' ? value : undefined;
  }
  async put(token: string) {
    const res = await this.call(':addVersion', {
      method: 'POST',
      body: JSON.stringify({ payload: { data: Buffer.from(token, 'utf8').toString('base64') } }),
    });
    if (!res.ok)
      throw new Error(
        `Secret Manager addVersion: ${res.status} ${(await res.text()).slice(0, 200)}`,
      );
    const { name } = (await res.json()) as { name: string };
    await this.destroyOlderThan(name);
  }
  async clear() {
    // A tombstone version, then the old ones go: nothing usable is left.
    await this.put('disconnected');
  }
  /** Keeps only the newest version, so old refresh tokens do not linger (or cost money). */
  private async destroyOlderThan(keep: string) {
    const res = await this.call('/versions?filter=state:ENABLED');
    if (!res.ok) return;
    const { versions = [] } = (await res.json()) as { versions?: Array<{ name: string }> };
    for (const v of versions) {
      if (v.name === keep) continue;
      const id = v.name.split('/').pop();
      await this.call(`/versions/${id}:destroy`, { method: 'POST', body: '{}' }).catch(
        () => undefined,
      );
    }
  }
}

/** Emulator only: a server-only Firestore document (rules deny every client). */
export class FirestoreTokenStore implements TokenStore {
  constructor(private readonly db: Firestore) {}
  async get() {
    return (await this.db.doc(jobPaths.connectorSecret('google')).get()).get('refreshToken') as
      | string
      | undefined;
  }
  async put(token: string) {
    await this.db.doc(jobPaths.connectorSecret('google')).set({ refreshToken: token });
  }
  async clear() {
    await this.db.doc(jobPaths.connectorSecret('google')).delete();
  }
}

/* ------------------------------- wiring ------------------------------- */

export interface JobsShared {
  db: Firestore;
  gateway: () => GatewayDeps;
  tokens: TokenStore;
  oauth: () => OAuthClient | undefined;
  notify: Notifier['notify'];
  appUrl: () => string;
  log: (message: string, data?: Record<string, unknown>) => void;
  fetch?: typeof fetch;
}

/**
 * The shared personal profile (Settings › Personal info, `settings/profile`), read field by
 * field so Jobs do not depend on its full schema.
 */
export async function readProfile(db: Firestore): Promise<UserProfile | undefined> {
  const data = (await db.doc('settings/profile').get()).data();
  if (!data) return undefined;
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
  return { schedulingNotes: str(data.schedulingNotes, 2000), timeZone: str(data.timeZone, 64) };
}

export function taskSink(db: Firestore): TaskSink {
  const deps = { db };
  return {
    create: (req) => ingestTask(deps, req),
    get: (id) => getIngestedTask(deps, id).catch(() => undefined),
    update: (id, u) => updateIngestedTask(deps, id, u),
    post: (id, body, opts) => postIngestMessage(deps, id, { body }, opts),
    search: (q) => searchOpenTasks(deps, q),
    transition: (taskId, messageId, from, to, patch, answer) =>
      transitionMessageAction(deps, taskId, messageId, from, to, patch, answer),
  };
}

/** Model calls for a job: through the gateway, against the job's monthly budget. */
export function jobGenerate(shared: JobsShared, jobId: string): Generate {
  return async (req) => {
    try {
      return await generateWithBudget(
        shared.gateway(),
        { scopes: scopesForJob(jobId, Date.now()), description: `job ${jobId} (${req.model})` },
        req,
      );
    } catch (err) {
      if (err instanceof HttpsError && err.code === 'resource-exhausted') {
        throw new BudgetStop('budget_exhausted');
      }
      if (err instanceof HttpsError && err.code === 'unavailable') throw new BudgetStop('halted');
      throw err;
    }
  };
}

function google(shared: JobsShared) {
  const client = shared.oauth();
  if (!client)
    throw new HttpsError('failed-precondition', 'Google is not configured for this deployment.');
  const session = new GoogleSession(shared.fetch ?? fetch, client, () => shared.tokens.get());
  return { gmail: new GmailClient(session), calendar: new CalendarClient(session) };
}

/** Gmail for a run's emailed sign-in codes; undefined when Google is not configured. */
export function gmailFor(shared: JobsShared): GmailClient | undefined {
  const client = shared.oauth();
  if (!client) return undefined;
  return new GmailClient(
    new GoogleSession(shared.fetch ?? fetch, client, () => shared.tokens.get()),
  );
}

export async function runJob(
  shared: JobsShared,
  jobId: string,
  kind: JobKind,
  trigger: 'schedule' | 'manual',
  dryRun = false,
) {
  if (kind !== 'gmail-followup') throw new HttpsError('unimplemented', `${kind} is not built yet`);
  const { gmail, calendar } = google(shared);
  return runGmailJob(
    {
      store: new FirestoreJobStore(shared.db),
      tasks: taskSink(shared.db),
      gmail,
      calendar,
      generate: jobGenerate(shared, jobId),
      notify: { notify: shared.notify },
      profile: () => readProfile(shared.db),
      ids: () => shared.db.collection(jobPaths.runs()).doc().id,
      log: shared.log,
    },
    { jobId, trigger, dryRun },
  );
}

/** Every 15 minutes: each enabled job that is due runs once (the job decides if it is due). */
export async function tick(shared: JobsShared) {
  const halted = (await shared.db.doc(paths.settings()).get()).get('halted') === true;
  if (halted || !shared.oauth()) return;
  const jobs = await shared.db.collection(jobPaths.jobs()).where('enabled', '==', true).get();
  for (const doc of jobs.docs) {
    const kind = doc.get('kind') as JobKind;
    if (kind !== 'gmail-followup') continue;
    try {
      const run = await runJob(shared, doc.id, kind, 'schedule');
      if (run.state !== 'skipped')
        shared.log('job run', { jobId: doc.id, state: run.state, counts: run.counts });
    } catch (err) {
      shared.log('job tick failed', { jobId: doc.id, err: String(err) });
    }
  }
}

/* ---------------------------- Google OAuth ---------------------------- */

const STATE_TTL_MS = 10 * 60_000;

export async function startGoogleConnect(
  shared: JobsShared,
  uid: string,
): Promise<{ url: string }> {
  const client = shared.oauth();
  if (!client) {
    throw new HttpsError(
      'failed-precondition',
      'Google OAuth is not set up yet: add GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET (docs/JOBS.md).',
    );
  }
  const state = randomBytes(24).toString('base64url');
  await shared.db
    .doc(jobPaths.oauthState(state))
    .set({ uid, provider: 'google', createdAt: Date.now() });
  const current = await new FirestoreJobStore(shared.db).connector('google');
  return { url: authUrl(client, state, current?.email) };
}

/** The consent redirect lands here. Returns where to send the browser next. */
export async function completeGoogleConnect(
  shared: JobsShared,
  q: { code?: string; state?: string; error?: string },
): Promise<string> {
  const back = (result: string) => `${shared.appUrl()}/jobs?google=${encodeURIComponent(result)}`;
  if (!q.state) return back('invalid_state');
  const ref = shared.db.doc(jobPaths.oauthState(q.state));
  // Single use: the state is deleted in the same transaction that reads it.
  const created = await shared.db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) return undefined;
    t.delete(ref);
    return snap.get('createdAt') as number;
  });
  if (!created || Date.now() - created > STATE_TTL_MS) return back('invalid_state');
  if (q.error || !q.code) return back(q.error === 'access_denied' ? 'cancelled' : 'error');
  const client = shared.oauth();
  if (!client) return back('not_configured');
  const store = new FirestoreJobStore(shared.db);
  try {
    const tokens = await exchangeCode(shared.fetch ?? fetch, client, q.code);
    await shared.tokens.put(tokens.refreshToken);
    const missing = missingScopes(tokens.scopes);
    await store.setConnector('google', {
      status: missing.length ? 'missing_scopes' : 'connected',
      email: tokens.email,
      scopes: tokens.scopes,
      missingScopes: missing,
      error: missing.length
        ? 'Some permissions were not granted. Connect again and tick every box.'
        : undefined,
      connectedAt: Date.now(),
      updatedAt: Date.now(),
    });
    return back(missing.length ? 'missing_scopes' : 'connected');
  } catch (err) {
    shared.log('google connect failed', { err: String(err) });
    await store.setConnector('google', {
      status: 'error',
      scopes: [],
      missingScopes: [],
      error: String((err as Error).message).slice(0, 300),
      updatedAt: Date.now(),
    });
    return back('error');
  }
}

export async function disconnectGoogle(shared: JobsShared) {
  const token = await shared.tokens.get().catch(() => undefined);
  if (token) await revokeToken(shared.fetch ?? fetch, token);
  await shared.tokens.clear();
  await new FirestoreJobStore(shared.db).setConnector('google', {
    status: 'disconnected',
    scopes: [],
    missingScopes: [],
    updatedAt: Date.now(),
  });
  return { ok: true };
}

/* --------------------------- reply approvals --------------------------- */

interface MessageData {
  author?: string;
  action?: unknown;
  input?: { answer?: { value?: string; via?: string } };
}

/** You answered a reply card: send, rewrite or keep the draft (packages/jobs/src/replies.ts). */
export async function onReplyAnswered(
  shared: JobsShared,
  taskId: string,
  messageId: string,
  before: MessageData | undefined,
  after: MessageData | undefined,
) {
  if (after?.author !== 'system') return;
  const action = after.action;
  if (!isReplyAction(action) && !isEventAction(action)) return;
  const answer = after.input?.answer;
  if (!answer?.value || before?.input?.answer || answer.via === 'system') return;
  let clients: ReturnType<typeof google>;
  try {
    clients = google(shared);
  } catch (err) {
    await taskSink(shared.db).post(taskId, `Could not act on this: ${(err as Error).message}`);
    return;
  }
  if (isEventAction(action)) {
    const result = await handleEventAnswer(
      {
        tasks: taskSink(shared.db),
        store: new FirestoreJobStore(shared.db),
        calendar: clients.calendar,
      },
      taskId,
      messageId,
      action,
      answer.value,
    );
    shared.log('event answered', { taskId, messageId, result });
    return;
  }
  const gmail = clients.gmail;
  const result = await handleReplyAnswer(
    {
      tasks: taskSink(shared.db),
      store: new FirestoreJobStore(shared.db),
      gmail,
      generate: jobGenerate(shared, action.jobId),
      notify: { notify: shared.notify },
      profile: () => readProfile(shared.db),
    },
    taskId,
    messageId,
    action,
    answer.value,
  );
  shared.log('reply answered', { taskId, messageId, result });
}
