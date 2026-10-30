import { createHash } from 'node:crypto';
import { type Fetch, GoogleApiError, type GoogleSession } from './google.js';

/**
 * Drive and Calendar as the task agent uses them (the `googleTool` callable, apps/functions):
 * plain REST on the same GoogleSession as the Jobs, no SDK.
 */

const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const CALENDAR = 'https://www.googleapis.com/calendar/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,mimeType,modifiedTime,size,webViewLink,parents';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  webViewLink?: string;
  parents?: string[];
}

/** Drive's query language wants `\` and `'` escaped inside a quoted string. */
export const driveQuoted = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** Google's own formats read as text: Docs and Slides as plain text, Sheets as CSV. */
const EXPORT_AS: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
};

/** What an upload becomes when it is converted to Google's own format. */
const CONVERT_TO: Record<string, string> = {
  'text/plain': 'application/vnd.google-apps.document',
  'text/markdown': 'application/vnd.google-apps.document',
  'text/html': 'application/vnd.google-apps.document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'application/vnd.google-apps.document',
  'text/csv': 'application/vnd.google-apps.spreadsheet',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
    'application/vnd.google-apps.spreadsheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    'application/vnd.google-apps.presentation',
};

export const isTextMime = (m: string) =>
  m.startsWith('text/') ||
  /^application\/(json|xml|csv|javascript|x-yaml|yaml|x-sh|sql|ld\+json)/.test(m) ||
  m.endsWith('+json') ||
  m.endsWith('+xml');

export class DriveClient {
  constructor(
    private readonly s: GoogleSession,
    private readonly f: Fetch = fetch,
  ) {}

