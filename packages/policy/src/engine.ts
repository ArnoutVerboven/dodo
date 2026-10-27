import { matches, parseRule, type Rule, ruleFor } from './rules.js';

/**
 * What a call does, decided by the tool from its arguments. Drives the default when no rule
 * matches:
 *   sandbox   read-only or confined to the task folder → allow (agent-decides profile)
 *   write     writes outside the task folder            → ask
 *   egress    network to a host not on the allowlist    → ask
 *   outbound  messages, posts, PRs, payments, credentials → ask, always
 */
export type ActionCategory = 'sandbox' | 'write' | 'egress' | 'outbound';

/** `agent-decides`: sandbox actions are allowed; `untrusted`: everything but task tools asks. */
export type Profile = 'agent-decides' | 'untrusted';

export type Decision =
  | { kind: 'allow'; by?: string }
  | { kind: 'deny'; by: string }
  | { kind: 'ask'; suggestedRule: string; reason: string };

export interface PolicyInput {
  tool: string;
  /** The text rules match against, e.g. the command for Bash or `domain:host` for Http. */
  key: string;
  category: ActionCategory;
}

export interface PolicyConfig {
  profile: Profile;
  /** Merged task → project → global allow rules. */
  allow: string[];
  deny: string[];
  /** Hosts the task may reach without asking (project/task settings). */
  allowedHosts?: string[];
}

export class PolicyEngine {
  private readonly allow: Rule[];
  private readonly deny: Rule[];
  /** One-time approvals from an answered approval card, consumed on first use. */
  private readonly onceAllowed = new Set<string>();

  constructor(private readonly config: PolicyConfig) {
    this.allow = config.allow.flatMap((r) => parseRule(r) ?? []);
    this.deny = config.deny.flatMap((r) => parseRule(r) ?? []);
  }

  /** The user approved this exact call once (answered "yes" without "always allow"). */
  allowOnce(rule: string) {
    this.onceAllowed.add(rule);
  }

  decide(input: PolicyInput): Decision {
    const exact = ruleFor(input.tool, input.key);
    const denied = this.deny.find((r) => matches(r, input.tool, input.key));
    if (denied) return { kind: 'deny', by: denied.raw };
    const allowed = this.allow.find((r) => matches(r, input.tool, input.key));
    if (allowed) return { kind: 'allow', by: allowed.raw };
    if (this.onceAllowed.delete(exact)) return { kind: 'allow', by: 'approved once' };
    if (input.category === 'egress' && (input.tool === 'Http' || input.tool === 'Browser')) {
      const host = input.key.replace(/^(domain|navigate):/, '');
      if (hostMatches(host, this.config.allowedHosts ?? [])) {
        return { kind: 'allow', by: `allowed host ${host}` };
      }
    }
    if (input.category === 'sandbox' && this.config.profile === 'agent-decides') {
      return { kind: 'allow' };
    }
    return { kind: 'ask', suggestedRule: exact, reason: REASONS[input.category] };
  }
}

const REASONS: Record<ActionCategory, string> = {
  sandbox:
    'This task runs in the untrusted profile: every action outside the task tools needs approval.',
  write: 'This writes outside the task folder.',
  egress: 'This reaches a host that is not on the allowlist.',
  outbound: 'This sends something outside dodo on your behalf.',
};

/** `api.github.com` matches `api.github.com` and `github.com`, never `notgithub.com`. */
export function hostMatches(host: string, allowedHosts: readonly string[]): boolean {
  const h = host.toLowerCase();
  return allowedHosts.some((a) => {
    const x = a.toLowerCase().replace(/^\*\./, '');
    return h === x || h.endsWith(`.${x}`);
  });
}

/**
 * Whether the policy lets a run open a connection to `host`, judged from the outside (the Mac
 * sandbox asks this for every host the base allowlist does not cover). Allowed when the host
 * is on the allowed-hosts list, when an allow rule names it (`Http(domain:host)`, or a command
 * rule such as `Bash(curl https://host/...)` the user approved), and not when a deny rule names
 * it. Returns what decided, or undefined for "nothing allows it".
 */
export function hostAllowedBy(
  config: Pick<PolicyConfig, 'allow' | 'deny' | 'allowedHosts'>,
  host: string,
): string | undefined {
  const names = (raw: string) => {
    const rule = parseRule(raw);
    if (!rule) return false;
    if (rule.tool === 'Http') {
      if (!rule.pattern) return true;
      const value = rule.pattern.value.replace(/^domain:/, '');
      return rule.pattern.kind === 'exact'
        ? hostMatches(host, [value])
        : host.toLowerCase().startsWith(value.toLowerCase());
    }
    return !!rule.pattern && mentionsHost(rule.pattern.value, host);
  };
  if (config.deny.some(names)) return undefined;
  if (hostMatches(host, config.allowedHosts ?? [])) return `allowed host ${host}`;
  return config.allow.find(names);
}

/** The host appears in the text as a whole name (`curl https://api.x.com/v1`, not `api.x.community`). */
function mentionsHost(text: string, host: string): boolean {
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9.-])${escaped}(?![A-Za-z0-9-])`, 'i').test(text);
}
