import { AGENT_SYSTEM } from '@dodo/core';
import { describe, expect, it } from 'vitest';
import { harnessConformance } from './conformance.js';
import { HARNESSES } from './harness.js';
import { systemPrompt } from './prompt.js';
import { sampleTask } from './testing.js';

harnessConformance(HARNESSES);

describe('system prompt layers', () => {
  it('adds a harness section after the tool sections and before the project', () => {
    const project = {
      id: 'p',
      name: 'Home',
      description: '',
      instructions: 'Be brief.',
    } as unknown as Parameters<typeof systemPrompt>[1];
    const text = systemPrompt(sampleTask(), project, {
      notion: {},
      harness: 'HARNESS SECTION',
    });
    expect(text.startsWith(AGENT_SYSTEM)).toBe(true);
    const at = text.indexOf('HARNESS SECTION');
    expect(at).toBeGreaterThan(text.indexOf('Notion'));
    expect(at).toBeLessThan(text.indexOf('Be brief.'));
    expect(systemPrompt(sampleTask(), undefined, {})).toBe(AGENT_SYSTEM);
  });
});
