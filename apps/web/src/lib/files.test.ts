import { describe, expect, it } from 'vitest';
import { extension, isTextual, previewKind } from './files';

describe('previewKind', () => {
  it('reads the extension', () => {
    expect(previewKind('notes.md')).toBe('markdown');
    expect(previewKind('Plan.MD')).toBe('markdown');
    expect(previewKind('data.csv')).toBe('text');
    expect(previewKind('photo.JPG')).toBe('image');
    expect(previewKind('invoice.pdf')).toBe('pdf');
    expect(previewKind('archive.zip')).toBe('none');
  });
  it('falls back to the MIME type', () => {
    expect(previewKind('scan', 'image/png')).toBe('image');
    expect(previewKind('readme', 'text/plain')).toBe('text');
    expect(previewKind('report', 'application/pdf')).toBe('pdf');
  });
  it('treats dotfiles and names without a dot as having no extension', () => {
    expect(extension('.env')).toBe('');
    expect(extension('Makefile')).toBe('');
  });
  it('knows which files can be kept as text', () => {
    expect(isTextual('a.md')).toBe(true);
    expect(isTextual('a.json')).toBe(true);
    expect(isTextual('a.png')).toBe(false);
  });
});
