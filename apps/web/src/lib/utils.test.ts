import { describe, expect, it } from 'vitest';
import { pairingCode, safeHref } from './utils';

describe('safeHref', () => {
  it('keeps http(s) links and drops anything a click would run', () => {
    expect(safeHref('https://docs.google.com/d/1')).toBe('https://docs.google.com/d/1');
    expect(safeHref('http://intranet/x')).toBe('http://intranet/x');
    expect(safeHref('javascript:alert(document.cookie)')).toBeUndefined();
    expect(safeHref('JavaScript:alert(1)')).toBeUndefined();
    expect(safeHref('data:text/html,<script>1</script>')).toBeUndefined();
    expect(safeHref('vbscript:x')).toBeUndefined();
    expect(safeHref('not a url')).toBeUndefined();
    expect(safeHref(undefined)).toBeUndefined();
    expect(safeHref('')).toBeUndefined();
  });
});

describe('pairingCode', () => {
  it('is 12 lowercase letters or digits, and differs each time', () => {
    const a = pairingCode();
    const b = pairingCode();
    expect(a).toMatch(/^[a-z0-9]{12}$/);
    expect(b).toMatch(/^[a-z0-9]{12}$/);
    expect(a).not.toBe(b);
  });
});
