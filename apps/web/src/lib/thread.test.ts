import { describe, expect, it } from 'vitest';
import { pendingInputs } from './thread';

const ask = (id: string, createdAt: number, answered = false) => ({
  id,
  author: 'agent' as const,
  createdAt,
  input: {
    kind: 'text' as const,
    prompt: '?',
    ...(answered ? { answer: { value: 'x', answeredAt: createdAt + 1 } } : {}),
  },
});
const say = (id: string, createdAt: number) => ({ id, author: 'user' as const, createdAt });

describe('pendingInputs', () => {
  it('keeps an unanswered question open', () => {
    expect(pendingInputs([say('u', 1), ask('a', 2)])).toEqual({
      open: new Set(['a']),
      latest: 'a',
    });
  });

  it('closes a question once you post any later message', () => {
    expect(pendingInputs([ask('a', 1), say('u', 2)])).toEqual({ open: new Set(), latest: undefined });
  });

  it('points at the latest question that still needs you', () => {
    const r = pendingInputs([ask('a', 1), say('u', 2), ask('b', 3), ask('c', 4)]);
    expect([...r.open]).toEqual(['b', 'c']);
    expect(r.latest).toBe('c');
  });

  it('ignores answered questions', () => {
    expect(pendingInputs([ask('a', 1), ask('b', 2, true)]).latest).toBe('a');
  });
});
