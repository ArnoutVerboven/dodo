/**
 * Notion blocks and properties to and from what the model reads and writes: Markdown for page
 * content, plain values for properties. Pure functions; apps/functions/src/notion.ts does the
 * API calls.
 */

export type Json = Record<string, unknown>;

/* ------------------------------ rich text ------------------------------ */

interface RichText {
  plain_text?: string;
  href?: string | null;
  text?: { content: string; link?: { url: string } | null };
  annotations?: { bold?: boolean; italic?: boolean; strikethrough?: boolean; code?: boolean };
}

/** Notion rich text as Markdown (bold, italic, strike, code, links). */
export function richToMarkdown(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return (parts as RichText[])
    .map((p) => {
      let t = p.plain_text ?? p.text?.content ?? '';
      if (!t) return '';
      const a = p.annotations ?? {};
      if (a.code) t = `\`${t}\``;
      if (a.bold) t = `**${t}**`;
      if (a.italic) t = `*${t}*`;
      if (a.strikethrough) t = `~~${t}~~`;
      const href = p.href ?? p.text?.link?.url;
      return href ? `[${t}](${href})` : t;
    })
    .join('');
}

export const plainText = (parts: unknown): string =>
  Array.isArray(parts)
    ? (parts as RichText[]).map((p) => p.plain_text ?? p.text?.content ?? '').join('')
    : '';

/** Notion caps one text object at 2000 characters. */
const TEXT_MAX = 2000;

function textPart(content: string, ann: RichText['annotations'] = {}, url?: string): Json[] {
  const out: Json[] = [];
  for (let i = 0; i < content.length; i += TEXT_MAX) {
    const chunk = content.slice(i, i + TEXT_MAX);
    const annotations = Object.fromEntries(Object.entries(ann).filter(([, v]) => v));
    out.push({
      type: 'text',
      text: { content: chunk, ...(url ? { link: { url } } : {}) },
      ...(Object.keys(annotations).length ? { annotations } : {}),
    });
  }
  return out;
}

