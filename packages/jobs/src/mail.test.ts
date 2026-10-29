import { describe, expect, it } from 'vitest';
import type { GmailMessage } from './google.js';
import {
  emailOf,
  inboxQuery,
  nameOf,
  replyMime,
  stripQuoted,
  threadState,
  toThread,
  unanswered,
} from './mail.js';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 27, 12);
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

function msg(
  id: string,
  from: string,
  hoursAgo: number,
  labels: string[] = ['INBOX'],
  extra: Array<{ name: string; value: string }> = [],
  text = 'Hello',
): GmailMessage {
  return {
    id,
    threadId: 't1',
    labelIds: labels,
    internalDate: String(NOW - hoursAgo * HOUR),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: from },
        { name: 'Subject', value: 'Bezoek Kerkstraat 12' },
        { name: 'Message-ID', value: `<${id}@mail>` },
        ...extra,
      ],
      body: { data: b64(text) },
    },
  };
}

const opts = { now: NOW, unansweredMs: HOUR, lookbackMs: 72 * HOUR, skipBulk: true };
const me = 'arnout@example.com';

describe('unanswered', () => {
  it('counts a thread whose last message is theirs, in the inbox, older than the threshold', () => {
    const t = toThread({
      id: 't1',
      messages: [
        msg('a', `Arnout <${me}>`, 30, ['SENT']),
        msg('b', '"Jan Peeters" <jan@immo.be>', 2),
      ],
    });
    const v = unanswered(t, me, opts);
    expect(v.ok && v.last.id).toBe('b');
  });

  it('skips answered, archived, trashed, too recent, too old and bulk threads', () => {
    const one = (m: GmailMessage) => unanswered(toThread({ id: 't', messages: [m] }), me, opts);
    expect(one(msg('a', me, 2, ['SENT', 'INBOX']))).toMatchObject({ reason: 'answered' });
    expect(one(msg('a', 'x@y.be', 2, ['CATEGORY_PERSONAL']))).toMatchObject({
      reason: 'not_in_inbox',
    });
    expect(one(msg('a', 'x@y.be', 2, ['INBOX', 'TRASH']))).toMatchObject({
      reason: 'not_in_inbox',
    });
    expect(one(msg('a', 'x@y.be', 0.5))).toMatchObject({ reason: 'too_recent' });
    expect(one(msg('a', 'x@y.be', 100))).toMatchObject({ reason: 'too_old' });
    expect(
      one(msg('a', 'news@shop.be', 2, ['INBOX'], [{ name: 'List-Unsubscribe', value: '<x>' }])),
    ).toMatchObject({ reason: 'bulk' });
    expect(one(msg('a', 'no-reply@bank.be', 2))).toMatchObject({ reason: 'bulk' });
  });

  it('ignores your unsent drafts when deciding who spoke last', () => {
    const t = toThread({
      id: 't1',
      messages: [msg('b', 'jan@immo.be', 2), msg('c', me, 1, ['DRAFT'])],
    });
    expect(unanswered(t, me, opts).ok).toBe(true);
  });
});

describe('mail helpers', () => {
  it('parses addresses', () => {
    expect(emailOf('"Jan Peeters" <Jan@Immo.be>')).toBe('jan@immo.be');
    expect(nameOf('"Jan Peeters" <jan@immo.be>')).toBe('Jan Peeters');
    expect(nameOf('jan@immo.be')).toBe('jan@immo.be');
  });

  it('builds an inbox-only query with an epoch window', () => {
    const q = inboxQuery({
      now: NOW,
      unansweredMs: HOUR,
      lookbackMs: 72 * HOUR,
      primaryOnly: true,
    });
    expect(q).toContain('in:inbox');
    expect(q).toContain('category:primary');
    expect(q).toContain(`before:${(NOW - HOUR) / 1000}`);
    expect(q).toContain(`after:${(NOW - 72 * HOUR) / 1000}`);
  });

  it('strips quoted history', () => {
    expect(
      stripQuoted('Ja, dinsdag past.\n\nOp ma 26 okt 2026 om 10:00 schreef Jan:\n> eerder'),
    ).toBe('Ja, dinsdag past.');
  });

  it('writes a threaded reply with UTF-8 subject and body', () => {
    const t = toThread({
      id: 't1',
      messages: [
        msg(
          'b',
          '"Jan" <jan@immo.be>',
          2,
          ['INBOX'],
          [
            { name: 'References', value: '<root@mail>' },
            { name: 'Subject', value: 'Café visit' },
          ],
        ),
      ],
    });
    const last = t.messages[0];
    if (!last) throw new Error('no message');
    const raw = Buffer.from(
      replyMime({ from: me, inReplyTo: last, body: 'Dag Jan, dinsdag om 10u?' }),
      'base64url',
    ).toString('utf8');
    expect(raw).toContain('To: "Jan" <jan@immo.be>');
    expect(raw).toContain('In-Reply-To: <b@mail>');
    expect(raw).toContain('References: <root@mail> <b@mail>');
    expect(raw).toMatch(/Subject: Re: Bezoek Kerkstraat 12/);
    const body = raw.split('\r\n\r\n')[1] ?? '';
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe(
      'Dag Jan, dinsdag om 10u?',
    );
  });
});

describe('threadState', () => {
  const me = 'arnout@example.com';
  const thread = (...m: GmailMessage[]) => toThread({ id: 't1', messages: m });

  it('is gone when the thread was deleted, emptied or marked as spam', () => {
    expect(
      threadState(
        thread(msg('a', 'jan@immo.be', 5, ['TRASH']), msg('b', me, 4, ['SENT', 'TRASH'])),
        me,
      ),
    ).toMatchObject({ kind: 'gone', reason: 'The email was deleted in Gmail' });
    expect(threadState(thread(), me).kind).toBe('gone');
    expect(threadState(thread(msg('a', 'jan@immo.be', 5, ['SPAM'])), me)).toMatchObject({
      kind: 'gone',
      reason: 'The email was marked as spam in Gmail',
    });
    // Deleting their mail is enough, even when your earlier message stays in Sent.
    expect(
      threadState(thread(msg('a', me, 9, ['SENT']), msg('b', 'jan@immo.be', 5, ['TRASH'])), me)
        .kind,
    ).toBe('gone');
  });

  it('is answered when your message is the last one, else waiting', () => {
    expect(threadState(thread(msg('a', 'jan@immo.be', 5), msg('b', me, 1, ['SENT'])), me)).toEqual({
      kind: 'answered',
      ref: 'b',
    });
    expect(
      threadState(thread(msg('a', me, 5, ['SENT']), msg('b', 'jan@immo.be', 1)), me).kind,
    ).toBe('waiting');
    // Archived mail is not deleted: still linked.
    expect(threadState(thread(msg('a', 'jan@immo.be', 5, [])), me).kind).toBe('waiting');
  });
});
