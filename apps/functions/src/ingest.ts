import { createHash, randomBytes } from 'node:crypto';
import {
  ApiToken,
  CreateApiTokenRequest,
  IngestMessage,
  IngestTaskRequest,
  type IngestTaskResponse,
  IngestTaskUpdate,
  type IngestTaskView,
  type InputRequest,
  paths,
  type Task,
  type TaskSourceKind,
} from '@dodo/core';
import type { Firestore } from 'firebase-admin/firestore';
import { stripUndefined } from './runtime.js';

/**
 * The task ingest API (ARCHITECTURE.md §6.5): the one way pipelines outside the task app put
 * tasks on the board and follow up on them. `taskApi` serves it over HTTP with a token per
 * source; Jobs call the same functions in-process. Ingested tasks start with AI off and the
 * `untrusted` profile, so nothing a source sends can start or steer an agent by itself.
 */
export interface IngestDeps {
  db: Firestore;
  now?: () => number;
}

const OPEN: Task['status'][] = ['backlog', 'todo', 'in_progress', 'needs_input', 'review'];
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const ingestKeyId = (kind: TaskSourceKind, key: string) => sha256(`${kind}\n${key}`);

export class IngestError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 429,
    message: string,
  ) {
    super(message);
  }
}

/** Creates the task, or returns the one this source already made for the same key. */
export async function ingestTask(deps: IngestDeps, input: unknown): Promise<IngestTaskResponse> {
  const parsed = IngestTaskRequest.safeParse(input);
  if (!parsed.success) throw new IngestError(400, parsed.error.message);
  const req = parsed.data;
  const now = (deps.now ?? Date.now)();
  const db = deps.db;
  const keyRef = db.doc(paths.ingestKey(ingestKeyId(req.source.kind, req.idempotencyKey)));
  return db.runTransaction(async (t) => {
    const key = await t.get(keyRef);
    const existingId = key.get('taskId') as string | undefined;
    if (existingId && (await t.get(db.doc(paths.task(existingId)))).exists) {
      return { taskId: existingId, created: false };
    }
    const projectOk = req.projectId
      ? (await t.get(db.doc(paths.project(req.projectId)))).exists
      : false;
    const ref = db.collection(paths.tasks()).doc();
    const task: Omit<Task, 'id'> = {
      title: req.title,
      titleSource: 'user',
      description: req.description,
      status: req.status ?? 'todo',
      priority: req.priority,
      dueDate: req.dueDate,
      tags: [...new Set(req.tags)],
      projectId: projectOk ? req.projectId : undefined,
      ai: { enabled: false, profile: 'untrusted' },
      summary: '',
      externalRefs: req.source.ref ? { [req.source.kind]: req.source.ref } : {},
      source: stripUndefined(req.source),
      createdAt: now,
      updatedAt: now,
    };
    t.create(ref, stripUndefined(task));
    t.set(keyRef, {
      taskId: ref.id,
      source: req.source.kind,
      key: req.idempotencyKey.slice(0, 500),
      createdAt: now,
    });
    return { taskId: ref.id, created: true };
  });
}

async function loadIngested(deps: IngestDeps, taskId: string, kind?: TaskSourceKind) {
  const ref = deps.db.doc(paths.task(taskId));
  const snap = await ref.get();
  const task = snap.data() as Task | undefined;
  // Only tasks a source created can be changed through the API, and only by that source.
  if (!task?.source || (kind && task.source.kind !== kind)) {
    throw new IngestError(404, 'Unknown task');
  }
  return { ref, task: { ...task, id: snap.id } };
}

export async function getIngestedTask(
  deps: IngestDeps,
  taskId: string,
  kind?: TaskSourceKind,
): Promise<IngestTaskView> {
  return view((await loadIngested(deps, taskId, kind)).task);
}

export async function updateIngestedTask(
  deps: IngestDeps,
  taskId: string,
  input: unknown,
  kind?: TaskSourceKind,
): Promise<void> {
  const parsed = IngestTaskUpdate.safeParse(input);
  if (!parsed.success) throw new IngestError(400, parsed.error.message);
  const { ref } = await loadIngested(deps, taskId, kind);
  await ref.update(stripUndefined({ ...parsed.data, updatedAt: (deps.now ?? Date.now)() }));
}

