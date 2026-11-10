import { FakeControlPlane } from '@dodo/agent';
import { describe, expect, it } from 'vitest';
import { pickHarness } from './harness-choice.js';

describe('pickHarness', () => {
  const control = new FakeControlPlane([]);
  const noGemini = Object.assign(new FakeControlPlane([]), { geminiEndpoint: undefined });

  it("uses pi by default, and dodo's loop when it is asked for", () => {
    expect(pickHarness(undefined, control, 'gemini-3.8-flash').id).toBe('pi');
    expect(pickHarness('dodo-loop', control, 'gemini-3.8-flash').id).toBe('dodo-loop');
  });

  it('runs pi on a Gemini model when the control plane has the Gemini endpoint', () => {
    expect(pickHarness('pi', control, 'gemini-3.8-flash').id).toBe('pi');
  });

  it("falls back to dodo's loop on the local model or without the endpoint", () => {
    expect(pickHarness('pi', control, 'local').id).toBe('dodo-loop');
    expect(pickHarness('pi', noGemini, 'gemini-3.8-flash').id).toBe('dodo-loop');
    expect(pickHarness(undefined, control, 'local').id).toBe('dodo-loop');
  });
});
