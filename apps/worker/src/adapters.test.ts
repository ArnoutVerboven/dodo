import { describe, expect, it } from 'vitest';
import { isTransient, readStoredFile, withRetry } from './adapters.js';

const respond = (body: string, type: string, status = 200) =>
  (async () => new Response(body, { status, headers: { 'content-type': type } })) as typeof fetch;

describe('readStoredFile', () => {
  it('returns the text of a Markdown upload', async () => {
    expect(
      await readStoredFile('plan.md', 'https://x/plan.md', respond('# Plan', 'text/markdown')),
    ).toBe('# Plan');
  });
  it('reads text by content type when the name has no extension', async () => {
    expect(await readStoredFile('notes', 'https://x/n', respond('hi', 'text/plain'))).toBe('hi');
  });
  it('describes a binary file instead of dumping it', async () => {
    const out = await readStoredFile('photo.png', 'https://x/p', respond('\u0000', 'image/png'));
    expect(out).toContain('image/png');
    expect(out).toContain('https://x/p');
  });
  it('reports a failed download', async () => {
    expect(await readStoredFile('a.md', 'https://x/a', respond('', 'text/plain', 403))).toContain(
      'HTTP 403',
    );
  });
  it('cuts very long text', async () => {
    const out = await readStoredFile(
      'big.txt',
      'https://x/b',
      respond('a'.repeat(300_000), 'text/plain'),
    );
    expect(out).toContain('[cut at 200000 of 300000 characters]');
  });
});

describe('withRetry', () => {
  const noSleep = async () => {};
  const failing = (code: string, message = 'x') => Object.assign(new Error(message), { code });

  it('retries transient callable errors and returns the first success', async () => {
    const errors = [failing('functions/unavailable'), failing('functions/deadline-exceeded')];
    let calls = 0;
    const out = await withRetry(
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

  it('never retries a refusal: lease, budget or the kill switch', async () => {
    for (const err of [
      failing('functions/failed-precondition', 'lease_lost'),
      failing('functions/resource-exhausted', 'budget_exhausted(task): …'),
      failing('functions/unavailable', 'halted'),
    ]) {
      let calls = 0;
      await expect(
        withRetry(
          async () => {
            calls++;
            throw err;
          },
          [1, 1],
          noSleep,
        ),
      ).rejects.toBe(err);
      expect(calls).toBe(1);
    }
  });

  it('gives up after the last delay', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw failing('functions/internal');
        },
        [1, 1],
        noSleep,
      ),
    ).rejects.toThrow();
    expect(calls).toBe(3);
  });

  it('knows which errors are transient', () => {
    expect(isTransient(failing('functions/unavailable'))).toBe(true);
    expect(isTransient(failing('functions/unavailable', 'halted'))).toBe(false);
    expect(isTransient(failing('functions/permission-denied'))).toBe(false);
  });
});
