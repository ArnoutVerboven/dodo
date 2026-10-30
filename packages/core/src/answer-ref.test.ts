import { describe, expect, it } from 'vitest';
import { answerTurn } from './prompts.js';
import { answerRef, answerRefs, hasSecretRefs, secretAnswerId } from './vault.js';

describe('secret answer references', () => {
  it('finds each reference once and tells a lone reference apart', () => {
    expect(answerRefs(`${answerRef('m1')} ${answerRef('m1')} {{answer:bad id}}`)).toEqual([
      { messageId: 'm1', ref: '{{answer:m1}}' },
    ]);
    expect(secretAnswerId('{{answer:m1}}')).toBe('m1');
    expect(secretAnswerId('code {{answer:m1}}')).toBeUndefined();
    expect(hasSecretRefs('{{answer:m1}}')).toBe(true);
    expect(hasSecretRefs('{{vault:energy.password}}')).toBe(true);
    expect(hasSecretRefs('plain')).toBe(false);
  });

  it('tells the model how to use a secret answer without showing a value', () => {
    expect(answerTurn('SMS code?', '{{answer:m1}}')).toContain('browser_type, text {{answer:m1}}');
    expect(answerTurn('Which?', 'B')).toBe('Answer to your question "Which?":\nB');
  });
});
