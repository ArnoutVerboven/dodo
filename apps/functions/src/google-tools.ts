import {
  DEFAULT_DRIVE_FOLDER,
  DriveFolderName,
  driveFileId,
  GOOGLE_FILE_MAX_BYTES,
  GOOGLE_TEXT_MAX_CHARS,
  type GoogleOp,
  googleClaim,
  hasGoogleScope,
  isApproved,
  paths,
  type Run,
  type RunGoogleAccess,
} from '@dodo/core';
import {
  AgentCalendar,
  agentEventId,
  type CalendarEvent,
  ConnectorStatus,
  DriveClient,
  type DriveFile,
  GmailClient,
  GoogleApiError,
  GoogleAuthError,
  GoogleSession,
  jobPaths,
  type OAuthClient,
  toThread,
} from '@dodo/jobs';
import { matches, parseRule, ruleFor } from '@dodo/policy';
import type { Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import type { TokenStore } from './jobs.js';

/**
 * The agent's Google tools (packages/agent/src/google-tools.ts), run here with the Google
 * refresh token the Jobs use: the worker sends one operation and gets its result, and never
 * holds a Google credential. Runs as the dodo-jobs account, the only one that can read the
 * token. Writes (a calendar event, changing an existing Drive file) are checked against your
 * approval for the task again here, as GitHub pushes are.
 */
export interface GoogleToolDeps {
  db: Firestore;
  oauth: () => OAuthClient | undefined;
  tokens: TokenStore;
  fetch?: typeof fetch;
  now?: () => number;
  /** The connector document; `google` (tests use their own). */
  connectorId?: string;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

const LIVE = new Set(['connected', 'missing_scopes']);

async function connector(db: Firestore, id = 'google'): Promise<ConnectorStatus | undefined> {
  const snap = await db.doc(jobPaths.connector(id)).get();
  if (!snap.exists) return undefined;
  const p = ConnectorStatus.safeParse({ id: snap.id, ...snap.data() });
  return p.success ? p.data : undefined;
}

/** The folder name from Settings › Integrations, or `dodo`. */
export function folderName(settings: Record<string, unknown> | undefined): string {
  const google = (settings?.google ?? {}) as { driveFolder?: unknown };
  const p = DriveFolderName.safeParse(google.driveFolder);
  return p.success ? p.data : DEFAULT_DRIVE_FOLDER;
}

/** What runStart tells a run about Google: absent when it is not connected. */
export async function googleAccessForRun(
  db: Firestore,
  connectorId = 'google',
): Promise<RunGoogleAccess | undefined> {
  const [c, settings] = await Promise.all([
    connector(db, connectorId),
    db.doc(paths.settings()).get(),
  ]);
  if (!c || !LIVE.has(c.status)) return undefined;
  return { email: c.email, scopes: c.scopes, folder: folderName(settings.data()) };
}

/** A write runs only with an allow rule or an answered approval for this exact call. */
export async function googleGranted(
  db: Firestore,
  run: Run,
  tool: string,
  key: string,
): Promise<boolean> {
  const [task, project, settings] = await Promise.all([
    db.doc(paths.task(run.taskId)).get(),
    run.projectId ? db.doc(paths.project(run.projectId)).get() : undefined,
    db.doc(paths.settings()).get(),
  ]);
  const rules = (field: string) =>
    [task.get(field), project?.get(field), settings.get(field)]
      .flatMap((v) => (Array.isArray(v) ? (v as string[]) : []))
      .flatMap((r) => parseRule(r) ?? []);
  if (rules('denyRules').some((r) => matches(r, tool, key))) return false;
  if (rules('allowRules').some((r) => matches(r, tool, key))) return true;
  const approvals = await db
    .collection(paths.messages(run.taskId))
    .where('input.suggestedRule', '==', ruleFor(tool, key))
    .get();
  return approvals.docs.some((d) => {
    const value = d.get('input.answer.value');
    return typeof value === 'string' && isApproved(value);
  });
}

const fileOut = (f: DriveFile, folderId?: string) => ({
  id: f.id,
  name: f.name,
  mimeType: f.mimeType,
  modified: f.modifiedTime,
  size: f.size ? Number(f.size) : undefined,
  url: f.webViewLink,
  ...(folderId ? { inFolder: !!f.parents?.includes(folderId) } : {}),
});

const eventOut = (e: CalendarEvent) => ({
  id: e.id,
  title: e.summary ?? '(no title)',
  start: e.start?.dateTime ?? e.start?.date,
  end: e.end?.dateTime ?? e.end?.date,
  allDay: !!e.start?.date,
  location: e.location,
  description: e.description?.slice(0, 1000),
  url: e.htmlLink,
  ...(e.attendees?.length
    ? {
        attendees: e.attendees.map((a) => a.email).filter(Boolean),
        yourResponse: e.attendees.find((a) => a.self)?.responseStatus,
      }
    : {}),
});

const cut = (text: string, max = GOOGLE_TEXT_MAX_CHARS) =>
  text.length > max
    ? { text: text.slice(0, max), truncated: true, totalChars: text.length }
    : { text };

function bytesOf(data: string): Buffer {
  const buf = Buffer.from(data, 'base64');
  if (buf.length > GOOGLE_FILE_MAX_BYTES)
    throw new HttpsError('invalid-argument', `Files up to ${GOOGLE_FILE_MAX_BYTES} bytes`);
  return buf;
}

/** One operation for a run. Throws HttpsError with a message the agent can act on. */
export async function runGoogleTool(
  deps: GoogleToolDeps,
  run: Run,
  call: GoogleOp,
): Promise<Record<string, unknown>> {
  const client = deps.oauth();
  if (!client) throw new HttpsError('failed-precondition', 'Google is not set up for dodo.');
  const c = await connector(deps.db, deps.connectorId);
  if (!c || !LIVE.has(c.status))
    throw new HttpsError(
      'failed-precondition',
      'Google is not connected. The user can connect it in Settings › Integrations.',
    );
  if (!hasGoogleScope(c.scopes, call.op))
    throw new HttpsError(
      'failed-precondition',
      `The Google connection lacks access for ${call.op}. The user can reconnect Google in Settings › Integrations and tick every box.`,
    );
  const claim = googleClaim(call);
  if (claim.category === 'write' && !(await googleGranted(deps.db, run, claim.tool, claim.key)))
    throw new HttpsError(
      'permission-denied',
      `Not approved for this task: ask for ${ruleFor(claim.tool, claim.key)} first.`,
    );

  const f = deps.fetch ?? fetch;
  const session = new GoogleSession(f, client, () => deps.tokens.get());
  const now = (deps.now ?? Date.now)();
  try {
    return await dispatch(deps, run, call, session, f, now);
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    if (err instanceof GoogleAuthError) {
      if (err.reconnect)
        await deps.db
          .doc(jobPaths.connector(deps.connectorId ?? 'google'))
          .set(
            { status: 'expired', error: 'Google sign-in expired. Connect again.', updatedAt: now },
            { merge: true },
          );
      throw new HttpsError(
        'failed-precondition',
        'The Google sign-in expired. The user can reconnect Google in Settings › Integrations.',
      );
    }
    if (err instanceof GoogleApiError) {
      const code =
        err.status === 404 ? 'not-found' : err.status === 403 ? 'permission-denied' : 'unknown';
      throw new HttpsError(code, err.message.slice(0, 500));
    }
    throw err;
  }
}

async function dispatch(
  deps: GoogleToolDeps,
  run: Run,
  call: GoogleOp,
  session: GoogleSession,
  f: typeof fetch,
  now: number,
): Promise<Record<string, unknown>> {
  switch (call.op) {
    case 'gmail_search': {
      const gmail = new GmailClient(session);
      const threads = await gmail.listThreads(call.query, call.max);
      const found = await Promise.all(
        threads.map(async ({ id }) => {
          const t = toThread(await gmail.getThread(id, 'metadata'));
          const last = t.messages.at(-1);
          return {
            threadId: id,
            subject: t.subject,
            from: last?.from,
            date: last?.date ? new Date(last.date).toISOString() : undefined,
            snippet: last?.text.slice(0, 300),
            messages: t.messages.length,
          };
        }),
      );
      return { threads: found };
    }
    case 'gmail_read_thread': {
      const t = toThread(await new GmailClient(session).getThread(call.threadId, 'full'));
      let room = GOOGLE_TEXT_MAX_CHARS;
      // Newest last; the newest messages keep their full text when the thread is long.
      const messages = t.messages
        .slice()
        .reverse()
        .map((m) => {
          const text = m.text.slice(0, Math.max(0, room));
          room -= text.length;
          return {
            id: m.id,
            from: m.from,
            to: m.to,
            date: new Date(m.date).toISOString(),
            text,
            ...(text.length < m.text.length ? { truncated: true } : {}),
          };
        })
        .reverse();
      return { threadId: t.id, subject: t.subject, messages };
    }
    case 'calendar_list_events': {
      const cal = new AgentCalendar(session);
      const from = call.from ? new Date(call.from) : new Date(now);
      const to = call.to ? new Date(call.to) : new Date(from.getTime() + 14 * 86_400_000);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()))
        throw new HttpsError('invalid-argument', 'from and to are ISO dates or date-times');
      const [events, timeZone] = await Promise.all([
        cal.list(from, to, call.query, call.max),
        cal.timeZone(),
      ]);
      return { timeZone, events: events.filter((e) => e.status !== 'cancelled').map(eventOut) };
    }
    case 'calendar_create_event': {
      const { op: _op, ...event } = call;
      const created = await new AgentCalendar(session).create(agentEventId(run.id, event), event);
      deps.log?.('google event created', { runId: run.id, eventId: created.id });
      return { ok: true, event: eventOut(created) };
    }
    case 'drive_search': {
      const drive = new DriveClient(session, f);
      const folder = await driveFolder(deps, drive);
      const terms = ['trashed = false', `mimeType != 'application/vnd.google-apps.folder'`];
      if (call.text) {
        const q = call.text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        terms.push(`(name contains '${q}' or fullText contains '${q}')`);
      }
      if (call.inFolder) terms.push(`'${folder.id}' in parents`);
      const files = await drive.list(terms.join(' and '), call.max, !call.text);
      return {
        folder: { name: folder.name, url: folder.url },
        files: files.map((x) => fileOut(x, folder.id)),
      };
    }
    case 'drive_read': {
      const drive = new DriveClient(session, f);
      const file = await drive.get(driveFileId(call.fileId));
      const text = await drive.text(file, GOOGLE_FILE_MAX_BYTES);
      if (text === undefined)
        return {
          file: fileOut(file),
          note: `This is a ${file.mimeType} file, not text. Use drive_download to put it in the task folder and read it there (e.g. pdftotext for a PDF).`,
        };
      return { file: fileOut(file), ...cut(text) };
    }
    case 'drive_download': {
      const drive = new DriveClient(session, f);
      const file = await drive.get(driveFileId(call.fileId));
      if (file.mimeType.startsWith('application/vnd.google-apps.')) {
        const text = await drive.text(file, GOOGLE_FILE_MAX_BYTES);
        if (text === undefined)
          throw new HttpsError('invalid-argument', `${file.mimeType} cannot be downloaded`);
        const ext = file.mimeType.endsWith('spreadsheet') ? 'csv' : 'txt';
        return {
          file: fileOut(file),
          name: `${file.name}.${ext}`,
          data: Buffer.from(text, 'utf8').toString('base64'),
        };
      }
      const data = await drive.download(file.id, GOOGLE_FILE_MAX_BYTES);
      return { file: fileOut(file), name: file.name, data: data.toString('base64') };
    }
    case 'drive_save': {
      const drive = new DriveClient(session, f);
      const folder = await driveFolder(deps, drive);
      const file = await drive.create(
        folder.id,
        call.name,
        call.mimeType,
        bytesOf(call.data),
        call.convert,
      );
      deps.log?.('google drive file saved', { runId: run.id, fileId: file.id });
      return { ok: true, file: fileOut(file), folder: { name: folder.name, url: folder.url } };
    }
    case 'drive_update': {
      const drive = new DriveClient(session, f);
      const file = await drive.update(driveFileId(call.fileId), call.mimeType, bytesOf(call.data));
      deps.log?.('google drive file updated', { runId: run.id, fileId: file.id });
      return { ok: true, file: fileOut(file) };
    }
  }
}

/**
 * The Drive folder by the name in Settings, found or created once and remembered on the
 * connector (a renamed setting finds or creates the new one).
 */
async function driveFolder(deps: GoogleToolDeps, drive: DriveClient) {
  const [c, settings] = await Promise.all([
    connector(deps.db, deps.connectorId),
    deps.db.doc(paths.settings()).get(),
  ]);
  const name = folderName(settings.data());
  if (c?.driveFolder?.name === name) return c.driveFolder;
  const folder = await drive.folder(name);
  const saved = {
    name,
    id: folder.id,
    url: folder.webViewLink ?? `https://drive.google.com/drive/folders/${folder.id}`,
  };
  await deps.db
    .doc(jobPaths.connector(deps.connectorId ?? 'google'))
    .set({ driveFolder: saved }, { merge: true });
  return saved;
}
