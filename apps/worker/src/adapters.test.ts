import { describe, expect, it } from 'vitest';
import { readStoredFile } from './adapters.js';

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
