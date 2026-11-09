/**
 * agent-browser's snapshot is the accessibility tree as YAML-ish lines, `- button "Pay" [ref=e5]`,
 * the format Playwright MCP uses too. One difference matters to dodo: elements inside an iframe
 * get plain refs (`e9`), where Playwright marks them with the frame (`f1e9`). The vault only
 * types into elements of the page itself, recognised by a plain ref, so frame content is
 * renamed here to `f<iframe ref>e<n>` before the model sees it, and mapped back on the way in.
 */

export interface MarkedSnapshot {
  text: string;
  /** Plain refs of elements inside a frame, as agent-browser names them. */
  inFrame: Set<string>;
}

const FRAME_LINE = /^(\s*)- Iframe\b.*\bref=e(\d+)\b/;

export function markFrames(snapshot: string): MarkedSnapshot {
  const inFrame = new Set<string>();
  const out: string[] = [];
  let frame: { indent: number; id: string } | undefined;
  for (const line of snapshot.split('\n')) {
    const indent = /^\s*/.exec(line)?.[0].length ?? 0;
    if (frame && line.trim() && indent <= frame.indent) frame = undefined;
    if (frame) {
      const id = frame.id;
      out.push(
        line.replace(/\bref=e(\d+)\b/g, (_m, n: string) => {
          inFrame.add(`e${n}`);
          return `ref=f${id}e${n}`;
        }),
      );
      continue;
    }
    const m = FRAME_LINE.exec(line);
    if (m) frame = { indent: m[1]?.length ?? 0, id: m[2] ?? '' };
    out.push(line);
  }
  return { text: out.join('\n'), inFrame };
}

/**
 * The model's target as agent-browser wants it: a ref becomes `@e<n>` (a frame ref loses its
 * frame part); anything else is a CSS selector and passes as it is. A plain ref of an element
 * inside a frame is refused, so `e9` can never stand for frame content.
 */
export function toTarget(
  target: unknown,
  inFrame: ReadonlySet<string>,
): { ref: string } | { error: string } {
  const t = String(target ?? '').trim();
  if (!t) return { error: 'target is required: the element ref from the page snapshot' };
  const plain = /^@?(e\d+)$/.exec(t);
  if (plain) {
    const ref = plain[1] as string;
    if (inFrame.has(ref))
      return {
        error: `${ref} is inside a frame; use its ref as the snapshot shows it (f…${ref}).`,
      };
    return { ref: `@${ref}` };
  }
  const framed = /^f\d+(e\d+)$/.exec(t);
  if (framed) return { ref: `@${framed[1]}` };
  return { ref: t };
}

/** Lines of the snapshot that match, each with a little context, for browser_find. */
export function findInSnapshot(
  snapshot: string,
  query: { text?: string; regex?: string },
  maxMatches = 30,
): string {
  let test: (line: string) => boolean;
  if (query.regex) {
    const m = /^\/(.*)\/([a-z]*)$/s.exec(query.regex);
    let re: RegExp;
    try {
      re = m
        ? new RegExp(m[1] as string, (m[2] as string).replace(/g/g, ''))
        : new RegExp(query.regex);
    } catch (err) {
      return `Invalid regular expression: ${(err as Error).message}`;
    }
    test = (l) => re.test(l);
  } else if (query.text) {
    const needle = query.text.toLowerCase();
    test = (l) => l.toLowerCase().includes(needle);
  } else return 'Give text or regex to search for.';
  const lines = snapshot.split('\n');
  const keep = new Set<number>();
  let matches = 0;
  for (let i = 0; i < lines.length && matches < maxMatches; i++) {
    if (!test(lines[i] as string)) continue;
    matches++;
    for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) keep.add(j);
  }
  if (!matches) return 'No match on this page.';
  const out: string[] = [];
  let last = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i > last + 1) out.push('…');
    out.push(lines[i] as string);
    last = i;
  }
  return `${matches}${matches >= maxMatches ? '+' : ''} match${matches === 1 ? '' : 'es'}:\n${out.join('\n')}`;
}
