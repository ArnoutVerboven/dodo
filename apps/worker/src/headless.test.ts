import { describe, expect, it } from 'vitest';
import { chromeUserAgent } from './headless.js';

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
