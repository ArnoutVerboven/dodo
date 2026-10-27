import { vaultRefs } from '@dodo/core';

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
}

export { vaultRefs as findVaultRefs } from '@dodo/core';

/** Values shorter than this are not redacted: they would cut ordinary words out of pages. */
const MIN_REDACT = 3;

export function createSecretResolver(
  fetchValue: (entryId: string, field: string, host: string) => Promise<string>,
): SecretResolver {
  /** value → reference, longest values first when redacting. */
  const seen = new Map<string, string>();
  return {
    async resolve(text, host) {
      let out = text;
      for (const r of vaultRefs(text)) {
        const value = await fetchValue(r.entryId, r.field, host);
        if (value.length >= MIN_REDACT) seen.set(value, r.ref);
        out = out.split(r.ref).join(value);
      }
      return out;
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
