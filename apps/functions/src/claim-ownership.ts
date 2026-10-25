/**
 * Owner claim: the single configured owner email (OWNER_EMAIL) gets the `dodo_owner`
 * custom claim on first sign-in. Everyone else is refused. The web app calls this once
 * after sign-in and then refreshes its token. Replaces the manual grant-owner script.
 */

export interface ClaimDeps {
  ownerEmail: string;
  getUser: (
    uid: string,
  ) => Promise<{ email?: string; emailVerified?: boolean; claims: Record<string, unknown> }>;
  setClaims: (uid: string, claims: Record<string, unknown>) => Promise<void>;
}

export type ClaimResult = { ok: true; alreadyOwner: boolean } | { ok: false; reason: string };

export async function claimOwnership(uid: string, deps: ClaimDeps): Promise<ClaimResult> {
  const owner = deps.ownerEmail.trim().toLowerCase();
  if (!owner) return { ok: false, reason: 'OWNER_EMAIL is not configured' };
  const user = await deps.getUser(uid);
  const email = (user.email ?? '').trim().toLowerCase();
  if (email !== owner) return { ok: false, reason: 'This account is not the configured owner' };
  if (user.emailVerified === false) return { ok: false, reason: 'Email is not verified' };
  if (user.claims.dodo_owner === true) return { ok: true, alreadyOwner: true };
  await deps.setClaims(uid, { ...user.claims, dodo_owner: true });
  return { ok: true, alreadyOwner: false };
}
