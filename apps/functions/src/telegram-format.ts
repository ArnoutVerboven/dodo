/**
 * Markdown (as the agent writes it) to Telegram's HTML subset, deterministically. Telegram shows
 * `**bold**` and `- item` literally, so messages are converted here rather than written for it.
 * Supported: fenced and inline code, bold, italic, strikethrough, links, headings, bullet and
 * numbered lists, quotes, rules. Everything else is escaped text.
 */
export function markdownToTelegram(md: string): string {
  const out: string[] = [];
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      while (++i < lines.length && !(lines[i] as string).trim().startsWith(fence[1] as string))
        body.push(lines[i] as string);
      const lang = fence[2] ? ` class="language-${fence[2]}"` : '';
      out.push(`<pre><code${lang}>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    out.push(block(line));
  }
  // Collapse runs of blank lines that headings and rules can leave behind.
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function block(line: string): string {
  const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
  if (heading) return `<b>${inline(heading[1] as string)}</b>`;
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return '──────────';
  const bullet = /^(\s*)[-*+]\s+(?:\[( |x|X)\]\s+)?(.*)$/.exec(line);
  if (bullet) {
    const depth = Math.floor((bullet[1] as string).replace(/\t/g, '  ').length / 2);
    const mark = bullet[2] === undefined ? (depth ? '◦' : '•') : bullet[2] === ' ' ? '☐' : '☑';
    return `${'   '.repeat(depth)}${mark} ${inline(bullet[3] as string)}`;
  }
  const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
  if (numbered) {
    const depth = Math.floor((numbered[1] as string).length / 2);
    return `${'   '.repeat(depth)}${numbered[2]}. ${inline(numbered[3] as string)}`;
  }
  const quote = /^\s*>\s?(.*)$/.exec(line);
  if (quote) return `<blockquote>${inline(quote[1] as string)}</blockquote>`;
  return inline(line);
}

/** Inline spans. Code is cut out first so nothing inside it is formatted. */
function inline(text: string): string {
  const codes: string[] = [];
  let s = text.replace(/`([^`\n]+)`/g, (_, c: string) => {
    codes.push(`<code>${esc(c)}</code>`);
    return `\uE000${codes.length - 1}\uE000`;
  });
  const links: string[] = [];
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label: string, url: string) => {
    links.push(`<a href="${esc(url).replace(/"/g, '&quot;')}">${spans(esc(label))}</a>`);
    return `\uE001${links.length - 1}\uE001`;
  });
  s = spans(esc(s));
  return s
    .replace(/\uE001(\d+)\uE001/g, (_, n: string) => links[Number(n)] as string)
    .replace(/\uE000(\d+)\uE000/g, (_, n: string) => codes[Number(n)] as string);
}

function spans(s: string): string {
  return s
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<b>$1</b>')
    .replace(/__(?=\S)(.+?)(?<=\S)__/g, '<b>$1</b>')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '<s>$1</s>')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|[^\w])_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/g, '$1<i>$2</i>');
}

export const esc = (s: string) =>
  s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
