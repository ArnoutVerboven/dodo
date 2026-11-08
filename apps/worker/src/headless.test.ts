import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  browserEnv,
  browserUser,
  chromeUserAgent,
  headlessShellPath,
  parseStorageState,
} from './headless.js';

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

describe('browser user', () => {
  it('is off unless the image sets it, and refuses nonsense', () => {
    expect(browserUser({})).toBeUndefined();
    expect(() => browserUser({ DODO_BROWSER_UID: 'x' })).toThrow(/positive integers/);
  });

  it('hands Chromium only what it needs, never the run token', () => {
    const user = { uid: 10002, gid: 10002, home: '/home/browser', wrapper: '/w' };
    const env = browserEnv(user, '/ms/chrome', {
      PATH: '/usr/bin',
      DODO_RUN_TOKEN: 'secret',
      FIREBASE_API_KEY: 'k',
      TZ: 'Europe/Brussels',
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/browser',
      LANG: 'C.UTF-8',
      TZ: 'Europe/Brussels',
      DODO_CHROMIUM: '/ms/chrome',
      DODO_BROWSER_UID: '10002',
      DODO_BROWSER_GID: '10002',
    });
  });

  it('finds the headless shell Playwright would launch', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pw-'));
    expect(headlessShellPath(dir, '/full')).toBe('/full');
    const bin = path.join(dir, 'chromium_headless_shell-1243', 'chrome-headless-shell-linux64');
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, 'chrome-headless-shell'), '');
    expect(headlessShellPath(dir, '/full')).toBe(path.join(bin, 'chrome-headless-shell'));
    expect(headlessShellPath(undefined, '/full')).toBe('/full');
  });
});