  /** Raw bytes (downloads and exports): GoogleSession.request only speaks JSON. */
  private async bytes(url: string, max: number): Promise<Buffer> {
    const res = await this.f(url, {
      headers: { authorization: `Bearer ${await this.s.accessToken()}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GoogleApiError(res.status, `Google API ${res.status}: ${text.slice(0, 300)}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > max) throw new GoogleApiError(413, `The file is larger than ${max} bytes`);
    return buf;
  }

  async list(q: string, max: number, ordered: boolean): Promise<DriveFile[]> {
    const params = new URLSearchParams({
      q,
      pageSize: String(max),
      fields: `files(${FILE_FIELDS})`,
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    // Drive refuses an order for full-text queries (they come by relevance).
    if (ordered) params.set('orderBy', 'modifiedTime desc');
    const res = await this.s.request<{ files?: DriveFile[] }>(`${DRIVE}/files?${params}`);
    return res.files ?? [];
  }

  get(id: string): Promise<DriveFile> {
    const q = new URLSearchParams({ fields: FILE_FIELDS, supportsAllDrives: 'true' });
    return this.s.request<DriveFile>(`${DRIVE}/files/${encodeURIComponent(id)}?${q}`);
  }

  /** The folder by name at the top of My Drive, created when it is not there yet. */
  async folder(name: string): Promise<DriveFile> {
    const found = await this.list(
      `name = ${driveQuoted(name)} and mimeType = '${FOLDER_MIME}' and 'root' in parents and trashed = false`,
      1,
      true,
    );
    if (found[0]) return found[0];
    return this.s.request<DriveFile>(`${DRIVE}/files?fields=${FILE_FIELDS}`, {
      method: 'POST',
      body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
    });
  }

  /** Text of a file: Google formats exported, text files as they are; else undefined. */
  async text(file: DriveFile, max: number): Promise<string | undefined> {
    const as = EXPORT_AS[file.mimeType];
    if (as) {
      const q = new URLSearchParams({ mimeType: as });
      const buf = await this.bytes(
        `${DRIVE}/files/${encodeURIComponent(file.id)}/export?${q}`,
        10 * 1024 * 1024,
      );
      return buf.toString('utf8');
    }
    if (!isTextMime(file.mimeType)) return undefined;
    return (await this.download(file.id, max)).toString('utf8');
  }

  download(id: string, max: number): Promise<Buffer> {
    return this.bytes(
      `${DRIVE}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`,
      max,
    );
  }

  /** A new file in `folderId`; `convert` turns text, CSV and Office files into Google's own. */
  create(
    folderId: string,
    name: string,
    mimeType: string,
    data: Buffer,
    convert: boolean,
  ): Promise<DriveFile> {
    const target = convert ? CONVERT_TO[mimeType] : undefined;
    const metadata = {
      name: target ? name.replace(/\.(txt|md|markdown|html?|csv|docx|xlsx|pptx)$/i, '') : name,
      parents: [folderId],
      ...(target ? { mimeType: target } : {}),
    };
    const boundary = `dodo-${createHash('sha1').update(data).digest('hex').slice(0, 16)}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\ncontent-type: ${mimeType}\r\n\r\n`,
      ),
      data,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    return this.s.request<DriveFile>(
      `${UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=${FILE_FIELDS}`,
      {
        method: 'POST',
        headers: { 'content-type': `multipart/related; boundary=${boundary}` },
        body,
        signal: AbortSignal.timeout(120_000),
      },
    );
  }

  /** New content for an existing file (a Google Doc takes text or HTML and converts it). */
  update(id: string, mimeType: string, data: Buffer): Promise<DriveFile> {
    return this.s.request<DriveFile>(
      `${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=media&supportsAllDrives=true&fields=${FILE_FIELDS}`,
      {
        method: 'PATCH',
        headers: { 'content-type': mimeType },
        body: data,
        signal: AbortSignal.timeout(120_000),
      },
    );
  }
}

/* ------------------------------ Calendar ----------------------------- */

export interface CalendarEvent {
  id: string;
  summary?: string;
  location?: string;
  description?: string;
  htmlLink?: string;
  status?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  attendees?: Array<{ email?: string; responseStatus?: string; self?: boolean }>;
  organizer?: { email?: string; self?: boolean };
}

export interface NewAgentEvent {
  title: string;
  start: string;
  end: string;
  timeZone?: string;
  location?: string;
  description?: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

/** One end of an event: a day, or a date-time in the event's time zone. */
export function eventTime(value: string, timeZone: string | undefined) {
  if (DAY.test(value)) return { date: value };
  const v = value.length === 16 ? `${value}:00` : value; // 2026-11-03T10:00
  return timeZone ? { dateTime: v, timeZone } : { dateTime: v };
}

/**
 * A fixed id per run and event, so a retried call returns the event it made instead of a
 * second one. Base32hex allows 0-9 and a-v: hex digits are a subset.
 */
export const agentEventId = (runId: string, e: NewAgentEvent) =>
  createHash('sha256')
    .update(JSON.stringify([runId, e.title, e.start, e.end]))
    .digest('hex')
    .slice(0, 40);

export class AgentCalendar {
  constructor(private readonly s: GoogleSession) {}

  async timeZone(): Promise<string | undefined> {
    return (await this.s.request<{ timeZone?: string }>(`${CALENDAR}/calendars/primary`)).timeZone;
  }

  async list(from: Date, to: Date, q: string | undefined, max: number): Promise<CalendarEvent[]> {
    const params = new URLSearchParams({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: String(max),
    });
    if (q) params.set('q', q);
    const res = await this.s.request<{ items?: CalendarEvent[] }>(
      `${CALENDAR}/calendars/primary/events?${params}`,
    );
    return res.items ?? [];
  }

  /** On the primary calendar, nobody invited, no emails sent. */
  async create(id: string, e: NewAgentEvent): Promise<CalendarEvent> {
    const timed = !DAY.test(e.start);
    // A wall-clock time without an offset is in the calendar's own zone unless one is given.
    const tz =
      timed && !HAS_OFFSET.test(e.start) ? (e.timeZone ?? (await this.timeZone())) : e.timeZone;
    const url = `${CALENDAR}/calendars/primary/events`;
    try {
      return await this.s.request<CalendarEvent>(`${url}?sendUpdates=none`, {
        method: 'POST',
        body: JSON.stringify({
          id,
          summary: e.title,
          location: e.location,
          description: e.description,
          start: eventTime(e.start, tz),
          end: eventTime(e.end, tz),
        }),
      });
    } catch (err) {
      if (!(err instanceof GoogleApiError && err.status === 409)) throw err;
      return this.s.request<CalendarEvent>(`${url}/${encodeURIComponent(id)}`);
    }
  }
}
