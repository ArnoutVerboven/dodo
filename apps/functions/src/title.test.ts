import { describe, expect, it } from 'vitest';
import { plainTitle } from './title.js';

describe('plainTitle', () => {
  it('takes the first non-empty line without markdown marks', () => {
    expect(plainTitle('\n## Book the dentist\nfor next week')).toBe('Book the dentist');
    expect(plainTitle('- renew passport')).toBe('renew passport');
  });

  it('cuts a long line at a word', () => {
    const t = plainTitle(
      'Find out which energy contract is cheapest for our house given last year usage and switch',
    );
    expect(t.length).toBeLessThanOrEqual(61);
    expect(t.endsWith('…')).toBe(true);
    expect(t).toBe('Find out which energy contract is cheapest for our house…');
  });
});
