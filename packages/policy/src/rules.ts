/**
 * Permission rules in the Claude Code style:
 *   Bash                 every Bash call
 *   Bash(git status)     exactly this command
 *   Bash(git push:*)     commands starting with "git push"
 *   Http(domain:github.com)       requests to this host and its subdomains
 *   Browser(navigate:booking.com) opening this site or any of its subdomains
 *   Browser(navigate:*)  prefix on the action
 *
 * A rule is `Tool` or `Tool(pattern)`. A pattern ending in `:*` is a prefix match on the
 * text before it; anything else is an exact match. Matching is on the "policy key" a tool
 * derives from its arguments, so each tool decides what its pattern means.
 */
export interface Rule {
  tool: string;
  /** undefined: matches every call of the tool. */
  pattern?: { kind: 'exact'; value: string } | { kind: 'prefix'; value: string };
  raw: string;
}

const RULE = /^([A-Za-z][\w-]*)(?:\((.*)\))?$/s;

export function parseRule(raw: string): Rule | undefined {
  const m = RULE.exec(raw.trim());
  if (!m) return undefined;
  const tool = m[1] as string;
  const inner = m[2];
  if (inner === undefined) return { tool, raw };
  if (inner.endsWith(':*'))
    return { tool, raw, pattern: { kind: 'prefix', value: inner.slice(0, -2) } };
  return { tool, raw, pattern: { kind: 'exact', value: inner } };
}

/** Keys that name a host: an exact rule for a host also covers its subdomains. */
const HOST_KEY = /^(domain|navigate):(.+)$/;

export function matches(rule: Rule, tool: string, key: string): boolean {
  if (rule.tool !== tool) return false;
  if (!rule.pattern) return true;
  if (rule.pattern.kind === 'prefix') return key.startsWith(rule.pattern.value);
  if (key === rule.pattern.value) return true;
  const want = HOST_KEY.exec(rule.pattern.value);
  const got = HOST_KEY.exec(key);
  return !!want && !!got && want[1] === got[1] && isSubdomain(got[2] as string, want[2] as string);
}

/** `account.booking.com` is under `booking.com`; `notbooking.com` is not. */
export function isSubdomain(host: string, parent: string): boolean {
  return host.toLowerCase().endsWith(`.${parent.toLowerCase()}`);
}

/** The rule "Always allow" would add for a call: exact, never a wildcard the user did not ask for. */
export function ruleFor(tool: string, key: string): string {
  return `${tool}(${key})`;
}
