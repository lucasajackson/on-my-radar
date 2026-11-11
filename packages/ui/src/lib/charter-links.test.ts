// @vitest-environment jsdom
/**
 * Finding a link's words on the page. A synthetic charter (four pages) is drawn the way
 * the reading view draws it, As written and As amended, and every sampled passage (inside one
 * block, across two, across a table cell) must come back as a range whose words are the quote.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMarkers, projectMarkdown, replaceMarkers } from '@onmyradar/contract';
import { renderMarkdown } from './markdown';
import {
  alignStream,
  domStream,
  linksAt,
  placeLinks,
  selectionWords,
  wordsAround,
} from './charter-links';

const fixture = (k: number): string =>
  readFileSync(resolve(process.cwd(), `../contract/test/fixtures/acme-charter-${k}.md`), 'utf8');
const source = [1, 2, 3, 4].map(fixture).join('\n\n');
const written = replaceMarkers(source, (m) => m.quote);
const projection = projectMarkdown(written);
const adrs = new Map(
  parseMarkers(source).flatMap((m) =>
    m.layers.map((l) => [l.adr, { label: 'ADR', lane: 'accepted' }] as const),
  ),
);

function pageIn(view: 'written' | 'amended'): HTMLElement {
  const article = document.createElement('article');
  article.innerHTML = renderMarkdown(source, { amend: { view, adrs } });
  document.body.replaceChildren(article);
  return article;
}

/** Passages to link: the first sentence-ish run of many blocks, and a few that cross into the next. */
function samples() {
  const out: Array<{ id: string; start: number; end: number }> = [];
  const { blocks } = projection;
  // A quote is trimmed: a sample that opens on a space starts a word later.
  const word = (at: number) => (projection.text.charAt(at) === ' ' ? at + 1 : at);
  blocks.forEach((block, k) => {
    if (k % 7 !== 0 || block.end - block.start < 20) return;
    out.push({ id: `in-${k}`, start: block.start, end: Math.min(block.end, block.start + 90) });
    const next = blocks[k + 1];
    if (next && next.end - next.start > 20)
      out.push({ id: `x-${k}`, start: word(block.end - 9), end: next.start + 20 });
  });
  // A quote is trimmed at both ends.
  return out.map((l) => {
    let { start, end } = l;
    while (projection.text.charAt(start) === ' ') start += 1;
    while (projection.text.charAt(end - 1) === ' ') end -= 1;
    return { ...l, start, end };
  });
}

