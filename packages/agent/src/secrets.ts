import { answerRef, answerRefs, sameSite, vaultRefs } from '@dodo/core';

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
}

export { vaultRefs as findVaultRefs } from '@dodo/core';

/** Values shorter than this are not redacted: they would cut ordinary words out of pages. */
const MIN_REDACT = 3;

export function createSecretResolver(
  fetchValue: (entryId: string, field: string, host: string) => Promise<string>,
  /** A secret answer to ask_user (`{{answer:<messageId>}}`); absent: such refs are refused. */
  fetchAnswer?: (messageId: string) => Promise<string>,
): SecretResolver {
  /** value → reference, longest values first when redacting. */
  const seen = new Map<string, string>();
  /** Values this run fetched itself, by answer id, with the site they belong to. */
  const held = new Map<string, { value: string; site: string }>();
  return {
    async resolve(text, host) {
      let out = text;
      for (const r of vaultRefs(text)) {
        const value = await fetchValue(r.entryId, r.field, host);
        if (value.length >= MIN_REDACT) seen.set(value, r.ref);
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
        const value = await fetchAnswer(r.messageId);
        if (value.length >= MIN_REDACT) seen.set(value, r.ref);
        out = out.split(r.ref).join(value);
      }
      return out;
    },
    hold(id, value, site) {
      const ref = answerRef(id);
      held.set(id, { value, site });
      if (value.length >= MIN_REDACT) seen.set(value, ref);
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