/**
 * A message in the task thread from the source. Jobs may attach an approval card (`input`)
 * with a server-side `action`; the HTTP API only posts plain messages.
 */
export async function postIngestMessage(
  deps: IngestDeps,
  taskId: string,
  input: unknown,
  opts: {
    kind?: TaskSourceKind;
    input?: Omit<InputRequest, 'answer'>;
    action?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const parsed = IngestMessage.safeParse(input);
  if (!parsed.success) throw new IngestError(400, parsed.error.message);
  const { ref } = await loadIngested(deps, taskId, opts.kind);
  const now = (deps.now ?? Date.now)();
  const msg = await deps.db.collection(paths.messages(taskId)).add(
    JSON.parse(
      JSON.stringify({
        author: 'system',
        body: parsed.data.body,
        input: opts.input,
        action: opts.action,
        createdAt: now,
      }),
    ),
  );
  await ref.update({ updatedAt: now });
  return msg.id;
}

/** Tasks a source created, most recently updated first. */
export async function listIngestedTasks(
  deps: IngestDeps,
  opts: { kind?: TaskSourceKind; open?: boolean; limit?: number } = {},
): Promise<IngestTaskView[]> {
  // An equality filter only, so no composite index; sorted here (personal scale).
  const q = opts.kind
    ? deps.db.collection(paths.tasks()).where('source.kind', '==', opts.kind)
    : deps.db
        .collection(paths.tasks())
        .where('source.kind', 'in', ['gmail', 'whatsapp', 'calendar', 'api']);
  const snap = await q.limit(1000).get();
  return snap.docs
    .map((d) => ({ ...(d.data() as Task), id: d.id }))
    .filter((t) => !opts.open || OPEN.includes(t.status))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, Math.min(opts.limit ?? 50, 200))
    .map(view);
}

function view(t: Task): IngestTaskView {
  return stripUndefined({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    dueDate: t.dueDate,
    tags: t.tags ?? [],
    source: t.source,
    updatedAt: t.updatedAt,
  });
}

/**
 * Open tasks of any origin whose title shares words with the query: read-only, in-process
 * only (Jobs use it to find the task a thread is about). Not exposed over HTTP.
 */
export async function searchOpenTasks(
  deps: IngestDeps,
  query: string,
  limit = 10,
): Promise<IngestTaskView[]> {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2);
  if (!words.length) return [];
  const snap = await deps.db.collection(paths.tasks()).where('status', 'in', OPEN).limit(500).get();
  return snap.docs
    .map((d) => ({ ...(d.data() as Task), id: d.id }))
    .map((t) => ({ t, score: words.filter((w) => t.title?.toLowerCase().includes(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.t.updatedAt - a.t.updatedAt)
    .slice(0, limit)
    .map((x) => view(x.t));
}

/**
 * Moves the server-side `action` on an approval card from one of `from` to `to`, at most once
 * (a transaction), optionally answering the card. Only system messages carry actions; the
 * owner can answer cards but cannot write `action` (firestore.rules).
 */
export async function transitionMessageAction(
  deps: IngestDeps,
  taskId: string,
  messageId: string,
  from: string[],
  to: string,
  patch: Record<string, unknown> = {},
  answer?: string,
): Promise<Record<string, unknown> | undefined> {
  const ref = deps.db.doc(`${paths.messages(taskId)}/${messageId}`);
  const now = (deps.now ?? Date.now)();
  return deps.db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    const action = snap.get('action') as Record<string, unknown> | undefined;
    if (!snap.exists || snap.get('author') !== 'system' || !action) return undefined;
    if (!from.includes(String(action.state))) return undefined;
    const update: Record<string, unknown> = {
      action: JSON.parse(JSON.stringify({ ...action, ...patch, state: to, updatedAt: now })),
    };
    if (answer && !snap.get('input.answer')) {
      update['input.answer'] = { value: answer, answeredAt: now, via: 'system' };
    }
    t.update(ref, update);
    return action;
  });
}

/* ------------------------------ tokens ------------------------------ */

const RATE_PER_HOUR = 120;

/** Returns the token once; only its hash is kept (the hash is also the document id). */
export async function createApiToken(
  deps: IngestDeps,
  input: unknown,
): Promise<{ id: string; token: string }> {
  const parsed = CreateApiTokenRequest.safeParse(input);
  if (!parsed.success) throw new IngestError(400, parsed.error.message);
  const token = `dodo_${randomBytes(24).toString('base64url')}`;
  const hash = sha256(token);
  const doc: Omit<ApiToken, 'id'> = {
    name: parsed.data.name,
    source: parsed.data.source,
    prefix: token.slice(0, 10),
    hash,
    revoked: false,
    createdAt: (deps.now ?? Date.now)(),
  };
  await deps.db.doc(paths.apiToken(hash)).create(doc);
  return { id: hash, token };
}

/** Checks the bearer token and counts the call against its hourly limit. */
export async function authenticate(
  deps: IngestDeps,
  authorization: string | undefined,
): Promise<ApiToken> {
  const m = /^Bearer\s+(dodo_[\w-]{20,})$/.exec(authorization?.trim() ?? '');
  if (!m) throw new IngestError(401, 'Missing or malformed bearer token');
  const ref = deps.db.doc(paths.apiToken(sha256(m[1] as string)));
  const now = (deps.now ?? Date.now)();
  const hour = Math.floor(now / 3_600_000);
  return deps.db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    const parsed = ApiToken.safeParse({ id: snap.id, ...snap.data() });
    if (!snap.exists || !parsed.success || parsed.data.revoked) {
      throw new IngestError(401, 'Unknown or revoked token');
    }
    const used = snap.get('window.hour') === hour ? Number(snap.get('window.count') ?? 0) : 0;
    if (used >= RATE_PER_HOUR) throw new IngestError(429, 'Rate limit: try again next hour');
    t.update(ref, { window: { hour, count: used + 1 }, lastUsedAt: now });
    return parsed.data;
  });
}

