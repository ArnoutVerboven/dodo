/** How the app can show a task file, judged from its name (and MIME type when known). */
export type PreviewKind = 'markdown' | 'text' | 'image' | 'pdf' | 'none';

const MARKDOWN = new Set(['md', 'markdown', 'mdx']);
const TEXT = new Set([
  'txt', 'text', 'log', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'xml',
  'html', 'htm', 'css', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java',
  'sh', 'sql', 'env', 'ics', 'vcf', 'srt',
]);
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico']);

export function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function previewKind(name: string, contentType?: string): PreviewKind {
  const ext = extension(name);
  if (MARKDOWN.has(ext) || contentType === 'text/markdown') return 'markdown';
  if (IMAGE.has(ext) || contentType?.startsWith('image/')) return 'image';
  if (ext === 'pdf' || contentType === 'application/pdf') return 'pdf';
  if (TEXT.has(ext) || contentType?.startsWith('text/') || contentType === 'application/json')
    return 'text';
  return 'none';
}

/** Whether a file's content can be kept as plain text, so the agent reads it directly. */
export function isTextual(name: string, contentType?: string): boolean {
  const k = previewKind(name, contentType);
  return k === 'markdown' || k === 'text';
}

/** Saves a blob under a file name through a temporary link. */
export function saveBlob(blob: Blob, name: string) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}
