/**
 * Permission rules in the Claude Code style:
 *   Bash                 every Bash call
 *   Bash(git status)     exactly this command
 *   Bash(git push:*)     commands starting with "git push"
 *   Http(domain:api.github.com)   requests to this host
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

export function matches(rule: Rule, tool: string, key: string): boolean {
  if (rule.tool !== tool) return false;
  if (!rule.pattern) return true;
  if (rule.pattern.kind === 'exact') return key === rule.pattern.value;
  return key.startsWith(rule.pattern.value);
}

/** The rule "Always allow" would add for a call: exact, never a wildcard the user did not ask for. */
export function ruleFor(tool: string, key: string): string {
  return `${tool}(${key})`;
}
