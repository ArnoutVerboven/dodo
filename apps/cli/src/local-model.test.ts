import { describe, expect, it } from 'vitest';
import { checkLocalModel, isLoopback, normaliseBaseUrl } from './local-model.js';

describe('local model settings', () => {
  it('normalises the server URL to its /v1 base', () => {
    expect(normaliseBaseUrl('http://localhost:8080')).toBe('http://localhost:8080/v1');
    expect(normaliseBaseUrl('http://localhost:1234/v1/')).toBe('http://localhost:1234/v1');
    expect(normaliseBaseUrl('http://127.0.0.1:11434/v1/chat/completions')).toBe(
      'http://127.0.0.1:11434/v1',
    );
    expect(() => normaliseBaseUrl('ftp://localhost')).toThrow(/http/);
  });

  it('accepts only this Mac', () => {
    expect(isLoopback('http://localhost:8080/v1')).toBe(true);
    expect(isLoopback('http://127.0.0.1:8080/v1')).toBe(true);
    expect(isLoopback('http://192.168.1.4:8080/v1')).toBe(false);
  });

  it('reports the models and whether the model calls tools', async () => {
    const fetchFn = (async (url: string) =>
      url.endsWith('/models')
        ? new Response(JSON.stringify({ data: [{ id: 'qwen' }] }))
        : new Response(
            JSON.stringify({
              choices: [{ message: { tool_calls: [{ function: { name: 'set_status' } }] } }],
            }),
          )) as unknown as typeof fetch;
    const r = await checkLocalModel({ url: 'http://localhost:8080' }, fetchFn);
    expect(r).toMatchObject({ ok: true, models: ['qwen'], toolCalls: true });
  });

  it('says so when nothing answers', async () => {
    const fetchFn = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const r = await checkLocalModel({ url: 'http://localhost:8080' }, fetchFn);
    expect(r.ok).toBe(false);
    expect(r.problem).toMatch(/nothing answers/);
  });
});
