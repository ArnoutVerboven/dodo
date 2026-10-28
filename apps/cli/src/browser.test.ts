import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  browserReport,
  EXTENSION_ID,
  endedWaitingInput,
  profilesWithExtension,
} from './browser.js';

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

describe.runIf(process.platform === 'darwin')('browserReport on a Mac', () => {
  it('needs Chrome and nothing else: its own window by default', () => {
    const dir = chrome();
    process.env.DODO_CHROME_USER_DATA_DIR = dir;
    process.env.DODO_CHROME_APP = path.join(dir, 'missing');
    expect(browserReport({})).toMatchObject({
      state: 'unavailable',
      problems: [expect.stringMatching(/Chrome not found/)],
    });
    writeFileSync(path.join(dir, 'chrome'), '');
    process.env.DODO_CHROME_APP = path.join(dir, 'chrome');
    expect(browserReport({})).toMatchObject({
      state: 'ready',
      mode: 'window',
      warnings: [expect.stringMatching(/own Chrome window/)],
    });
  });

  it('prefers the extension when installed, unless told otherwise', () => {
    const dir = chrome();
    mkdirSync(path.join(dir, 'Default', 'Extensions', EXTENSION_ID), { recursive: true });
    writeFileSync(path.join(dir, 'chrome'), '');
    process.env.DODO_CHROME_USER_DATA_DIR = dir;
    process.env.DODO_CHROME_APP = path.join(dir, 'chrome');
    expect(browserReport({})).toMatchObject({
      mode: 'extension',
      warnings: [expect.stringMatching(/allow the first connection/)],
    });
    expect(browserReport({ browser: { token: 't' } }).warnings).toEqual([]);
    expect(browserReport({ browser: { mode: 'window' } }).mode).toBe('window');
  });
});

describe.runIf(process.platform !== 'darwin')('browserReport elsewhere', () => {
  it('says macOS only', () => {
    expect(browserReport({}).problems.join('\n')).toMatch(/macOS only/);
  });
});

describe('endedWaitingInput', () => {
  it("spots the worker's closing line for a question to the user", () => {
    expect(endedWaitingInput('run abc ended: waiting_input after 7 steps')).toBe(true);
    expect(endedWaitingInput('run abc ended: finished after 7 steps')).toBe(false);
  });
});
