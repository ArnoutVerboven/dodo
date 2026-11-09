import { describe, expect, it } from 'vitest';
import { parseBatch } from './cli.js';
import { findInSnapshot, markFrames, toTarget } from './snapshot.js';

const SNAP = `- heading "Log in" [level=1, ref=e1]
- textbox "Email" [ref=e2]
- Iframe "captcha" [ref=e3]
  - textbox "Code" [ref=e4]
  - button "Verify" [ref=e5]
- button "Continue" [ref=e6]`;

describe('markFrames', () => {
  it('renames refs inside a frame and remembers them', () => {
    const m = markFrames(SNAP);
    expect(m.text).toContain('textbox "Code" [ref=f3e4]');
    expect(m.text).toContain('button "Verify" [ref=f3e5]');
    expect(m.text).toContain('button "Continue" [ref=e6]');
    expect(m.text).toContain('Iframe "captcha" [ref=e3]');
    expect([...m.inFrame].sort()).toEqual(['e4', 'e5']);
  });
});

describe('toTarget', () => {
  const inFrame = new Set(['e4']);
  it('maps refs to agent-browser refs', () => {
    expect(toTarget('e2', inFrame)).toEqual({ ref: '@e2' });
    expect(toTarget('@e2', inFrame)).toEqual({ ref: '@e2' });
    expect(toTarget('f3e4', inFrame)).toEqual({ ref: '@e4' });
    expect(toTarget('#email', inFrame)).toEqual({ ref: '#email' });
  });
  it('refuses a plain ref that is really inside a frame', () => {
    expect(toTarget('e4', inFrame)).toHaveProperty('error');
    expect(toTarget('', inFrame)).toHaveProperty('error');
  });
});

describe('findInSnapshot', () => {
  it('finds text with context, and regexes with flags', () => {
    expect(findInSnapshot(SNAP, { text: 'verify' })).toContain('button "Verify"');
    expect(findInSnapshot(SNAP, { regex: '/CONTINUE/i' })).toContain('1 match');
    expect(findInSnapshot(SNAP, { text: 'nothing here' })).toBe('No match on this page.');
    expect(findInSnapshot(SNAP, { regex: '(' })).toContain('Invalid');
  });
});

describe('parseBatch', () => {
  it('reads one row per command', () => {
    const out = JSON.stringify([
      { success: true, index: 0, result: { url: 'https://a.test/' }, error: null },
      { success: false, index: 1, result: null, error: 'Unknown ref: e9' },
    ]);
    expect(parseBatch(out, 3)).toEqual([
      { ok: true, data: { url: 'https://a.test/' } },
      { ok: false, data: {}, error: 'Unknown ref: e9' },
      { ok: false, data: {}, error: 'not run' },
    ]);
  });
  it('fails every command when the output is not JSON', () => {
    expect(parseBatch('boom', 2, 'daemon failed')).toEqual([
      { ok: false, data: {}, error: 'daemon failed' },
      { ok: false, data: {}, error: 'daemon failed' },
    ]);
  });
});
