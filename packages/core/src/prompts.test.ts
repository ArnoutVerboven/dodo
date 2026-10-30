import { describe, expect, it } from 'vitest';
import { AGENT_SYSTEM, JOB_RECHECK_SYSTEM, PHONE_APP_LOGIN, PROMPTS } from './prompts.js';

describe('PROMPTS catalog', () => {
  it('has unique ids and every entry is filled in', () => {
    const ids = PROMPTS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PROMPTS) {
      expect(p.name.trim()).not.toBe('');
      expect(p.purpose.trim()).not.toBe('');
      expect(p.text.trim()).not.toBe('');
    }
  });

  it('shows the texts the code sends', () => {
    const text = (id: string) => PROMPTS.find((p) => p.id === id)?.text;
    expect(text('agent-system')).toBe(AGENT_SYSTEM);
    expect(text('agent-phone-login')).toBe(PHONE_APP_LOGIN);
    expect(text('job-recheck')).toBe(JOB_RECHECK_SYSTEM);
  });
});
