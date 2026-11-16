import { describe, expect, it } from 'vitest';
import { plainTitle } from './title.js';

describe('plainTitle', () => {
  it('takes the first non-empty line without markdown marks', () => {
    expect(plainTitle('\n## Book the dentist\nfor next week')).toBe('Book the dentist');
    expect(plainTitle('- renew passport')).toBe('renew passport');
  });

  it('keeps an ordinary long line whole', () => {
    const line = "log in to albert heijn and tell me what's in my shopping cart and what it costs";
    expect(plainTitle(line)).toBe(line);
  });

  it('cuts only a very long line, at a word', () => {
    const t = plainTitle('word '.repeat(60));
    expect(t.length).toBeLessThanOrEqual(201);
    expect(t.endsWith('word…')).toBe(true);
  });
});
