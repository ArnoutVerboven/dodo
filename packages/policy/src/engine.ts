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
    if (input.category === 'egress' && input.tool === 'Http') {
      const host = input.key.replace(/^domain:/, '');
      if (this.config.allowedHosts?.some((h) => host === h || host.endsWith(`.${h}`))) {
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
