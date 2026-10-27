import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { browserReport, EXTENSION_ID, profilesWithExtension } from './browser.js';

const chrome = () => mkdtempSync(path.join(os.tmpdir(), 'dodo-chrome-'));

describe('profilesWithExtension', () => {
  it('finds the extension by its folder or its settings record, in any profile', () => {
    const dir = chrome();
    mkdirSync(path.join(dir, 'Default'), { recursive: true });
    mkdirSync(path.join(dir, 'Profile 1', 'Extensions', EXTENSION_ID), { recursive: true });
    mkdirSync(path.join(dir, 'Profile 2'), { recursive: true });
    writeFileSync(
      path.join(dir, 'Profile 2', 'Preferences'),
      JSON.stringify({ extensions: { settings: { [EXTENSION_ID]: { state: 1 } } } }),
    );
    mkdirSync(path.join(dir, 'Guest Profile', 'Extensions', EXTENSION_ID), { recursive: true });
    expect(profilesWithExtension(dir)).toEqual(['Profile 1', 'Profile 2']);
  });

  it('is empty without Chrome', () => {
    expect(profilesWithExtension(path.join(chrome(), 'missing'))).toEqual([]);
  });
});

describe('browserReport', () => {
  it('names each missing piece', () => {
    process.env.DODO_CHROME_USER_DATA_DIR = chrome();
    const r = browserReport({});
    expect(r.state).toBe('unavailable');
    expect(r.problems.join('\n')).toMatch(/dodo browser connect/);
    if (process.platform === 'darwin') expect(r.problems.join('\n')).toMatch(/not installed/);
    else expect(r.problems.join('\n')).toMatch(/macOS only/);
  });
});
