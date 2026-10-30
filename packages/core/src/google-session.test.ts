import { describe, expect, it } from 'vitest';
import { googleOnlyState, isGoogleDomain } from './run.js';

describe('shared Google session', () => {
  it("keeps only Google's cookies and origins", () => {
    const state = JSON.stringify({
      cookies: [
        { name: 'SID', domain: '.google.com' },
        { name: 'NID', domain: 'accounts.google.be' },
        { name: 'sess', domain: '.booking.com' },
        { name: 'x', domain: 'google.com.evil.io' },
        { name: 'y', domain: 'notgoogle.com' },
      ],
      origins: [
        { origin: 'https://accounts.google.com', localStorage: [] },
        { origin: 'https://www.booking.com', localStorage: [] },
      ],
    });
    const google = JSON.parse(googleOnlyState(state) as string);
    expect(google.cookies.map((c: { name: string }) => c.name)).toEqual(['SID', 'NID']);
    expect(google.origins).toEqual([{ origin: 'https://accounts.google.com', localStorage: [] }]);
  });

  it('has nothing to keep without Google cookies', () => {
    expect(googleOnlyState(JSON.stringify({ cookies: [{ domain: '.booking.com' }] }))).toBe(
      undefined,
    );
    expect(googleOnlyState('not json')).toBe(undefined);
    expect(isGoogleDomain('.google.co.uk')).toBe(true);
    expect(isGoogleDomain('google.evil.io')).toBe(false);
  });
});
