import { siteOf } from '@dodo/core';
import type { GmailClient, GmailMessage } from './google.js';
import { emailOf, messageText } from './mail.js';

/**
 * Finding a one-time code a site just emailed the user: the newest mail from the site's
 * domain, and the code in it. Plain heuristics (no model call), so it is quick, free and the
 * code never passes through a model.
 */

/** Words that sit next to a code in sign-in mail, in the languages the user gets mail in. */
const KEYWORD =
  /\b(code|codes|otp|passcode|pin|one[- ]time|verif\w*|confirm\w*|security|sign[- ]?in|log[- ]?in|login|authenticat\w*|2fa|mfa|token|bevestig\w*|aanmeld\w*|inlog\w*|eenmalig\w*|toegang\w*|v[ée]rification|connexion|confirmation|code de s[ée]curit[ée]|best[äa]tig\w*|anmelde\w*|sicherheits\w*|c[óo]digo|codice|verifica\w*)\b/i;

/** A code: 4–8 digits, digits in two groups (`123 456`), `G-123456`, or 6–8 caps with a digit. */
const CANDIDATE =
  /(?<![\w+/.:=@#€$£-]|\d[ -])(?:[A-Z]-)?(\d{3,4}[ -]\d{3,4}|\d{4,8}|(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,8})(?![\w/@%€$£]|[.,:-]\d| ?[-:] ?\d|[ -]\d{3,4}\b)/g;

const URL = /\b(?:https?:\/\/|www\.)\S+/gi;

interface Candidate {
  code: string;
  score: number;
}

function candidatesIn(line: string, base: number): Candidate[] {
  const out: Candidate[] = [];
  for (const m of line.matchAll(CANDIDATE)) {
    const raw = m[1] as string;
    const code = /^\d/.test(raw) ? raw.replace(/[ -]/g, '') : raw;
    if (code.length < 4 || code.length > 8) continue;
    let score = base;
    if (/^\d{6}$/.test(code)) score += 2;
    if (/^(19|20)\d\d$/.test(code)) score -= 5; // a year
    if (line.trim() === m[0]) score += 3; // on a line of its own
    const before = line.slice(Math.max(0, (m.index ?? 0) - 60), m.index);
    if (KEYWORD.test(before)) score += 3;
    out.push({ code, score });
  }
  return out;
}

/**
 * The code in a sign-in mail, or undefined when nothing reads like one. A mail must mention a
 * code somewhere (subject or body); then the candidate nearest such a word, on its own line or
 * in the subject wins.
 */
export function extractCode(subject: string, body: string): string | undefined {
  const text = body.replace(URL, ' ');
  if (!KEYWORD.test(subject) && !KEYWORD.test(text)) return undefined;
  const scored: Candidate[] = candidatesIn(subject, KEYWORD.test(subject) ? 4 : 2);
  const lines = text.split(/\r?\n/);
  let lastKeyword = -10;
  lines.forEach((line, i) => {
    if (KEYWORD.test(line)) lastKeyword = i;
    // Near a line that names a code: the line itself, or the few lines after it.
    const near = i - lastKeyword;
    const base = near === 0 ? 3 : near <= 3 ? 2 : 0;
    scored.push(...candidatesIn(line, base));
  });
  const best = scored.reduce<Candidate | undefined>(
    (a, c) => (!a || c.score > a.score ? c : a),
    undefined,
  );
  return best && best.score >= 4 ? best.code : undefined;
}

const header = (m: GmailMessage, name: string) =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

export interface FoundCode {
  id: string;
  code: string;
  from: string;
  subject: string;
  receivedAt: number;
}

/**
 * The newest mail since `since` from `site` (any subdomain) with a code in it. Looks in every
 * folder, spam included, since sign-in mail lands there often enough.
 */
export async function findEmailCode(
  gmail: Pick<GmailClient, 'listMessages' | 'getMessage'>,
  opts: { site: string; since: number; exclude?: string[] },
): Promise<FoundCode | undefined> {
  const site = siteOf(opts.site);
  if (!site) return undefined;
  // Gmail's `after:` is in whole seconds; a minute of slack, the exact cut is done below.
  const after = Math.max(0, Math.floor(opts.since / 1000) - 60);
  const listed = await gmail.listMessages(`from:${site} after:${after} in:anywhere`, 10);
  const skip = new Set(opts.exclude ?? []);
  const messages = (
    await Promise.all(
      listed.filter((m) => !skip.has(m.id)).map((m) => gmail.getMessage(m.id, 'full')),
    )
  )
    .filter((m) => Number(m.internalDate ?? 0) >= opts.since)
    .filter((m) => siteOf(emailOf(header(m, 'From'))) === site)
    .sort((a, b) => Number(b.internalDate ?? 0) - Number(a.internalDate ?? 0));
  for (const m of messages) {
    const subject = header(m, 'Subject');
    const code = extractCode(subject, messageText(m));
    if (code)
      return {
        id: m.id,
        code,
        from: header(m, 'From'),
        subject,
        receivedAt: Number(m.internalDate ?? 0),
      };
  }
  return undefined;
}
