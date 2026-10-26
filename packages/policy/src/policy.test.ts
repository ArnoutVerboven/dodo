import { describe, expect, it } from 'vitest';
import { PolicyEngine } from './engine.js';
import { matches, parseRule, ruleFor } from './rules.js';

describe('rules', () => {
  it('parses tool, exact and prefix rules', () => {
    expect(parseRule('Bash')).toEqual({ tool: 'Bash', raw: 'Bash' });
    expect(parseRule('Bash(git status)')).toMatchObject({
      pattern: { kind: 'exact', value: 'git status' },
    });
    expect(parseRule('Bash(git push:*)')).toMatchObject({
      pattern: { kind: 'prefix', value: 'git push' },
    });
    expect(parseRule('Http(domain:api.github.com)')).toMatchObject({
      tool: 'Http',
      pattern: { kind: 'exact', value: 'domain:api.github.com' },
    });
    expect(parseRule('nonsense((')).toBeUndefined();
  });

  it('matches by tool and pattern', () => {
    const prefix = parseRule('Bash(git push:*)');
    if (!prefix) throw new Error('parse');
    expect(matches(prefix, 'Bash', 'git push origin main')).toBe(true);
    expect(matches(prefix, 'Bash', 'git pull')).toBe(false);
    expect(matches(prefix, 'Http', 'git push')).toBe(false);
    const any = parseRule('Http');
    if (!any) throw new Error('parse');
    expect(matches(any, 'Http', 'domain:anything')).toBe(true);
  });

  it('suggests exact rules only', () => {
    expect(ruleFor('Bash', 'rm -rf build')).toBe('Bash(rm -rf build)');
  });
});

describe('PolicyEngine', () => {
  const base = { profile: 'agent-decides' as const, allow: [], deny: [] };

  it('allows sandbox actions by default and asks for the rest', () => {
    const p = new PolicyEngine(base);
    expect(p.decide({ tool: 'Bash', key: 'ls', category: 'sandbox' }).kind).toBe('allow');
    for (const category of ['write', 'egress', 'outbound'] as const) {
      const d = p.decide({ tool: 'Bash', key: 'curl x', category });
      expect(d.kind).toBe('ask');
      if (d.kind === 'ask') expect(d.suggestedRule).toBe('Bash(curl x)');
    }
  });

  it('asks for everything in the untrusted profile', () => {
    const p = new PolicyEngine({ ...base, profile: 'untrusted' });
    expect(p.decide({ tool: 'Bash', key: 'ls', category: 'sandbox' }).kind).toBe('ask');
  });

  it('deny beats allow beats default', () => {
    const p = new PolicyEngine({ ...base, allow: ['Bash(git:*)'], deny: ['Bash(git push:*)'] });
    expect(p.decide({ tool: 'Bash', key: 'git status', category: 'egress' }).kind).toBe('allow');
    expect(p.decide({ tool: 'Bash', key: 'git push origin', category: 'egress' }).kind).toBe(
      'deny',
    );
  });

  it('allows listed hosts for Http egress', () => {
    const p = new PolicyEngine({ ...base, allowedHosts: ['github.com'] });
    expect(p.decide({ tool: 'Http', key: 'domain:api.github.com', category: 'egress' }).kind).toBe(
      'allow',
    );
    expect(p.decide({ tool: 'Http', key: 'domain:evil.com', category: 'egress' }).kind).toBe('ask');
  });

  it('consumes a one-time approval exactly once', () => {
    const p = new PolicyEngine(base);
    p.allowOnce('Http(domain:evil.com)');
    expect(p.decide({ tool: 'Http', key: 'domain:evil.com', category: 'egress' }).kind).toBe(
      'allow',
    );
    expect(p.decide({ tool: 'Http', key: 'domain:evil.com', category: 'egress' }).kind).toBe('ask');
  });
});