/** Inline Markdown (**bold**, *italic*, _italic_, ~~strike~~, `code`, [text](url)) as rich text. */
export function markdownToRich(text: string): Json[] {
  const out: Json[] = [];
  const re =
    /(\*\*([^*]+?)\*\*)|(~~([^~]+?)~~)|(`([^`]+?)`)|(\[([^\]]+?)\]\(([^)\s]+?)\))|(\*([^*\s][^*]*?)\*)|(\b_([^_]+?)_\b)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push(...textPart(text.slice(last, i)));
    if (m[2] !== undefined) out.push(...textPart(m[2], { bold: true }));
    else if (m[4] !== undefined) out.push(...textPart(m[4], { strikethrough: true }));
    else if (m[6] !== undefined) out.push(...textPart(m[6], { code: true }));
    else if (m[8] !== undefined) {
      const url = m[9] as string;
      out.push(...textPart(m[8], {}, /^https?:\/\//.test(url) ? url : undefined));
    } else if (m[11] !== undefined) out.push(...textPart(m[11], { italic: true }));
    else if (m[13] !== undefined) out.push(...textPart(m[13], { italic: true }));
    last = i + m[0].length;
  }
  if (last < text.length) out.push(...textPart(text.slice(last)));
  return out;
}

/* ------------------------------ blocks out ------------------------------ */

export interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  /** Filled in by the reader for blocks with children. */
  children?: NotionBlock[];
  [type: string]: unknown;
}

const fileUrl = (v: Json | undefined) =>
  ((v?.file as Json | undefined)?.url ?? (v?.external as Json | undefined)?.url ?? v?.url) as
    | string
    | undefined;

/** Blocks (with children already fetched) as Markdown. */
export function blocksToMarkdown(blocks: NotionBlock[], indent = ''): string {
  const lines: string[] = [];
  let n = 0;
  for (const b of blocks) {
    const v = (b[b.type] ?? {}) as Json;
    const text = richToMarkdown(v.rich_text);
    const kids = b.children?.length ? blocksToMarkdown(b.children, `${indent}  `) : '';
    if (b.type !== 'numbered_list_item') n = 0;
    switch (b.type) {
      case 'paragraph':
        lines.push(`${indent}${text}`);
        break;
      case 'heading_1':
      case 'heading_2':
      case 'heading_3':
        lines.push(`${indent}${'#'.repeat(Number(b.type.at(-1)))} ${text}`);
        break;
      case 'bulleted_list_item':
        lines.push(`${indent}- ${text}`);
        break;
      case 'numbered_list_item':
        n += 1;
        lines.push(`${indent}${n}. ${text}`);
        break;
      case 'to_do':
        lines.push(`${indent}- [${v.checked ? 'x' : ' '}] ${text}`);
        break;
      case 'toggle':
        lines.push(`${indent}- ▸ ${text}`);
        break;
      case 'quote':
        lines.push(`${indent}> ${text}`);
        break;
      case 'callout': {
        const icon = (v.icon as Json | undefined)?.emoji;
        lines.push(`${indent}> ${icon ? `${String(icon)} ` : ''}${text}`);
        break;
      }
      case 'code':
        lines.push(
          `${indent}\`\`\`${v.language && v.language !== 'plain text' ? String(v.language) : ''}`,
          ...plainText(v.rich_text)
            .split('\n')
            .map((l) => `${indent}${l}`),
          `${indent}\`\`\``,
        );
        break;
      case 'equation':
        lines.push(`${indent}$$${String(v.expression ?? '')}$$`);
        break;
      case 'divider':
        lines.push(`${indent}---`);
        break;
      case 'child_page':
        lines.push(`${indent}[Page: ${String(v.title ?? '')}] (id ${b.id})`);
        break;
      case 'child_database':
        lines.push(`${indent}[Database: ${String(v.title ?? '')}] (id ${b.id})`);
        break;
      case 'image':
      case 'file':
      case 'pdf':
      case 'video':
      case 'audio': {
        const caption = richToMarkdown(v.caption);
        lines.push(`${indent}[${b.type}${caption ? `: ${caption}` : ''}](${fileUrl(v) ?? ''})`);
        break;
      }
      case 'bookmark':
      case 'embed':
      case 'link_preview':
        lines.push(`${indent}${String(v.url ?? '')}`);
        break;
      case 'table_row': {
        const cells = (v.cells as unknown[] | undefined) ?? [];
        lines.push(`${indent}| ${cells.map((c) => richToMarkdown(c)).join(' | ')} |`);
        break;
      }
      case 'table':
      case 'column_list':
      case 'column':
      case 'synced_block':
        // Containers: their children carry the content, at the same depth.
        if (b.children?.length) lines.push(blocksToMarkdown(b.children, indent));
        continue;
      case 'unsupported':
        break;
      default:
        if (text) lines.push(`${indent}${text}`);
    }
    if (kids) lines.push(kids);
  }
  return lines.join('\n');
}

/* ------------------------------ blocks in ------------------------------ */

const block = (type: string, value: Json): Json => ({ object: 'block', type, [type]: value });

/** Notion code languages are a fixed list; anything else is "plain text". */
const LANGS = new Set([
  'bash',
  'c',
  'c++',
  'c#',
  'css',
  'diff',
  'go',
  'html',
  'java',
  'javascript',
  'json',
  'kotlin',
  'markdown',
  'python',
  'ruby',
  'rust',
  'shell',
  'sql',
  'swift',
  'typescript',
  'yaml',
  'xml',
]);
const LANG_ALIAS: Record<string, string> = {
  sh: 'shell',
  zsh: 'shell',
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  yml: 'yaml',
  md: 'markdown',
  cpp: 'c++',
};

interface Item {
  depth: number;
  block: Json;
}

