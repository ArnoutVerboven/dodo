import { describe, expect, it } from 'vitest';
import { hostAllowedBy, PolicyEngine } from './engine.js';
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

describe('hostAllowedBy', () => {
  const base = { allow: [] as string[], deny: [] as string[], allowedHosts: [] as string[] };
  it('allows a host on the allowed-hosts list, including subdomains', () => {
    expect(hostAllowedBy({ ...base, allowedHosts: ['github.com'] }, 'api.github.com')).toBe(
      'allowed host api.github.com',
    );
    expect(
      hostAllowedBy({ ...base, allowedHosts: ['github.com'] }, 'notgithub.com'),
    ).toBeUndefined();
  });
  it('allows a host an Http rule names', () => {
    expect(
      hostAllowedBy({ ...base, allow: ['Http(domain:api.example.com)'] }, 'api.example.com'),
    ).toBe('Http(domain:api.example.com)');
    expect(
      hostAllowedBy({ ...base, allow: ['Http(domain:api.example.com)'] }, 'example.com'),
    ).toBeUndefined();
    expect(hostAllowedBy({ ...base, allow: ['Http'] }, 'anything.test')).toBe('Http');
  });
  it('allows a host an approved command mentions as a whole name', () => {
    const allow = ['Bash(curl -s https://api.x.com/v1 | jq .)'];
    expect(hostAllowedBy({ ...base, allow }, 'api.x.com')).toBe(allow[0]);
    expect(hostAllowedBy({ ...base, allow }, 'x.com')).toBeUndefined();
    expect(hostAllowedBy({ ...base, allow }, 'api.x.community')).toBeUndefined();
  });
  it('a deny rule wins', () => {
    expect(
      hostAllowedBy(
        { allow: ['Http'], deny: ['Http(domain:evil.test)'], allowedHosts: ['evil.test'] },
        'evil.test',
      ),
    ).toBeUndefined();
  });
});
