import { describe, expect, it } from 'vitest';
import { markdownToTelegram as md } from './telegram-format.js';

describe('markdownToTelegram', () => {
  it('converts emphasis, strikethrough and inline code', () => {
    expect(md('Pick **Option A** or *B*, not ~~C~~; run `a<b && c`')).toBe(
      'Pick <b>Option A</b> or <i>B</i>, not <s>C</s>; run <code>a&lt;b &amp;&amp; c</code>',
    );
    expect(md('__bold__ and _it_ but snake_case_name stays')).toBe(
      '<b>bold</b> and <i>it</i> but snake_case_name stays',
    );
  });

  it('does not format inside code', () => {
    expect(md('`**not bold**`')).toBe('<code>**not bold**</code>');
    expect(md('```ts\nconst x = a * b * c; // <ok>\n```')).toBe(
      '<pre><code class="language-ts">const x = a * b * c; // &lt;ok&gt;</code></pre>',
    );
  });

  it('turns lists, headings and quotes into readable text', () => {
    expect(
      md('## Options\n\n- **A**: fast\n- B\n  - nested\n1. first\n2) second\n- [x] done\n> note'),
    ).toBe(
      '<b>Options</b>\n\n• <b>A</b>: fast\n• B\n   ◦ nested\n1. first\n2. second\n☑ done\n<blockquote>note</blockquote>',
    );
  });

  it('keeps links and escapes everything else', () => {
    expect(md('See [the **docs**](https://x.dev/a?b=1&c=2) & <tags>')).toBe(
      'See <a href="https://x.dev/a?b=1&amp;c=2">the <b>docs</b></a> &amp; &lt;tags&gt;',
    );
  });

  it('leaves unmatched markers alone', () => {
    expect(md('2 * 3 = 6 and a ** b')).toBe('2 * 3 = 6 and a ** b');
    expect(md('```\nunterminated')).toBe('<pre><code>unterminated</code></pre>');
  });
});
