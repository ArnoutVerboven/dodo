import { describe, expect, it } from 'vitest';
import { isTransientVertexError, retryVertex } from './model-provider.js';

const noSleep = async () => {};

describe('retryVertex', () => {
  it('tries again on 429 and 503 and returns the first success', async () => {
    const errors = [Object.assign(new Error('busy'), { status: 503 }), { status: 429 }];
    let calls = 0;
    const out = await retryVertex(
      async () => {
        calls++;
        const e = errors.shift();
        if (e) throw e;
        return 'ok';
      },
      [1, 1, 1],
      noSleep,
    );
    expect(out).toBe('ok');
    expect(calls).toBe(3);
  });

  it('gives up after the last delay', async () => {
    let calls = 0;
    await expect(
      retryVertex(
        async () => {
          calls++;
          throw Object.assign(new Error('down'), { status: 503 });
        },
        [1, 1],
        noSleep,
      ),
    ).rejects.toThrow('down');
    expect(calls).toBe(3);
  });

  it('does not retry a bad request', async () => {
    let calls = 0;
    await expect(
      retryVertex(
        async () => {
          calls++;
          throw Object.assign(new Error('invalid'), { status: 400 });
        },
        [1, 1],
        noSleep,
      ),
    ).rejects.toThrow('invalid');
    expect(calls).toBe(1);
  });

  it('treats a dropped connection as transient', () => {
    expect(isTransientVertexError(new Error('fetch failed: ECONNRESET'))).toBe(true);
    expect(isTransientVertexError(new Error('Model not found'))).toBe(false);
  });
});
