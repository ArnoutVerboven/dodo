import type { GmailMessage, GmailPart, GmailThread } from './google.js';

/** A Gmail message reduced to what the job looks at. */
export interface MailMessage {
  id: string;
  from: string;
  fromEmail: string;
  to: string;
  replyTo?: string;
  subject: string;
  messageIdHeader?: string;
  references?: string;
  date: number;
  labels: string[];
  bulk: boolean;
  text: string;
}

export interface MailThread {
  id: string;
  subject: string;
  messages: MailMessage[];
}

const header = (p: GmailPart | undefined, name: string) =>
  p?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

/** `"Jan Peeters" <jan@x.be>` → `jan@x.be`. */
export function emailOf(address: string): string {
  const m = /<([^>]+)>/.exec(address);
  return (m ? (m[1] as string) : address).trim().toLowerCase();
}

/** `"Jan Peeters" <jan@x.be>` → `Jan Peeters`. */
export function nameOf(address: string): string {
  const m = /^\s*"?([^"<]+?)"?\s*</.exec(address);
  return m ? (m[1] as string).trim() : emailOf(address);
}

const NOREPLY = /(^|[.+_-])(no-?reply|do-?not-?reply|notifications?|mailer-daemon|bounce)/i;

/** Mailing lists, newsletters and automated mail: skipped without a model call. */
export function isBulk(p: GmailPart | undefined): boolean {
  if (header(p, 'List-Unsubscribe') || header(p, 'List-Id')) return true;
  if (/^(bulk|list|junk)$/i.test(header(p, 'Precedence') ?? '')) return true;
  const auto = header(p, 'Auto-Submitted');
  if (auto && auto.toLowerCase() !== 'no') return true;
  const local = emailOf(header(p, 'From') ?? '').split('@')[0] ?? '';
  return NOREPLY.test(local);
}

function decode(data: string | undefined): string {
  return data ? Buffer.from(data, 'base64url').toString('utf8') : '';
}

