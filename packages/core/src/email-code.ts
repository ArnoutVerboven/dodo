import { z } from 'zod';

/**
 * One-time codes a site emails the user (ARCHITECTURE §9.3). The control plane finds the mail
 * in the user's Gmail and hands the code to the run, which types it into the page it is for;
 * the model only ever sees a reference `{{answer:mail-<gmailId>}}`, like a secret answer.
 */

/** Second-level labels under which a registrable domain takes three labels (`x.co.uk`). */
const SECOND_LEVEL = new Set([
  'ac',
  'co',
  'com',
  'edu',
  'gov',
  'net',
  'org',
  'ne',
  'or',
  'gv',
  'gob',
  'nom',
]);

/**
 * The registrable domain of a host or address (`account.booking.com` → `booking.com`,
 * `noreply@mail.bbc.co.uk` → `bbc.co.uk`). A short list instead of the public suffix list:
 * good enough to tie a code from a site's mail to that site's pages.
 */
export function siteOf(hostOrAddress: string): string {
  const host = (hostOrAddress.split('@').pop() ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\*\./, '')
    .replace(/\.$/, '')
    .replace(/[>\s].*$/, '');
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const [sld, tld] = labels.slice(-2) as [string, string];
  const take = tld.length === 2 && SECOND_LEVEL.has(sld) ? 3 : 2;
  return labels.slice(-take).join('.');
}

export const sameSite = (a: string, b: string) => !!siteOf(a) && siteOf(a) === siteOf(b);

/** The run asks the control plane for the newest code mail from a site. */
export const EmailCodeRequest = z.object({
  runId: z.string(),
  /** The page the code is for; the code is only ever typed there. */
  host: z.string().min(1).max(253),
  /** The sender's domain when it differs from the page's (asked for approval first). */
  sender: z.string().min(1).max(253).optional(),
  /** Only mail received at or after this time (ms). */
  since: z.number().int().nonnegative(),
  /** Gmail message ids this run already used, so a resent code is not mistaken for the old one. */
  exclude: z.array(z.string().max(64)).max(20).default([]),
});
export type EmailCodeRequest = z.infer<typeof EmailCodeRequest>;

export const EmailCodeResponse = z.discriminatedUnion('found', [
  z.object({
    found: z.literal(true),
    /** The Gmail message id. */
    id: z.string(),
    code: z.string(),
    from: z.string(),
    subject: z.string(),
    receivedAt: z.number(),
  }),
  z.object({
    found: z.literal(false),
    /** Why there is nothing to wait for (Gmail not connected); absent: not arrived yet. */
    error: z.string().optional(),
  }),
]);
export type EmailCodeResponse = z.infer<typeof EmailCodeResponse>;

/** The reference the model types for an emailed code. */
export const emailCodeId = (gmailId: string) => `mail-${gmailId.replace(/[^A-Za-z0-9_-]/g, '')}`;
