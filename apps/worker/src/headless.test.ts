import { describe, expect, it } from 'vitest';
import { chromeUserAgent, parseStorageState } from './headless.js';

describe('chromeUserAgent', () => {
  it('names the installed Chromium as a headed Chrome', () => {
    const ua = chromeUserAgent('155.0.8059.12');
    expect(ua).toContain('Chrome/155.0.0.0');
    expect(ua).not.toMatch(/headless/i);
  });

  it('falls back to a plausible version when none is known', () => {
    expect(chromeUserAgent('')).toMatch(/Chrome\/\d+\.0\.0\.0 Safari/);
  });
});

describe('parseStorageState', () => {
  it('takes a stored state and starts fresh on anything else', () => {
    const state = JSON.stringify({ cookies: [{ name: 'a', value: 'b' }], origins: [] });
    expect(parseStorageState(state)).toEqual({ cookies: [{ name: 'a', value: 'b' }], origins: [] });
    expect(parseStorageState(JSON.stringify({ origins: [] }))).toEqual({
      cookies: [],
      origins: [],
    });
    expect(parseStorageState(undefined)).toBeUndefined();
    expect(parseStorageState('not json')).toBeUndefined();
    expect(parseStorageState('{"x":1}')).toBeUndefined();
    expect(parseStorageState('null')).toBeUndefined();
  });
});
