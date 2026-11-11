// @vitest-environment jsdom
/**
 * Blip bodies are user content rendered with dangerouslySetInnerHTML, so the
 * escaping contract is the thing that has to hold. These tests exist to fail
 * loudly if that ordering is ever changed.
 */
import { describe, expect, it } from 'vitest';
import { plainText, renderMarkdown } from './markdown';
import { must } from './must';

describe('renderMarkdown escaping', () => {
  it('never emits a script tag the user typed', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
  });

  it('neutralises inline event handlers and raw html', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)"> and <b>bold</b>');
    // The words survive as inert text — what must not survive is a real tag,
    // so assert on the markup rather than on the substring.
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/<b\b/i);
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });

  it('refuses javascript: in a markdown link', () => {
    const html = renderMarkdown('[click](javascript:alert(1))');
    // The link is not built at all: the source is left as literal text.
    expect(html).not.toMatch(/<a\b/i);
    expect(html).not.toContain('href=');
  });

  it('refuses a data: url in a markdown link', () => {
    const html = renderMarkdown('[x](data:text/html;base64,PHNjcmlwdD4=)');
    expect(html).not.toMatch(/<a\b/i);
    expect(html).not.toContain('href=');
  });

  it('marks external links noopener', () => {
    const html = renderMarkdown('[ok](https://example.com)');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });
});

/**
 * Every attribute a rendered link carries, parsed by a real HTML parser.
 *
 * String assertions cannot see an attribute boundary — `href="…"style="…"` and
 * an href that merely contains the text `style=` look alike to `toContain`. The
 * parser is the thing a browser will do, so it is the thing to ask.
 */
function anchorAttributes(html: string): string[][] {
  const host = document.createElement('div');
  host.innerHTML = html;
  return Array.from(host.querySelectorAll('a')).map((a) =>
    Array.from(a.attributes).map((attribute) => attribute.name),
  );
}