/* ------------------------------- HTTP ------------------------------- */

export interface ApiRequest {
  method: string;
  path: string;
  query: Record<string, unknown>;
  authorization?: string;
  body: unknown;
}

/**
 *   POST  /v1/tasks                 create (idempotent per source + idempotencyKey)
 *   GET   /v1/tasks?open=true       list this source's tasks
 *   GET   /v1/tasks/{id}            one task
 *   PATCH /v1/tasks/{id}            title, status, priority, due date, status line
 *   POST  /v1/tasks/{id}/messages   add a message to the thread
 * The token decides the source: a token for `gmail` can only create and touch gmail tasks.
 */
export async function handleApiRequest(
  deps: IngestDeps,
  req: ApiRequest,
): Promise<{ status: number; body: unknown }> {
  try {
    const token = await authenticate(deps, req.authorization);
    const kind = token.source;
    const parts = req.path.replace(/\/+$/, '').split('/').filter(Boolean);
    if (parts[0] !== 'v1' || parts[1] !== 'tasks') throw new IngestError(404, 'Not found');
    const id = parts[2];
    if (!id && req.method === 'POST') {
      const body = (req.body ?? {}) as { source?: Record<string, unknown> };
      const res = await ingestTask(deps, { ...body, source: { ...body.source, kind } });
      return { status: res.created ? 201 : 200, body: res };
    }
    if (!id && req.method === 'GET') {
      const tasks = await listIngestedTasks(deps, {
        kind,
        open: req.query.open === 'true',
        limit: Number(req.query.limit) || undefined,
      });
      return { status: 200, body: { tasks } };
    }
    if (id && parts.length === 3 && req.method === 'GET') {
      return { status: 200, body: await getIngestedTask(deps, id, kind) };
    }
    if (id && parts.length === 3 && req.method === 'PATCH') {
      await updateIngestedTask(deps, id, req.body, kind);
      return { status: 200, body: { ok: true } };
    }
    if (id && parts[3] === 'messages' && parts.length === 4 && req.method === 'POST') {
      const messageId = await postIngestMessage(deps, id, req.body, { kind });
      return { status: 201, body: { messageId } };
    }
    throw new IngestError(404, 'Not found');
  } catch (err) {
    if (err instanceof IngestError) return { status: err.status, body: { error: err.message } };
    throw err;
  }
}
