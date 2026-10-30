import { siteOf } from '@dodo/core';
import { describe, expect, it } from 'vitest';
import { extractCode, findEmailCode } from './email-code.js';
import type { GmailMessage } from './google.js';

describe('extractCode', () => {
  it('reads common sign-in mails', () => {
    expect(
      extractCode(
        'Your Booking.com verification code',
        'Hi,\n\nUse this code to sign in to Booking.com:\n\n482913\n\nThis code expires in 15 minutes.\nBooking.com B.V., Herengracht 597, 1017 CE Amsterdam',
      ),
    ).toBe('482913');
    expect(extractCode('123456 is your verification code', 'Do not share it.')).toBe('123456');
    expect(extractCode('Uw verificatiecode', 'Je eenmalige code is: 734 201')).toBe('734201');
    expect(extractCode('Sign in', 'Enter G-551023 to verify it is you')).toBe('551023');
    expect(extractCode('Votre code', 'Code de vérification : 0042')).toBe('0042');
    expect(extractCode('Login code', 'Your one-time passcode\n\nK7Q2M9\n\nThanks')).toBe('K7Q2M9');
  });

  it('prefers the code over other numbers in the mail', () => {
    expect(
      extractCode(
        'Confirm your sign-in',
        'Order 2026 summary\nCall us at +32 470 12 34 56\nYour security code is 905517.\n© 2026 Example, 1000 Brussels',
      ),
    ).toBe('905517');
  });

  it('ignores codes inside links and mail that mentions no code', () => {
    expect(extractCode('Your receipt', 'Total €45.00, order 88231, 12 March 2026')).toBe(undefined);
    expect(
      extractCode('Sign in to Example', 'Click https://example.com/login?token=123456 to sign in.'),
    ).toBe(undefined);
  });
});

describe('siteOf', () => {
  it('keeps the registrable domain', () => {
    expect(siteOf('account.booking.com')).toBe('booking.com');
    expect(siteOf('noreply@mailer.booking.com')).toBe('booking.com');
    expect(siteOf('www.bbc.co.uk')).toBe('bbc.co.uk');
    expect(siteOf('login.example.be')).toBe('example.be');
  });
});

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const NOW = Date.UTC(2026, 9, 30, 21);

function mail(id: string, from: string, minutesAgo: number, subject: string, text: string) {
  return {
    id,
    threadId: id,
    internalDate: String(NOW - minutesAgo * 60_000),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: from },
        { name: 'Subject', value: subject },
      ],
      body: { data: b64(text) },
    },
  } satisfies GmailMessage;
}

describe('findEmailCode', () => {
  const box = [
    mail('old', 'Booking.com <noreply@booking.com>', 30, 'Your code', 'Code: 111111'),
    mail('a', 'Booking.com <noreply@mailer.booking.com>', 4, 'Your code', 'Code: 222222'),
    mail('b', 'Booking.com <noreply@booking.com>', 1, 'Your code', 'Code: 333333'),
    mail('fake', 'Booking <noreply@booking.com.evil.io>', 0, 'Your code', 'Code: 999999'),
  ];
  const queries: string[] = [];
  const gmail = {
    async listMessages(q: string) {
      queries.push(q);
      return box.map((m) => ({ id: m.id, threadId: m.threadId }));
    },
    async getMessage(id: string) {
      return box.find((m) => m.id === id) as GmailMessage;
    },
  };

  it('takes the newest code from the site since the given time', async () => {
    const found = await findEmailCode(gmail, {
      site: 'secure.booking.com',
      since: NOW - 10 * 60_000,
    });
    expect(found).toMatchObject({ id: 'b', code: '333333' });
    expect(queries[0]).toContain('from:booking.com');
    expect(queries[0]).toContain('in:anywhere');
  });

  it('skips mail this run already used, and look-alike senders', async () => {
    expect(
      await findEmailCode(gmail, { site: 'booking.com', since: NOW - 10 * 60_000, exclude: ['b'] }),
    ).toMatchObject({ id: 'a', code: '222222' });
    expect(
      await findEmailCode(gmail, {
        site: 'booking.com',
        since: NOW - 10 * 60_000,
        exclude: ['a', 'b'],
      }),
    ).toBeUndefined();
  });
});