describe('renderMarkdown attribute boundaries', () => {
  const allowed = new Set(['href', 'target', 'rel', 'class']);

  it('does not let a bare url inside a link target close the href', () => {
    // The bare-URL pass used to run over the anchor the link pass had just
    // built, swallow its closing quote and write a second one — turning the
    // rest of the author's text into attributes. With inline styles allowed by
    // the CSP, that is an invisible full-screen link to anywhere.
    const html = renderMarkdown(
      '[click](https://x.com/(https://e.com/style=position:fixed;inset:0;z-index:99)',
    );
    for (const names of anchorAttributes(html)) {
      for (const name of names) expect(allowed.has(name)).toBe(true);
    }
  });

  it('does not let a mention inside a link target close the href', () => {
    const html = renderMarkdown('[x](https://x.com/(@lucas/style=color:red)', {
      mentions: [{ handle: 'lucas', name: 'Lucas', userId: 'u1' }],
    });
    for (const names of anchorAttributes(html)) {
      for (const name of names) expect(allowed.has(name)).toBe(true);
    }
    expect(html).not.toContain('class="mention"');
  });

  it('does not let emphasis or a hashtag rewrite an href', () => {
    const html = renderMarkdown('https://x.com/**a**/~~b~~ and [y](https://y.com/*c*_d)');
    const host = document.createElement('div');
    host.innerHTML = html;
    expect(Array.from(host.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual([
      'https://x.com/**a**/~~b~~',
      'https://y.com/*c*_d',
    ]);
  });

  it('still formats the label of a markdown link', () => {
    const html = renderMarkdown('[**bold** label](https://example.com)');
    expect(html).toContain('<strong>bold</strong> label</a>');
  });
});

describe('renderMarkdown formatting', () => {
  it('renders the blocks a blip actually uses', () => {
    const html = renderMarkdown('# Title\n\n- one\n- two\n\n> quoted\n\n`code`');
    // A blip sits inside a page, so its h1 becomes an h2.
    expect(html).toContain('<h2>Title</h2>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<blockquote>quoted</blockquote>');
    expect(html).toContain('<code>code</code>');
  });

  it('does not treat the contents of a code span as markup', () => {
    const html = renderMarkdown('`**not bold**`');
    expect(html).toContain('<code>**not bold**</code>');
    expect(html).not.toContain('<strong>');
  });

  it('leaves a fenced block verbatim', () => {
    const html = renderMarkdown('```\n<b>x</b>\n```');
    expect(html).toContain('<pre><code>&lt;b&gt;x&lt;/b&gt;</code></pre>');
  });

  it('turns a hashtag into a link to that tag', () => {
    // Deliberate change of behaviour: hashtags used to be a coloured span. They
    // are now the way you get from one blip to every blip sharing a tag.
    const html = renderMarkdown('an idea about #voice memos');
    expect(html).toContain('<a class="tag-link" href="/t/voice">#voice</a>');
  });

  it('builds the tag href from the normalised tag, not from what was typed', () => {
    // The href is the one place hashtags reach an attribute, so it must not be
    // user text. normalizeTag emits letters, numbers and hyphens only.
    const html = renderMarkdown('#Some_Tag');
    // The tag is displayed as it was typed and linked as it is stored.
    expect(html).toContain('>#Some_Tag<');
    // Percent-encoded letters, numbers and hyphens; nothing that could start a
    // scheme or break out of the attribute.
    expect(html).toMatch(/href="\/t\/[A-Za-z0-9%-]+"/);
  });

  it('leaves a hashtag that normalises to nothing as plain text', () => {
    expect(renderMarkdown('a lone # and ## too')).not.toContain('tag-link');
  });
});

describe('mentions', () => {
  const ada = { handle: 'ada', userId: 'u1', name: 'Ada Lovelace' };

  it('renders a resolved handle under the account’s CURRENT name', () => {
    // The point of storing the resolution rather than parsing the body: the
    // handle was typed once, the name renders as whatever it is today.
    const html = renderMarkdown('morning @ada', { mentions: [ada] });
    expect(html).toContain('<span class="mention">@Ada Lovelace</span>');
  });

  it('matches a handle written as the display-name slug too', () => {
    const html = renderMarkdown('morning @ada-lovelace', { mentions: [ada] });
    expect(html).toContain('<span class="mention">@Ada Lovelace</span>');
  });

  it('leaves an unresolved handle as plain text', () => {
    // Which is exactly what it means: nobody on this radar is called that. It
    // must not look like a mention, or it would imply somebody was notified.
    const html = renderMarkdown('morning @nobody', { mentions: [ada] });
    expect(html).not.toContain('class="mention"');
    expect(html).toContain('@nobody');
  });

  it('never treats an @ inside a URL as a mention', () => {
    // The boundary rule earning its keep: a looser one would wrap part of the
    // href in a span and break the link.
    const html = renderMarkdown('see https://example.com/@ada now', { mentions: [ada] });
    expect(html).toContain('href="https://example.com/@ada"');
    expect(html).not.toContain('class="mention"');
  });

  it('never treats an email address as a mention', () => {
    const html = renderMarkdown('write to ada@example.com', { mentions: [ada] });
    expect(html).not.toContain('class="mention"');
  });

  it('escapes a display name, which does not come from the escaped source', () => {
    // The body is escaped in full before any tag is introduced, but the name
    // arrives from the DTO and bypasses that pass — so it is escaped on its own.
    const html = renderMarkdown('hi @ada', {
      mentions: [{ handle: 'ada', userId: 'u1', name: '<img src=x onerror=alert(1)>' }],
    });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('does not mark up a handle inside code', () => {
    const html = renderMarkdown('use `@ada` carefully', { mentions: [ada] });
    expect(html).toContain('<code>@ada</code>');
    expect(html).not.toContain('class="mention"');
  });

  it('renders an agent addressed by its owner-qualified handle', () => {
    /*
      An agent answers to `@claude` and to `@lucas.claude`, and the stored row
      does not remember which was written — deliberately, so a rename re-renders.
      So the server sends every key it answers to and this indexes them all.

      The bug this catches was found by writing `@lucas.claude` in a real comment
      and looking at the result: the mention notified correctly and then came
      back as plain text, so the notification and the highlight disagreed on the
      same screen. Nothing in the server suite could see it — from there the
      resolution was perfect.
    */
    const claude = {
      handle: 'claude',
      userId: '',
      agentId: 'a1',
      aliases: ['lucas-claude'],
      name: 'Claude',
    };
    expect(renderMarkdown('thanks @lucas.claude', { mentions: [claude] })).toContain(
      '<span class="mention">@Claude</span>',
    );
    // ...and the bare form still works, on a radar where it is unambiguous.
    expect(renderMarkdown('thanks @claude', { mentions: [claude] })).toContain(
      '<span class="mention">@Claude</span>',
    );
  });
});

describe('plainText', () => {
  it('strips markup and truncates for dense views', () => {
    expect(plainText('# Heading\n\nsome **bold** text')).toBe('Heading some bold text');
  });

  it('keeps a tag its #, dropping only heading markers', () => {
    expect(plainText('## Plan\nship it #launch #q4')).toBe('Plan ship it #launch #q4');
  });

  it('turns a table into readable text rather than pipe soup', () => {
    /*
      Found by looking at a real search snippet: a blip whose measurements were
      in a markdown table came back as `| | | |---|---| | bearing strip | 20px |`.
      The alignment row carries no words and goes; the cell separators become the
      middot the instrument voice already uses between facts.
    */
    const table = ['| | |', '|---|---|', '| bearing strip | 20px |', '| composer | 150px |'].join(
      '\n',
    );
    expect(plainText(table)).toBe('bearing strip · 20px · composer · 150px');
  });

  it('leaves a lone pipe in prose alone enough to stay readable', () => {
    expect(plainText('run a | b to pipe it')).toBe('run a · b to pipe it');
    expect(plainText('x'.repeat(400), 50)).toHaveLength(50);
  });
});

describe('renderMarkdown tables', () => {
  const parse = (html: string) => {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host;
  };

  it('renders a table with a header row, and formats cells like any other text', () => {
    const host = parse(
      renderMarkdown('| Tool | Use |\n|---|:---:|\n| `rg` | **search** |\n| fd | find |'),
    );
    const table = must(host.querySelector('table'), 'a table');
    expect(Array.from(table.querySelectorAll('th')).map((th) => th.textContent)).toEqual([
      'Tool',
      'Use',
    ]);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(must(table.querySelector('td code')).textContent).toBe('rg');
    expect(must(table.querySelector('td strong')).textContent).toBe('search');
  });

  it('keeps a cell as inert text, and adds no attribute from the alignment row', () => {
    const host = parse(
      renderMarkdown('| a | b |\n|:--|--:|\n| <img src=x onerror=alert(1)> | c |'),
    );
    expect(host.querySelector('img')).toBeNull();
    for (const element of host.querySelectorAll('table, thead, tbody, tr, th, td')) {
      expect(element.attributes).toHaveLength(0);
    }
  });

  it('leaves a line with a pipe in it as prose when there is no alignment row', () => {
    const html = renderMarkdown('run a | b to pipe it');
    expect(html).not.toContain('<table');
    expect(html).toContain('run a | b to pipe it');
  });
});

describe('renderMarkdown line breaks', () => {
  it('keeps a comment’s single newlines as breaks, and only when asked', () => {
    expect(renderMarkdown('one\ntwo\nthree', { breaks: true })).toBe('<p>one<br>two<br>three</p>');
    expect(renderMarkdown('one\ntwo')).toBe('<p>one two</p>');
  });

  it('breaks between lines that were each escaped first', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>\n<script>x</script>', {
      breaks: true,
    });
    expect(html).not.toMatch(/<img|<script/);
    expect(html.split('<br>')).toHaveLength(2);
  });
});

describe('list markers and numeric hashtags', () => {
  it('does not link #26 but still links #q4', () => {
    const html = renderMarkdown('ranks #26 for #q4');
    expect(html).not.toContain('/t/26');
    expect(html).toContain('<a class="tag-link" href="/t/q4">#q4</a>');
  });
});