describe('placing links on the reading view', () => {
  it('reads the page as the projection reads the markdown (As written)', () => {
    const page = pageIn('written');
    const stream = domStream(page);
    // Where they differ, the placement falls back to searching, so say how far apart they are.
    expect(stream.text.length).toBeGreaterThan(projection.text.length * 0.97);
    expect(stream.text.length).toBeLessThan(projection.text.length * 1.03);
  });

  it.each(['written', 'amended'] as const)(
    'finds every sampled passage (%s)',
    (view) => {
      const page = pageIn(view);
      const links = samples();
      expect(links.length).toBeGreaterThan(20);
      const placed = placeLinks(page, projection.text, links);
      const lost = links.filter((l) => !placed.has(l.id));
      // The reading view draws a few constructs differently (diagrams, nested lists): lose at most a few.
      expect(lost.length).toBeLessThanOrEqual(Math.ceil(links.length * 0.1));
      // Every placed range is read back the way the page is read, which is a walk of the page per
      // link: a spread of them (two in every eight, in a block and across blocks) keeps the test fast.
      links.forEach((link, k) => {
        const range = placed.get(link.id);
        if (!range || (k % 8 !== 0 && k % 8 !== 3)) return;
        const quote = projection.text.slice(link.start, link.end);
        const read = domStream(page, range).text;
        // A replaced character of the charter (As amended) stands for any.
        const same =
          read.length === quote.length &&
          Array.from(read).every((c, i) => c === quote.charAt(i) || c === '￼');
        expect(same, `${link.id}: ${JSON.stringify(read)} vs ${JSON.stringify(quote)}`).toBe(true);
      });
      // A full page walk per sampled link: ~14s on a 2-core hosted runner, well over the default.
    },
    60_000,
  );

  it('puts a link on the occurrence it was measured on when the words recur', () => {
    const page = document.createElement('article');
    page.innerHTML = '<p>Same words here.</p><p>Same words here.</p>';
    document.body.replaceChildren(page);
    const text = 'Same words here.\n\nSame words here.';
    const placed = placeLinks(page, text, [{ id: 'second', start: 18, end: 34 }]);
    const range = placed.get('second');
    expect(range?.startContainer).toBe(page.children[1]?.firstChild);
  });

  it('keeps a link on its own copy when the page shows characters the projection drops', () => {
    // Task markers are on the page but not in the projection, which shifts every offset after them:
    // the first copy is then nearer the second copy's measured place than the second copy is.
    const page = document.createElement('article');
    page.innerHTML = '<p>[x] [x] [x] [x] [x] [x] [x] Ship the thing</p><p>Ship the thing</p>';
    document.body.replaceChildren(page);
    const text = 'Ship the thing\n\nShip the thing';
    const placed = placeLinks(page, text, [
      { id: 'first', start: 0, end: 14 },
      { id: 'second', start: 16, end: 30 },
    ]);
    expect(placed.get('first')?.startOffset).toBe(28);
    expect(placed.get('second')?.startContainer).toBe(page.children[1]?.firstChild);
  });

  it('draws a link across a marker the page adds inside it, and keeps going after a short block', () => {
    const page = document.createElement('article');
    page.innerHTML =
      '<p>Intro words here.</p><p>[x] A</p><p>[x] Second item of the list.</p><p>[x] Last item stands alone here.</p>';
    document.body.replaceChildren(page);
    const text =
      'Intro words here.\n\nA\n\nSecond item of the list.\n\nLast item stands alone here.';
    const at = (s: string) => text.indexOf(s);
    const placed = placeLinks(page, text, [
      { id: 'across', start: at('A'), end: at('Second') + 'Second item'.length },
      { id: 'after', start: at('Last item'), end: text.length },
    ]);
    const across = placed.get('across');
    expect(across && domStream(page, across).text).toBe('A\n\n[x] Second item');
    expect(placed.get('after')?.toString()).toBe('Last item stands alone here.');
  });

  it('does not draw a link it cannot place without guessing', () => {
    // The first copy is gone from the page; the second must not be taken for it.
    const page = document.createElement('article');
    page.innerHTML = '<p>Something else here entirely.</p><p>Ship the thing</p>';
    document.body.replaceChildren(page);
    const text = 'Ship the thing\n\nShip the thing';
    expect(placeLinks(page, text, [{ id: 'first', start: 0, end: 14 }]).size).toBe(0);
  });

  it('does not draw a link whose words are not on the page', () => {
    const page = document.createElement('article');
    page.innerHTML = '<p>Something else entirely.</p>';
    document.body.replaceChildren(page);
    expect(placeLinks(page, 'Gone words here.', [{ id: 'a', start: 0, end: 16 }]).size).toBe(0);
  });
});

describe('alignStream', () => {
  it('is the identity where the readings agree, and skips what only one has', () => {
    expect(Array.from(alignStream('abc', 'abc'))).toEqual([0, 1, 2]);
    const p = 'The first line of text here.';
    expect(alignStream(p, `[x] ${p}`)[0]).toBe(4);
    expect(alignStream(p, `${p.slice(0, 10)}##${p.slice(10)}`)[20]).toBe(22);
  });
});

describe('what the projection leaves out is not prose on the page', () => {
  // Each is followed by the same words as prose; the link is on the prose, never on the copy before it.
  const constructs: Record<string, string> = {
    'an indented code block': '    Ship the thing',
    'a code block fenced with backticks': '```\nShip the thing\n```',
    'a code block fenced with tildes': '~~~\nShip the thing\n~~~',
    'an html block': '<div>\nShip the thing\n</div>',
    'a link definition': '[ship]: https://example.com/ship "Ship the thing"',
  };
  for (const [what, before] of Object.entries(constructs))
    it(`puts the link on the paragraph after ${what}`, () => {
      const md = `${before}\n\nShip the thing`;
      const text = projectMarkdown(md).text;
      expect(text).toBe('Ship the thing');
      const page = document.createElement('article');
      page.innerHTML = renderMarkdown(md, { amend: { view: 'written', adrs: new Map() } });
      document.body.replaceChildren(page);
      const placed = placeLinks(page, text, [{ id: 'l', start: 0, end: text.length }]);
      const range = placed.get('l');
      expect(range?.toString()).toBe('Ship the thing');
      // The last paragraph of the page, not the construct before it.
      const last = page.lastElementChild;
      expect(last?.tagName).toBe('P');
      expect(last?.classList.contains('md-raw')).toBe(false);
      expect(range?.startContainer).toBe(last?.firstChild);
    });
});

