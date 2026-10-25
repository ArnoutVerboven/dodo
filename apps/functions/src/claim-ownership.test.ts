import { describe, expect, it, vi } from 'vitest';
import { type ClaimDeps, claimOwnership } from './claim-ownership.js';

function deps(
  overrides: Partial<ClaimDeps> & {
    user?: Partial<Awaited<ReturnType<ClaimDeps['getUser']>>>;
  } = {},
) {
  const setClaims = vi.fn(async () => {});
  const d: ClaimDeps = {
    ownerEmail: 'Owner@Example.com',
    getUser: async () => ({
      email: 'owner@example.com',
      emailVerified: true,
      claims: {},
      ...overrides.user,
    }),
    setClaims,
    ...overrides,
  };
  return { d, setClaims };
}

describe('claimOwnership', () => {
  it('grants the claim to the configured owner (case-insensitive)', async () => {
    const { d, setClaims } = deps();
    expect(await claimOwnership('u1', d)).toEqual({ ok: true, alreadyOwner: false });
    expect(setClaims).toHaveBeenCalledWith('u1', { dodo_owner: true });
  });

  it('keeps existing claims', async () => {
    const { d, setClaims } = deps({ user: { claims: { foo: 1 } } });
    await claimOwnership('u1', d);
    expect(setClaims).toHaveBeenCalledWith('u1', { foo: 1, dodo_owner: true });
  });

  it('is idempotent', async () => {
    const { d, setClaims } = deps({ user: { claims: { dodo_owner: true } } });
    expect(await claimOwnership('u1', d)).toEqual({ ok: true, alreadyOwner: true });
    expect(setClaims).not.toHaveBeenCalled();
  });

  it('refuses other accounts', async () => {
    const { d, setClaims } = deps({ user: { email: 'mallory@example.com' } });
    expect((await claimOwnership('u2', d)).ok).toBe(false);
    expect(setClaims).not.toHaveBeenCalled();
  });

  it('refuses unverified emails and missing config', async () => {
    expect((await claimOwnership('u1', deps({ user: { emailVerified: false } }).d)).ok).toBe(false);
    expect((await claimOwnership('u1', deps({ ownerEmail: '' }).d)).ok).toBe(false);
  });
});
