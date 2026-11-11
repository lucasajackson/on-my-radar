/**
 * The projection: the text anchors are matched against. These pin what is and
 * is not in it; the property that matters (formatting never changes it) is
 * also held on generated documents in anchor-properties.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  projectMarkdown,
  blockAt,
  normalizeText,
  unreadBlocks,
  BLOCK_SEPARATOR,
} from '../dist/index.js';

const text = (md) => projectMarkdown(md).text;

test('the text is the words, blocks joined by a blank line and nothing else', () => {
  assert.equal(
    text('# Title\n\nFirst para\nwraps here.\n\nSecond.'),
    'Title\n\nFirst para wraps here.\n\nSecond.',
  );
  assert.equal(BLOCK_SEPARATOR, '\n\n');
  assert.equal(text(''), '');
  assert.equal(text('\n\n   \n'), '');
});

test('emphasis, strong, strike, links and escapes are not in the text; the words are', () => {
  const plain = 'The quick brown fox A* jumps';
  for (const md of [
    'The quick brown fox A\\* jumps',
    'The **quick** _brown_ fox A\\* jumps',
    'The ~~quick~~ [brown](https://x.test/a_b) fox A&#42; jumps',
    'The *quick brown* fox A\\* jumps',
    '__The__ quick brown fox A\\* jumps',
    'The quick  brown\nfox   A\\*\n   jumps',
    'The quick brown  \nfox A\\*\\\njumps',
  ])
    assert.equal(text(md), plain, md);
});

test('inline code is text (it is what the reader sees) and is reported as code; fenced and indented code are not text', () => {
  const p = projectMarkdown(
    'It raises its `generation` field.\n\n```ts\nconst hidden = 1;\n```\n\n    indented hidden\n\nAfter.',
  );
  assert.equal(p.text, 'It raises its generation field.\n\nAfter.');
  assert.deepEqual(p.code, [[14, 24]]);
  assert.equal(p.text.slice(14, 24), 'generation');
  // toggling code on a word is formatting
  assert.equal(text('It raises its generation field.'), 'It raises its generation field.');
});

test('table cells are blocks; padding, alignment and <br> do not change them', () => {
  const tight = '| A | B |\n| - | - |\n| one | two<br>three |\n';
  const padded =
    '| A       | B            |\n| :-----: | -----------: |\n| one     | two <br /> three |\n';
  assert.equal(text(tight), 'A\n\nB\n\none\n\ntwo three');
  assert.equal(text(padded), text(tight));
  assert.deepEqual(
    projectMarkdown(tight).blocks.map((b) => b.kind),
    ['cell', 'cell', 'cell', 'cell'],
  );
});

test('lists, quotes and nested lists project their paragraphs', () => {
  const md = '- one\n  - nested\n- two\n\n> quoted\n\n1. first\n2. second';
  assert.equal(text(md), 'one\n\nnested\n\ntwo\n\nquoted\n\nfirst\n\nsecond');
  assert.equal(text(md.replace(/^- /gm, '* ')), text(md));
});

test('images, link targets, HTML and definitions add no text', () => {
  assert.equal(
    text(
      'See ![a logo](x.png) and [docs](https://x.test/very/long) <span>here</span>.\n\n[ref]: https://y.test',
    ),
    'See and docs here.',
  );
});

test('headings carry their path, whatever their syntax', () => {
  const p = projectMarkdown(
    '# A\n\nintro\n\n## B\n\nunder b\n\nSetext\n------\n\nunder setext\n\n# C\n\nunder c',
  );
  assert.deepEqual(
    p.blocks.map((b) => [b.kind, p.text.slice(b.start, b.end), b.headingPath.join('/')]),
    [
      ['heading', 'A', 'A'],
      ['paragraph', 'intro', 'A'],
      ['heading', 'B', 'A/B'],
      ['paragraph', 'under b', 'A/B'],
      ['heading', 'Setext', 'A/Setext'],
      ['paragraph', 'under setext', 'A/Setext'],
      ['heading', 'C', 'C'],
      ['paragraph', 'under c', 'C'],
    ],
  );
});

test('blockAt finds the block holding an offset, and null in a separator', () => {
  const p = projectMarkdown('one\n\ntwo');
  assert.equal(blockAt(p, 0)?.end, 3);
  assert.equal(blockAt(p, 3), null);
  assert.equal(blockAt(p, 5)?.start, 5);
  assert.equal(blockAt(p, 99), null);
});

test('sourceRange gives the markdown that holds a stretch of text, markup and escapes included', () => {
  const md = 'Say **hello** to A\\* and &amp; more.';
  const p = projectMarkdown(md);
  assert.equal(p.text, 'Say hello to A* and & more.');
  const range = (needle) => {
    const at = p.text.indexOf(needle);
    const [s, e] = p.sourceRange(at, at + needle.length);
    return md.slice(s, e);
  };
  assert.equal(range('Say'), 'Say');
  assert.equal(range('hello to'), 'hello** to');
  assert.equal(range('A*'), 'A\\*');
  assert.equal(range('& more'), '&amp; more');
  assert.equal(range('hello'), 'hello');
  assert.throws(() => p.sourceRange(5, 5), RangeError);
  assert.throws(() => p.sourceRange(0, 999), RangeError);
});

test('sourceRange survives table cells, indentation and CRLF', () => {
  const md = '| a \\| b | c |\r\n| - | - |\r\n| d | e |\r\n\r\nLine one\r\n   line two\r\n';
  const p = projectMarkdown(md);
  const at = p.text.indexOf('a | b');
  const [s, e] = p.sourceRange(at, at + 5);
  assert.equal(md.slice(s, e), 'a \\| b');
  const two = p.text.indexOf('one line');
  const [s2, e2] = p.sourceRange(two, two + 8);
  assert.equal(md.slice(s2, e2).replace(/\s+/g, ' '), 'one line');
});

test('normalizeText collapses whitespace the way the projection does', () => {
  assert.equal(normalizeText('  a \t b\nc\n\n  d \n \n\n e  '), 'a b c\n\nd\n\ne');
  assert.equal(normalizeText('nb sp'), 'nb sp');
});

test('unreadBlocks names exactly what the projection leaves out, by the same rules', () => {
  const unread = {
    'fenced with backticks': '```\nShip the thing\n```',
    'fenced with tildes': '~~~\nShip the thing\n~~~',
    indented: '    Ship the thing',
    'an html block': '<div>\nShip the thing\n</div>',
    'a link definition': '[ship]: https://example.com/ship "Ship the thing"',
  };
  for (const [what, md] of Object.entries(unread)) {
    const both = `${md}\n\nShip the thing`;
    // Out of the text...
    assert.equal(text(both), 'Ship the thing', `${what}: not in the text`);
    // ...and named, by line, so a page can tell it from the prose after it.
    const found = unreadBlocks(both);
    assert.equal(found.length, 1, `${what}: one block`);
    assert.equal(found[0].startLine, 1, `${what}: starts on line 1`);
    assert.equal(found[0].endLine, md.split('\n').length, `${what}: ends with its last line`);
  }
  const code = unreadBlocks('    Ship the thing\n\nShip the thing')[0];
  assert.equal(code.type, 'code');
  assert.equal(code.value, 'Ship the thing');
  // Prose inside containers is read, and so is never named.
  assert.deepEqual(unreadBlocks('> quote\n\n- item\n\n| a |\n| - |\n| b |\n\n# Head'), []);
});
