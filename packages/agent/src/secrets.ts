import { answerRef, answerRefs, sameSite, siteOf, vaultRefs } from '@dodo/core';

/**
 * Vault values inside a run (ARCHITECTURE §9.2). The model only ever writes references like
 * `{{vault:energy.password}}`; a tool that types into a site resolves them here, for that
 * site's host, and the control plane decides whether this task may have the value. Every value
 * resolved in the run is remembered so it can be cut out of whatever goes back to the model,
 * the trace or the thread.
 */
export interface SecretResolver {
  /**
   * Replaces every vault reference in `text` with its value, for typing into a page on `host`.
   * Throws an Error whose message says why (not approved for this task, wrong site, unknown
   * entry), which the tool can return to the model as is.
   */
  resolve(text: string, host: string): Promise<string>;
  /** Replaces every value resolved so far in this run with its reference. */
  redact(text: string): string;
  /**
   * Keeps a value the run itself fetched (an emailed sign-in code) under `{{answer:<id>}}`,
   * typed only on `site` (any of its subdomains) and redacted from now on. Returns the reference.
   */
  hold(id: string, value: string, site: string): string;
  /** The browser tools tell it which page is open, so a code asked for now is bound to it. */
  setPage?(host: string): void;
  /** The site of the page that is open (for a secret question), if any. */
  pageSite?(): string | undefined;
}

/** A secret answer as the control plane hands it out: with the site it was asked on. */
export type FetchedAnswer = string | { value: string; site?: string };

export { vaultRefs as findVaultRefs } from '@dodo/core';

/** Values shorter than this are not redacted: they would cut ordinary words out of pages. */
const MIN_REDACT = 3;

/**
 * The value as it may show up escaped in a tool result: in a JSON or JavaScript string (with
 * either quote), URL-encoded or as HTML. A password with a quote or a backslash in it must not
 * slip past the redaction just because something quoted it.
 */
export function escapedForms(value: string): string[] {
  const json = JSON.stringify(value).slice(1, -1);
  const html = value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  let url = value;
  try {
    url = encodeURIComponent(value);
  } catch {}
  const forms = [value, json, json.replace(/\\"/g, '"').replace(/'/g, "\\'"), url, html];
  return [...new Set(forms)];
}

export function createSecretResolver(
  fetchValue: (entryId: string, field: string, host: string) => Promise<string>,
  /** A secret answer to ask_user (`{{answer:<messageId>}}`); absent: such refs are refused. */
  fetchAnswer?: (messageId: string) => Promise<FetchedAnswer>,
): SecretResolver {
  let page = '';
  /** value (and its escaped forms) → reference, longest first when redacting. */
  const seen = new Map<string, string>();
  const remember = (value: string, ref: string) => {
    if (value.length < MIN_REDACT) return;
    for (const form of escapedForms(value)) seen.set(form, ref);
  };
  /** Values this run fetched itself, by answer id, with the site they belong to. */
  const held = new Map<string, { value: string; site: string }>();
  return {
    async resolve(text, host) {
      let out = text;
      for (const r of vaultRefs(text)) {
        const value = await fetchValue(r.entryId, r.field, host);
        remember(value, r.ref);
        out = out.split(r.ref).join(value);
      }
      for (const r of answerRefs(text)) {
        const own = held.get(r.messageId);
        if (own) {
          if (!sameSite(host, own.site))
            throw new Error(
              `That code is for ${own.site} and can only be typed there, not on ${host}.`,
            );
          out = out.split(r.ref).join(own.value);
          continue;
        }
        if (!fetchAnswer) throw new Error('Secret answers are not available in this run.');
        const fetched = await fetchAnswer(r.messageId);
        const { value, site } = typeof fetched === 'string' ? { value: fetched } : fetched;
        // A code you gave for one site is typed there only (any of its subdomains).
        if (site && !sameSite(host, site))
          throw new Error(`That code is for ${site} and can only be typed there, not on ${host}.`);
        remember(value, r.ref);
        out = out.split(r.ref).join(value);
      }
      return out;
    },
    setPage(host) {
      page = host;
    },
    pageSite() {
      return page ? siteOf(page) : undefined;
    },
    hold(id, value, site) {
      const ref = answerRef(id);
      held.set(id, { value, site });
      remember(value, ref);
      return ref;
    },
    redact(text) {
      if (!seen.size || !text) return text;
      let out = text;
      for (const [value, ref] of [...seen].sort((a, b) => b[0].length - a[0].length)) {
        out = out.split(value).join(ref);
      }
      return out;
    },
  };
}

/** Redacts every string inside a JSON-like value (tool results, trace data). */
export function redactDeep<T>(value: T, redact: (s: string) => string): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v, redact)]),
    ) as T;
  }
  return value;
}
