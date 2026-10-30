import { describe, expect, it } from 'vitest';
import {
  blocksToMarkdown,
  markdownToBlocks,
  markdownToRich,
  type NotionBlock,
  PropertyError,
  propertiesIn,
  propertiesOut,
  schemaOut,
} from './notion-markdown.js';

const rt = (text: string, ann: Record<string, boolean> = {}, href?: string) => ({
  plain_text: text,
  href: href ?? null,
  annotations: ann,
});
const b = (type: string, value: Record<string, unknown>, children?: NotionBlock[]) =>
  ({ id: `${type}-id`, type, [type]: value, has_children: !!children, children }) as NotionBlock;

describe('notion markdown', () => {
  it('turns blocks into Markdown, nested lists indented', () => {
    const md = blocksToMarkdown([
      b('heading_2', { rich_text: [rt('Plan')] }),
      b('paragraph', { rich_text: [rt('Go '), rt('now', { bold: true }), rt('!')] }),
      b('bulleted_list_item', { rich_text: [rt('Pack')] }, [
        b('to_do', { rich_text: [rt('socks')], checked: true }),
      ]),
      b('numbered_list_item', { rich_text: [rt('one')] }),
      b('numbered_list_item', { rich_text: [rt('two', {}, 'https://x.com')] }),
      b('code', { rich_text: [rt('ls -la')], language: 'bash' }),
      b('child_page', { title: 'Notes' }),
      b('divider', {}),
    ]);
    expect(md).toBe(
      [
        '## Plan',
        'Go **now**!',
        '- Pack',
        '  - [x] socks',
        '1. one',
        '2. [two](https://x.com)',
        '```bash',
        'ls -la',
        '```',
        '[Page: Notes] (id child_page-id)',
        '---',
      ].join('\n'),
    );
  });

  it('turns Markdown into blocks with inline formatting and nesting', () => {
    const blocks = markdownToBlocks(
      '# Trip\n\nSome **bold** and [a link](https://a.b).\nSecond line\n\n- [ ] passport\n  - check expiry\n1. first\n> quote\n---\n```ts\nconst x = 1;\n```',
    );
    expect(blocks.map((x) => x.type)).toEqual([
      'heading_1',
      'paragraph',
      'to_do',
      'numbered_list_item',
      'quote',
      'divider',
      'code',
    ]);
    const para = blocks[1]?.paragraph as { rich_text: unknown[] };
    expect(para.rich_text).toEqual([
      { type: 'text', text: { content: 'Some ' } },
      { type: 'text', text: { content: 'bold' }, annotations: { bold: true } },
      { type: 'text', text: { content: ' and ' } },
      { type: 'text', text: { content: 'a link', link: { url: 'https://a.b' } } },
      { type: 'text', text: { content: '.\nSecond line' } },
    ]);
    const todo = blocks[2]?.to_do as { checked: boolean; children: Array<{ type: string }> };
    expect(todo.checked).toBe(false);
    expect(todo.children.map((c) => c.type)).toEqual(['bulleted_list_item']);
    expect((blocks[6]?.code as { language?: string } | undefined)?.language).toBe('typescript');
  });

  it('splits text over 2000 characters', () => {
    expect(markdownToRich('a'.repeat(4500))).toHaveLength(3);
  });

  it('reads properties as plain values', () => {
    expect(
      propertiesOut({
        Name: { type: 'title', title: [rt('Paris')] },
        Status: { type: 'status', status: { name: 'Booked' } },
        Tags: { type: 'multi_select', multi_select: [{ name: 'a' }, { name: 'b' }] },
        When: { type: 'date', date: { start: '2026-11-02', end: null } },
        Done: { type: 'checkbox', checkbox: false },
        Cost: { type: 'formula', formula: { type: 'number', number: 12 } },
      }),
    ).toEqual({
      Name: 'Paris',
      Status: 'Booked',
      Tags: ['a', 'b'],
      When: '2026-11-02',
      Done: false,
      Cost: 12,
    });
    expect(
      schemaOut({
        Name: { type: 'title', title: {} },
        Status: { type: 'status', status: { options: [{ name: 'Todo' }, { name: 'Done' }] } },
      }),
    ).toEqual({ Name: 'title', Status: { type: 'status', options: ['Todo', 'Done'] } });
  });

  it('writes plain values in Notion form by type, matching names loosely', () => {
    const types = {
      Name: 'title',
      Status: 'status',
      Tags: 'multi_select',
      Due: 'date',
      Price: 'number',
      Link: 'url',
      Trip: 'relation',
    };
    expect(
      propertiesIn(
        types,
        {
          status: 'Done',
          Tags: 'a, b',
          Due: { start: '2026-11-02', end: '2026-11-04' },
          Price: '12.5',
          Link: 'https://x.com',
          Trip: ['1a2b3c4d5e6f40718293a4b5c6d7e8f9'],
        },
        'Paris',
        (r) => `id:${r}`,
      ),
    ).toEqual({
      Status: { status: { name: 'Done' } },
      Tags: { multi_select: [{ name: 'a' }, { name: 'b' }] },
      Due: { date: { start: '2026-11-02', end: '2026-11-04' } },
      Price: { number: 12.5 },
      Link: { url: 'https://x.com' },
      Trip: { relation: [{ id: 'id:1a2b3c4d5e6f40718293a4b5c6d7e8f9' }] },
      Name: { title: [{ type: 'text', text: { content: 'Paris' } }] },
    });
    expect(() => propertiesIn(types, { Nope: 1 }, undefined, String)).toThrow(PropertyError);
    expect(() => propertiesIn({ Total: 'formula' }, { Total: 1 }, undefined, String)).toThrow(
      /computed/,
    );
  });
});
