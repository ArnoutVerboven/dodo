import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Every callable must say who may call it. A guard is easy to forget when a new function is
 * copied from another one, and nothing else would notice: this reads index.ts and checks that
 * each `onCall` body has one of the known guards.
 */
const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

/** Callables that check the caller themselves, or need no sign-in on purpose (and why). */
const SELF_GUARDED: Record<string, string> = {
  claimOwnership: 'checks the signed-in email against OWNER_EMAIL',
  deviceRegister: 'unauthenticated on purpose: the single-use pairing code is the proof',
  deviceClaim: 'claimRun checks the device identity',
  deviceEgress: 'egressCheck checks the device identity',
  deviceRelease: 'releaseRun checks the device identity',
  apiTokenCreate: 'checks the dodo_owner claim inline',
};

const GUARDS = [/ownerOnly\(request\.auth\)/, /loadRunForCaller\(/];

function callables(): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const re = /export const (\w+) = onCall\(/g;
  const starts = [...source.matchAll(re)];
  starts.forEach((m, i) => {
    const end = starts[i + 1]?.index ?? source.length;
    out.push({ name: m[1] as string, body: source.slice(m.index, end) });
  });
  return out;
}

describe('callable guards', () => {
  it('finds the callables', () => {
    expect(callables().length).toBeGreaterThan(20);
  });

  for (const { name, body } of callables()) {
    it(`${name} checks its caller`, () => {
      if (name in SELF_GUARDED) return;
      expect(
        GUARDS.some((g) => g.test(body)),
        `${name}: no ownerOnly() or loadRunForCaller(); add one, or list it in SELF_GUARDED with the reason`,
      ).toBe(true);
    });
  }

  it('lists no callable as self-guarded that does not exist', () => {
    const names = new Set(callables().map((c) => c.name));
    for (const name of Object.keys(SELF_GUARDED)) expect(names.has(name), name).toBe(true);
  });
});