/** Markdown as Notion blocks; nested lists become children (two levels, Notion's limit per call). */
export function markdownToBlocks(md: string): Json[] {
  const items: Item[] = [];
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  let para: string[] = [];
  const flush = () => {
    if (para.length) items.push({ depth: 0, block: rich('paragraph', para.join('\n')) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string;
    const line = raw.trimEnd();
    const fence = /^\s*```\s*([\w+#-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i] as string); i++)
        body.push(lines[i] as string);
      const l = (fence[1] ?? '').toLowerCase();
      const language = LANG_ALIAS[l] ?? (LANGS.has(l) ? l : 'plain text');
      items.push({
        depth: 0,
        block: block('code', { rich_text: textPart(body.join('\n')), language }),
      });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const depth = Math.min(
      2,
      Math.floor((/^\s*/.exec(raw)?.[0].replace(/\t/g, '  ').length ?? 0) / 2),
    );
    const t = line.trim();
    const found = lineBlock(t, depth);
    if (found) {
      flush();
      items.push(found);
    } else {
      para.push(t);
    }
  }
  flush();

  // Nest: an item deeper than the one before goes into that one's children.
  const top: Json[] = [];
  const stack: Item[] = [];
  for (const it of items) {
    while (stack.length && (stack.at(-1) as Item).depth >= it.depth) stack.pop();
    const parent = stack.at(-1);
    const nestable = parent && it.depth > parent.depth && canHold(parent.block);
    if (nestable) {
      const v = (parent.block as Json)[parent.block.type as string] as Json;
      const kids = (v.children as Json[] | undefined) ?? [];
      kids.push(it.block);
      v.children = kids;
      it.depth = parent.depth + 1;
    } else {
      it.depth = 0;
      top.push(it.block);
    }
    stack.push(it);
  }
  return top;
}

/** One Markdown line that is a block of its own (heading, list item, quote, divider). */
function lineBlock(t: string, depth: number): Item | undefined {
  const h = /^(#{1,6})\s+(.*)$/.exec(t);
  if (h) {
    const level = Math.min(3, (h[1] as string).length);
    return { depth: 0, block: rich(`heading_${level}`, h[2] as string) };
  }
  const todo = /^[-*+]\s+\[([ xX])\]\s*(.*)$/.exec(t);
  if (todo)
    return {
      depth,
      block: block('to_do', {
        rich_text: markdownToRich(todo[2] as string),
        checked: (todo[1] as string).toLowerCase() === 'x',
      }),
    };
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) return { depth: 0, block: block('divider', {}) };
  const bullet = /^[-*+]\s+(.*)$/.exec(t);
  if (bullet) return { depth, block: rich('bulleted_list_item', bullet[1] as string) };
  const num = /^\d+[.)]\s+(.*)$/.exec(t);
  if (num) return { depth, block: rich('numbered_list_item', num[1] as string) };
  const quote = /^>\s?(.*)$/.exec(t);
  if (quote) return { depth: 0, block: rich('quote', quote[1] as string) };
  return undefined;
}

const canHold = (b: Json) =>
  ['bulleted_list_item', 'numbered_list_item', 'to_do'].includes(b.type as string);

function rich(type: string, text: string): Json {
  return block(type, { rich_text: markdownToRich(text) });
}

/* ------------------------------ properties ------------------------------ */

const name = (v: unknown) => (v as { name?: string } | null)?.name;

/** A property value as a plain value for the model. */
export function propertyOut(p: Json): unknown {
  const type = p.type as string;
  const v = p[type] as unknown;
  switch (type) {
    case 'title':
    case 'rich_text':
      return plainText(v);
    case 'number':
    case 'checkbox':
    case 'url':
    case 'email':
    case 'phone_number':
    case 'created_time':
    case 'last_edited_time':
      return v ?? null;
    case 'select':
    case 'status':
      return name(v) ?? null;
    case 'multi_select':
      return Array.isArray(v) ? v.map(name) : [];
    case 'date': {
      const d = v as { start?: string; end?: string | null } | null;
      if (!d) return null;
      return d.end ? { start: d.start, end: d.end } : d.start;
    }
    case 'people':
      return Array.isArray(v) ? v.map((u) => name(u) ?? (u as Json).id) : [];
    case 'created_by':
    case 'last_edited_by':
      return name(v) ?? (v as Json | null)?.id ?? null;
    case 'relation':
      return Array.isArray(v) ? v.map((r) => (r as Json).id) : [];
    case 'files':
      return Array.isArray(v) ? v.map((f) => fileUrl(f as Json) ?? name(f)) : [];
    case 'formula': {
      const f = (v ?? {}) as Json;
      return f[f.type as string] ?? null;
    }
    case 'rollup': {
      const r = (v ?? {}) as Json;
      if (r.type === 'array')
        return ((r.array as Json[] | undefined) ?? []).map((x) => propertyOut(x));
      return r[r.type as string] ?? null;
    }
    case 'unique_id': {
      const u = (v ?? {}) as { prefix?: string | null; number?: number };
      return u.prefix ? `${u.prefix}-${u.number}` : (u.number ?? null);
    }
    case 'verification':
      return (v as Json | null)?.state ?? null;
    default:
      return v ?? null;
  }
}

export const propertiesOut = (props: unknown): Json =>
  Object.fromEntries(
    Object.entries((props ?? {}) as Record<string, Json>).map(([k, p]) => [k, propertyOut(p)]),
  );

/** A data source's schema for the model: name → type, with the options of choice properties. */
export function schemaOut(props: unknown): Json {
  return Object.fromEntries(
    Object.entries((props ?? {}) as Record<string, Json>).map(([k, p]) => {
      const type = p.type as string;
      const conf = (p[type] ?? {}) as Json;
      const options = (conf.options as unknown[] | undefined)?.map(name);
      return [k, options?.length ? { type, options } : type];
    }),
  );
}

export class PropertyError extends Error {}

const READ_ONLY = new Set([
  'formula',
  'rollup',
  'created_time',
  'created_by',
  'last_edited_time',
  'last_edited_by',
  'unique_id',
  'button',
  'verification',
]);

const list = (v: unknown): unknown[] =>
  Array.isArray(v)
    ? v
    : typeof v === 'string'
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [v];

/**
 * A plain value in Notion's property form, by the property's type. An object that already
 * looks like Notion's form (its key is the type) is passed as it is.
 */
export function propertyIn(
  prop: string,
  type: string,
  value: unknown,
  toId: (ref: string) => string,
): Json {
  if (READ_ONLY.has(type)) throw new PropertyError(`${prop} is a ${type} property and is computed`);
  if (value && typeof value === 'object' && !Array.isArray(value) && type in (value as Json))
    return value as Json;
  if (value === null) {
    const empty: Record<string, unknown> = {
      title: [],
      rich_text: [],
      multi_select: [],
      relation: [],
      people: [],
      files: [],
    };
    return { [type]: type in empty ? empty[type] : null };
  }
  switch (type) {
    case 'title':
    case 'rich_text':
      return { [type]: markdownToRich(String(value)) };
    case 'number': {
      const n = Number(value);
      if (Number.isNaN(n)) throw new PropertyError(`${prop} takes a number`);
      return { number: n };
    }
    case 'checkbox':
      return { checkbox: value === true || value === 'true' || value === 'yes' };
    case 'select':
    case 'status':
      return { [type]: { name: String(value) } };
    case 'multi_select':
      return { multi_select: list(value).map((v) => ({ name: String(v) })) };
    case 'date': {
      if (typeof value === 'object') {
        const d = value as { start?: unknown; end?: unknown };
        if (typeof d.start !== 'string') throw new PropertyError(`${prop} takes a date`);
        return { date: { start: d.start, ...(typeof d.end === 'string' ? { end: d.end } : {}) } };
      }
      return { date: { start: String(value) } };
    }
    case 'url':
    case 'email':
    case 'phone_number':
      return { [type]: String(value) };
    case 'relation':
      return { relation: list(value).map((v) => ({ id: toId(String(v)) })) };
    case 'people':
      return { people: list(value).map((v) => ({ id: toId(String(v)) })) };
    case 'files':
      return {
        files: list(value).map((v) => ({
          name: String(v).split('/').pop()?.slice(0, 100) || 'file',
          external: { url: String(v) },
        })),
      };
    default:
      throw new PropertyError(
        `${prop} is a ${type} property; give Notion's own form, e.g. {"${type}": …}`,
      );
  }
}

/**
 * The model's `properties` (and `title`) for a page whose properties have these types.
 * `types` maps property name → type; the title property is found by its type.
 */
export function propertiesIn(
  types: Record<string, string>,
  values: Json | undefined,
  title: string | undefined,
  toId: (ref: string) => string,
): Json {
  const out: Json = {};
  const byLower = new Map(Object.keys(types).map((k) => [k.toLowerCase(), k]));
  for (const [given, value] of Object.entries(values ?? {})) {
    const prop = given in types ? given : byLower.get(given.toLowerCase());
    if (!prop)
      throw new PropertyError(
        `No property "${given}". The properties are: ${Object.keys(types).join(', ')}`,
      );
    out[prop] = propertyIn(prop, types[prop] as string, value, toId);
  }
  if (title !== undefined) {
    const titleProp = Object.entries(types).find(([, t]) => t === 'title')?.[0] ?? 'title';
    out[titleProp] = { title: markdownToRich(title) };
  }
  return out;
}

/** The title of a page or data source. */
export function titleOf(o: Json): string {
  if (Array.isArray(o.title)) return plainText(o.title);
  const props = (o.properties ?? {}) as Record<string, Json>;
  const t = Object.values(props).find((p) => p.type === 'title');
  return t ? plainText(t.title) : '';
}