it('aligns a long page with a marker every few blocks in a blink', () => {
  const blocks = Array.from({ length: 1500 }, (_, k) => `Block ${k} says something to align.`);
  const projected = blocks.join('\n\n');
  const shown = blocks.map((b, k) => (k % 3 === 0 ? `[x] ${b}` : b)).join('\n\n');
  const started = performance.now();
  const map = alignStream(projected, shown);
  expect(performance.now() - started).toBeLessThan(500);
  expect(Array.from(map).every((m) => m >= 0)).toBe(true);
});

describe('what a selection says', () => {
  const select = (page: HTMLElement, from: [Node, number], to: [Node, number]) => {
    const range = document.createRange();
    range.setStart(...from);
    range.setEnd(...to);
    const selection = window.getSelection() as Selection;
    selection.removeAllRanges();
    selection.addRange(range);
    return selectionWords(page, selection);
  };

  it('reads across paragraphs with a blank line between, as the projection does', () => {
    const page = document.createElement('article');
    page.innerHTML = '<p>One <strong>bold</strong> thing.</p><p>Two things.</p>';
    document.body.replaceChildren(page);
    const first = page.children[0]?.firstChild as Node;
    const second = page.children[1]?.firstChild as Node;
    const got = select(page, [first, 0], [second, 3]);
    expect(got?.quote).toBe('One bold thing.\n\nTwo');
    expect(got?.refusal).toBeUndefined();
  });

  it('widens a selection that cuts inline code open, and refuses code alone', () => {
    const page = document.createElement('article');
    page.innerHTML = '<p>Run <code>make build</code> now.</p>';
    document.body.replaceChildren(page);
    const text = page.querySelector('code')?.firstChild as Node;
    const lead = page.firstChild?.firstChild as Node;
    const widened = select(page, [lead, 0], [text, 4]);
    expect(widened?.quote).toBe('Run make build');
    expect(select(page, [text, 1], [text, 5])?.refusal).toMatch(/Code can't be anchored/);
  });

  it('leaves out fenced code and our own labels', () => {
    const page = document.createElement('article');
    page.innerHTML =
      '<p>Before.</p><pre><code>skip me</code></pre><p>After<sup class="amend-ref"><a>ADR</a></sup>.</p>';
    document.body.replaceChildren(page);
    const got = select(
      page,
      [page.children[0]?.firstChild as Node, 0],
      [page.children[2]?.firstChild as Node, 5],
    );
    expect(got?.quote).toBe('Before.\n\nAfter');
  });

  it('refuses a selection over text an ADR replaced', () => {
    const page = pageIn('amended');
    const replacement = page.querySelector('ins.amend-with') as Element;
    const got = select(
      page,
      [replacement.firstChild as Node, 0],
      [replacement.firstChild as Node, 3],
    );
    expect(got?.refusal).toMatch(/replaced this text/);
  });

  it('gives the words either side, across blocks', () => {
    const page = document.createElement('article');
    page.innerHTML = '<p>Alpha beta.</p><p>Gamma delta.</p><p>Epsilon.</p>';
    document.body.replaceChildren(page);
    const gamma = page.children[1]?.firstChild as Node;
    const range = document.createRange();
    range.setStart(gamma, 0);
    range.setEnd(gamma, 5);
    expect(wordsAround(page, range)).toEqual({
      prefix: 'Alpha beta.',
      suffix: 'delta.\n\nEpsilon.',
    });
  });
});

describe('hit testing', () => {
  it('names every link under the point, with the line it is on', () => {
    const a = {
      getClientRects: () => [{ left: 0, right: 100, top: 0, bottom: 20 }],
    } as unknown as Range;
    const b = {
      getClientRects: () => [{ left: 50, right: 200, top: 0, bottom: 20 }],
    } as unknown as Range;
    const ranges = new Map([
      ['a', a],
      ['b', b],
    ]);
    expect(linksAt(ranges, 70, 10)?.ids).toEqual(['a', 'b']);
    expect(linksAt(ranges, 150, 10)?.ids).toEqual(['b']);
    expect(linksAt(ranges, 150, 40)).toBeNull();
  });
});
