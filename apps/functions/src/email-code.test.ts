import { GoogleAuthError } from '@dodo/jobs';
import { describe, expect, it } from 'vitest';
import { emailCodeForRun } from './email-code.js';

const NOW = Date.UTC(2026, 9, 30, 21);
const run = { id: 'r1', taskId: 't1' };
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

describe('emailCodeForRun', () => {
  it('finds the code from the page’s site and never logs it', async () => {
    const logs: string[] = [];
    const queries: string[] = [];
    const r = await emailCodeForRun(
      {
        now: () => NOW,
        log: (m, d) => logs.push(`${m} ${JSON.stringify(d)}`),
        gmail: () => ({
          async listMessages(q) {
            queries.push(q);
            return [{ id: 'm1', threadId: 'm1' }];
          },
          async getMessage(id) {
            return {
              id,
              threadId: id,
              internalDate: String(NOW - 30_000),
              payload: {
                mimeType: 'text/plain',
                headers: [
                  { name: 'From', value: 'Booking.com <noreply@booking.com>' },
                  { name: 'Subject', value: 'Your verification code' },
                ],
                body: { data: b64('Your code is\n\n482913') },
              },
            };
          },
        }),
      },
      run,
      // A run cannot reach back further than half an hour.
      { runId: 'r1', host: 'account.booking.com', since: 0, exclude: [] },
    );
    expect(r).toMatchObject({ found: true, id: 'm1', code: '482913' });
    expect(queries[0]).toContain(`after:${Math.floor((NOW - 30 * 60_000) / 1000) - 60}`);
    expect(logs.join()).not.toContain('482913');
  });

  it('explains when Gmail is not connected or not reachable', async () => {
    const req = { runId: 'r1', host: 'booking.com', since: NOW, exclude: [] };
    expect(await emailCodeForRun({ gmail: () => undefined }, run, req)).toMatchObject({
      found: false,
      error: expect.stringContaining('not connected'),
    });
    const expired = await emailCodeForRun(
      {
        gmail: () => ({
          listMessages: async () => {
            throw new GoogleAuthError('Google is not connected', true);
          },
          getMessage: async () => {
            throw new Error('unused');
          },
        }),
      },
      run,
      req,
    );
    expect(expired).toMatchObject({
      found: false,
      error: expect.stringContaining('connect Google again'),
    });
  });
});
