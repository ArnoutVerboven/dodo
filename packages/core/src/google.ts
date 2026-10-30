import { z } from 'zod';

/**
 * Google for the task agent: Gmail (search, read), Calendar (list, create) and Drive (search,
 * read, download, save, edit), on the same Google connection the Jobs use (Settings ›
 * Integrations, docs/JOBS.md). The refresh token never leaves the control plane: a run sends
 * one operation at a time to the `googleTool` callable, which runs it with the token and
 * returns the result.
 *
 * Saved files go to one Drive folder (Settings › Integrations, `dodo` by default), created on
 * first use; each one is attached to the task as a link.
 */

export const GOOGLE_SCOPE = {
  gmailRead: 'https://www.googleapis.com/auth/gmail.readonly',
  calendarRead: 'https://www.googleapis.com/auth/calendar.readonly',
  calendarEvents: 'https://www.googleapis.com/auth/calendar.events',
  drive: 'https://www.googleapis.com/auth/drive',
} as const;

export const DEFAULT_DRIVE_FOLDER = 'dodo';

/** A folder name in My Drive: no slashes, nothing a Drive query would need escaping for. */
export const DriveFolderName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^/\\'"]+$/, 'A folder name without slashes or quotes');

/** The largest file a tool moves through the callable (request and response stay < 10 MB). */
export const GOOGLE_FILE_MAX_BYTES = 7 * 1024 * 1024;
/** The most text drive_read and gmail_read_thread return to the model. */
export const GOOGLE_TEXT_MAX_CHARS = 60_000;

/** A Drive file id, or a Docs/Drive URL that contains one. */
export function driveFileId(ref: string): string {
  const s = ref.trim();
  const m = /\/d\/([\w-]{10,})/.exec(s) ?? /[?&]id=([\w-]{10,})/.exec(s);
  return m ? (m[1] as string) : s;
}

const FileId = z.string().trim().min(1).max(500);
const Base64 = z
  .string()
  .max(Math.ceil((GOOGLE_FILE_MAX_BYTES * 4) / 3) + 4)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'base64');

/** One operation of the googleTool callable. */
export const GoogleOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('gmail_search'),
    query: z.string().trim().min(1).max(500),
    max: z.number().int().min(1).max(25).default(10),
  }),
  z.object({ op: z.literal('gmail_read_thread'), threadId: z.string().trim().min(1).max(100) }),
  z.object({
    op: z.literal('calendar_list_events'),
    from: z.string().max(40).optional(),
    to: z.string().max(40).optional(),
    query: z.string().max(200).optional(),
    max: z.number().int().min(1).max(50).default(20),
  }),
  z.object({
    op: z.literal('calendar_create_event'),
    title: z.string().trim().min(1).max(300),
    /** `YYYY-MM-DD` for an all-day event, else a date-time (with or without offset). */
    start: z.string().trim().min(10).max(40),
    end: z.string().trim().min(10).max(40),
    timeZone: z.string().max(64).optional(),
    location: z.string().max(500).optional(),
    description: z.string().max(8000).optional(),
  }),
  z.object({
    op: z.literal('drive_search'),
    text: z.string().trim().max(300).optional(),
    inFolder: z.boolean().default(false),
    max: z.number().int().min(1).max(50).default(15),
  }),
  z.object({ op: z.literal('drive_read'), fileId: FileId }),
  z.object({ op: z.literal('drive_download'), fileId: FileId }),
  z.object({
    op: z.literal('drive_save'),
    name: z.string().trim().min(1).max(300),
    mimeType: z.string().max(200).default('application/octet-stream'),
    data: Base64,
    /** Convert to a Google Doc / Sheet / Slides (for text, HTML, CSV, docx, xlsx, pptx). */
    convert: z.boolean().default(false),
  }),
  z.object({
    op: z.literal('drive_update'),
    fileId: FileId,
    mimeType: z.string().max(200).default('application/octet-stream'),
    data: Base64,
  }),
]);
export type GoogleOp = z.infer<typeof GoogleOp>;
export type GoogleOpName = GoogleOp['op'];

export const GoogleToolRequest = z.object({ runId: z.string(), call: GoogleOp });
export type GoogleToolRequest = z.infer<typeof GoogleToolRequest>;

/** Google as a run sees it (runStart): which account, which scopes, which Drive folder. */
export interface RunGoogleAccess {
  email?: string;
  scopes: string[];
  folder: string;
}

/**
 * What a Google operation means for the policy engine, shared by the agent (which asks) and
 * the control plane (which checks a write was approved before it runs it).
 *   reads and saving a new file into the dodo folder: sandbox (free under agent-decides)
 *   creating a calendar event, changing an existing Drive file: write (asks)
 */
export function googleClaim(call: GoogleOp): {
  tool: 'Gmail' | 'Calendar' | 'Drive';
  key: string;
  category: 'sandbox' | 'write';
} {
  switch (call.op) {
    case 'gmail_search':
      return { tool: 'Gmail', key: `search:${call.query}`, category: 'sandbox' };
    case 'gmail_read_thread':
      return { tool: 'Gmail', key: `read:${call.threadId}`, category: 'sandbox' };
    case 'calendar_list_events':
      return { tool: 'Calendar', key: 'list', category: 'sandbox' };
    case 'calendar_create_event':
      return { tool: 'Calendar', key: `create:${call.title}`, category: 'write' };
    case 'drive_search':
      return { tool: 'Drive', key: `search:${call.text ?? ''}`, category: 'sandbox' };
    case 'drive_read':
      return { tool: 'Drive', key: `read:${driveFileId(call.fileId)}`, category: 'sandbox' };
    case 'drive_download':
      return { tool: 'Drive', key: `read:${driveFileId(call.fileId)}`, category: 'sandbox' };
    case 'drive_save':
      return { tool: 'Drive', key: `save:${call.name}`, category: 'sandbox' };
    case 'drive_update':
      return { tool: 'Drive', key: `edit:${driveFileId(call.fileId)}`, category: 'write' };
  }
}

/** Which scope an operation needs (the account may have unticked some on Google's screen). */
export function googleScopeFor(op: GoogleOpName): string {
  if (op.startsWith('gmail_')) return GOOGLE_SCOPE.gmailRead;
  if (op === 'calendar_create_event') return GOOGLE_SCOPE.calendarEvents;
  if (op.startsWith('calendar_')) return GOOGLE_SCOPE.calendarRead;
  return GOOGLE_SCOPE.drive;
}

/** calendar.events can read events too. */
export function hasGoogleScope(granted: readonly string[], op: GoogleOpName): boolean {
  const need = googleScopeFor(op);
  if (need === GOOGLE_SCOPE.calendarRead && granted.includes(GOOGLE_SCOPE.calendarEvents))
    return true;
  return granted.includes(need);
}