function findPart(p: GmailPart | undefined, mime: string): GmailPart | undefined {
  if (!p) return undefined;
  if (p.mimeType === mime && p.body?.data && !p.filename) return p;
  for (const c of p.parts ?? []) {
    const hit = findPart(c, mime);
    if (hit) return hit;
  }
  return undefined;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Drops the quoted history below a reply ("On … wrote:", "> " lines). */
export function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue;
    if (
      /^(On|Op|Le|Am) .{4,200}(wrote|schreef|a écrit|schrieb)[^\n]{0,200}:\s*$/i.test(line.trim())
    )
      break;
    if (/^-{2,}\s*(Original Message|Oorspronkelijk bericht)/i.test(line.trim())) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

export function messageText(m: GmailMessage): string {
  const plain = findPart(m.payload, 'text/plain');
  if (plain) return stripQuoted(decode(plain.body?.data));
  const html = findPart(m.payload, 'text/html');
  if (html) return stripQuoted(htmlToText(decode(html.body?.data)));
  return m.snippet ?? '';
}

export function toMail(m: GmailMessage): MailMessage {
  const p = m.payload;
  const from = header(p, 'From') ?? '';
  return {
    id: m.id,
    from,
    fromEmail: emailOf(from),
    to: header(p, 'To') ?? '',
    replyTo: header(p, 'Reply-To'),
    subject: header(p, 'Subject') ?? '(no subject)',
    messageIdHeader: header(p, 'Message-ID'),
    references: header(p, 'References'),
    date: Number(m.internalDate ?? 0),
    labels: m.labelIds ?? [],
    bulk: isBulk(p),
    text: p?.parts || p?.body?.data ? messageText(m) : (m.snippet ?? ''),
  };
}

export function toThread(t: GmailThread): MailThread {
  const messages = (t.messages ?? [])
    .map(toMail)
    // Drafts are yours and unsent: they say nothing about who spoke last.
    .filter((m) => !m.labels.includes('DRAFT'))
    .sort((a, b) => a.date - b.date);
  return { id: t.id, subject: messages[0]?.subject ?? '(no subject)', messages };
}

export const isFromMe = (m: MailMessage, me: string) =>
  m.labels.includes('SENT') || m.fromEmail === me.toLowerCase();

/**
 * What became of a thread a task was made from (see sync.ts): gone when it was deleted or
 * marked as spam (every message from the other side is in the trash or spam, or none is left),
 * answered when your message is the last one, else waiting on you or them.
 */
export function threadState(
  thread: MailThread,
  me: string,
): { kind: 'gone'; reason: string } | { kind: 'answered'; ref: string } | { kind: 'waiting' } {
  const removed = (m: MailMessage) => m.labels.includes('TRASH') || m.labels.includes('SPAM');
  const others = thread.messages.filter((m) => !isFromMe(m, me));
  const pool = others.length ? others : thread.messages;
  if (!pool.length || pool.every(removed)) {
    const spam = pool.length > 0 && pool.every((m) => m.labels.includes('SPAM'));
    return {
      kind: 'gone',
      reason: spam ? 'The email was marked as spam in Gmail' : 'The email was deleted in Gmail',
    };
  }
  const last = thread.messages.filter((m) => !removed(m)).at(-1);
  if (last && isFromMe(last, me)) return { kind: 'answered', ref: last.id };
  return { kind: 'waiting' };
}

export type Verdict =
  | { ok: true; last: MailMessage }
  | {
      ok: false;
      reason: 'answered' | 'not_in_inbox' | 'too_recent' | 'too_old' | 'bulk' | 'empty';
    };

/**
 * Whether a thread is waiting on you: the last message is someone else's, still in the inbox
 * (not archived, trashed or spam), older than the threshold and inside the lookback window.
 */
export function unanswered(
  thread: MailThread,
  me: string,
  opts: { now: number; unansweredMs: number; lookbackMs: number; skipBulk: boolean },
): Verdict {
  const last = thread.messages.at(-1);
  if (!last) return { ok: false, reason: 'empty' };
  if (isFromMe(last, me)) return { ok: false, reason: 'answered' };
  const labels = new Set(last.labels);
  if (!labels.has('INBOX') || labels.has('TRASH') || labels.has('SPAM')) {
    return { ok: false, reason: 'not_in_inbox' };
  }
  if (opts.now - last.date < opts.unansweredMs) return { ok: false, reason: 'too_recent' };
  if (opts.now - last.date > opts.lookbackMs) return { ok: false, reason: 'too_old' };
  if (opts.skipBulk && last.bulk) return { ok: false, reason: 'bulk' };
  return { ok: true, last };
}

/** Gmail search for candidate threads. Epoch seconds work in after:/before:. */
export function inboxQuery(opts: {
  now: number;
  unansweredMs: number;
  lookbackMs: number;
  primaryOnly: boolean;
}): string {
  const after = Math.floor((opts.now - opts.lookbackMs) / 1000);
  const before = Math.floor((opts.now - opts.unansweredMs) / 1000);
  const parts = ['in:inbox', '-in:chats', '-from:me', `after:${after}`, `before:${before}`];
  if (opts.primaryOnly) parts.push('category:primary');
  return parts.join(' ');
}

export function threadUrl(threadId: string, account?: string): string {
  const q = account ? `?authuser=${encodeURIComponent(account)}` : '';
  return `https://mail.google.com/mail/u/0/${q}#all/${threadId}`;
}

function encodeHeader(v: string): string {
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

/** A reply in the thread as an RFC 2822 message, base64url-encoded for the Gmail API. */
export function replyMime(opts: {
  from: string;
  inReplyTo: MailMessage;
  body: string;
  to?: string;
}): string {
  const original = opts.inReplyTo;
  const subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;
  const to = opts.to ?? original.replyTo ?? original.from;
  const refs = [original.references, original.messageIdHeader].filter(Boolean).join(' ');
  const headers = [
    `From: ${opts.from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    ...(original.messageIdHeader ? [`In-Reply-To: ${original.messageIdHeader}`] : []),
    ...(refs ? [`References: ${refs}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];
  const body = Buffer.from(opts.body.replace(/\r?\n/g, '\r\n'), 'utf8')
    .toString('base64')
    .replace(/.{76}/g, '$&\r\n');
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`, 'utf8').toString('base64url');
}

/** The text of a draft as it is in Gmail now (you may have edited it). */
export function draftText(m: GmailMessage): string {
  const plain = findPart(m.payload, 'text/plain');
  if (plain) return decode(plain.body?.data).trim();
  if (m.payload?.body?.data) return decode(m.payload.body.data).trim();
  const html = findPart(m.payload, 'text/html');
  return html ? htmlToText(decode(html.body?.data)) : '';
}
