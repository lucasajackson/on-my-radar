/**
 * The diff the resolver maps anchors through: valid, minimal where it can be
 * checked, deterministic, and bounded without a clock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffText, mapRange, isUntouched, DIFF_EDIT_BUDGET } from '../dist/index.js';
import { performance } from 'node:perf_hooks';
import { rng, int } from './helpers/charter-gen.mjs';

function assertValid(a, b, { runs }) {
  let oldAt = 0;
  let newAt = 0;
  for (const [n, run] of runs.entries()) {
    assert.ok(run.length > 0, 'empty run');
    assert.ok(run.oldStart >= oldAt && run.newStart >= newAt, 'runs overlap or go backwards');
    assert.equal(
      a.slice(run.oldStart, run.oldStart + run.length),
      b.slice(run.newStart, run.newStart + run.length),
      `run ${n} is not equal text`,
    );
    const prev = runs[n - 1];
    if (prev)
      assert.ok(
        prev.oldStart + prev.length !== run.oldStart ||
          prev.newStart + prev.length !== run.newStart,
        'runs not merged',
      );
    oldAt = run.oldStart + run.length;
    newAt = run.newStart + run.length;
  }
}

function lcs(a, b) {
  const row = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j];
      row[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(row[j], row[j - 1]);
      diag = up;
    }
  }
  return row[b.length];
}

test('runs are valid and, for one-letter words, the longest common subsequence', () => {
  const r = rng(11);
  const word = () => 'abcd'[int(r, 4)];
  const sentence = (n) => Array.from({ length: n }, word).join(' ');
  for (let t = 0; t < 600; t++) {
    const a = sentence(1 + int(r, 14));
    const b = sentence(1 + int(r, 14));
    const d = diffText(a, b);
    assertValid(a, b, d);
    assert.ok(d.exact);
    assert.equal(
      d.runs.reduce((n, x) => n + x.length, 0),
      lcs(a, b),
      `${JSON.stringify(a)} -> ${JSON.stringify(b)}`,
    );
  }
});

test('identical, empty and disjoint texts', () => {
  assert.deepEqual(diffText('same\n\ntext', 'same\n\ntext').runs, [
    { oldStart: 0, newStart: 0, length: 10 },
  ]);
  assert.deepEqual(diffText('', 'abc').runs, []);
  assert.deepEqual(diffText('abc', '').runs, []);
  assert.deepEqual(diffText('', '').runs, []);
  assert.equal(
    diffText('alpha', 'omega').runs.reduce((n, x) => n + x.length, 0),
    0,
  );
});

test('a moved block is found as equal text, wherever the diff keeps it', () => {
  const blocks = ['alpha one', 'bravo two', 'charlie three', 'delta four'];
  const a = blocks.join('\n\n');
  const b = [blocks[2], blocks[0], blocks[1], blocks[3]].join('\n\n');
  const d = diffText(a, b);
  assertValid(a, b, d);
  assert.ok(d.runs.reduce((n, x) => n + x.length, 0) >= a.length - blocks[2].length - 2);
});

test('mapRange needs the whole range in one run; isUntouched asks the same of the new text', () => {
  const a = 'one two three four five';
  const b = 'one two INSERTED three four five';
  const d = diffText(a, b);
  assert.deepEqual(mapRange(d, 0, 7), [0, 7]);
  assert.deepEqual(mapRange(d, 8, 23), [17, 32]);
  assert.equal(mapRange(d, 4, 13), null, 'a range an insertion lands inside');
  assert.equal(mapRange(d, 3, 3), null);
  assert.equal(isUntouched(d, 0, 7), true);
  assert.equal(isUntouched(d, 8, 16), false);
  assert.equal(isUntouched(d, 4, 20), false);
});

test('a shared letter does not pull a word apart', () => {
  // the inserted block ends in the same letter the quote's word ends in
  // An earlier edit in the same paragraph ends the shared head before "reasfal"; the shared tail then
  // reaches back over "l" (the last letter of "reasfal" and of "duxlel").
  const a = 'x edit reasfal\n\ncexlonjol y';
  const b = 'x EDIT reasfal\n\nqz3x lalmonfous duxlel\n\ncexlonjol y';
  const d = diffText(a, b);
  assert.deepEqual(mapRange(d, 7, 14), [7, 14]);
  // ...and typing "run " in front of "reasfal" must not borrow its "r" for the shared head
  assert.deepEqual(mapRange(diffText('x reasfal y', 'x run reasfal y'), 2, 9), [6, 13]);
});

test('a block is the same block whether or not a separator follows it', () => {
  // Found by a property run: the unchanged "lainnoum noumbum" block is followed by another block in the old
  // text and is the last block of the new, so only the separator after it differs.
  const a = 'head one\n\nlainnoum noumbum\n\nvaixves nomtonren';
  const b = 'head two\n\nqz0x zaxdais\n\nlainnoum noumbum';
  const at = a.indexOf('lainnoum');
  assert.deepEqual(mapRange(diffText(a, b), at, at + 16), [
    b.indexOf('lainnoum'),
    b.indexOf('lainnoum') + 16,
  ]);
});

test('words are split at punctuation of any script and CJK is read character by character', () => {
  const kept = (oldText, newText, quote) => {
    const at = oldText.indexOf(quote);
    const mapped = mapRange(diffText(oldText, newText), at, at + quote.length);
    return mapped && newText.slice(mapped[0], mapped[1]) === quote;
  };
  assert.ok(kept('Alpha\u2014beta', 'Alpha\u2014gamma', 'Alpha'), 'em dash');
  assert.ok(
    kept('\u201cAlpha\u201d and beta', '\u201cAlpha\u201d and gamma', '\u201cAlpha\u201d'),
    'curly quotes',
  );
  assert.ok(
    kept('Caf\u00e9 au lait, beta', 'Caf\u00e9 au lait, gamma', 'Caf\u00e9 au lait'),
    'accented letters stay in their word',
  );
  assert.ok(
    kept(
      '\u65e5\u672c\u8a9e\u306e\u30c6\u30ad\u30b9\u30c8\u3092\u7de8\u96c6\u3059\u308b',
      '\u65e5\u672c\u8a9e\u306e\u30c6\u30ad\u30b9\u30c8\u3092\u4fee\u6b63\u3059\u308b',
      '\u30c6\u30ad\u30b9\u30c8',
    ),
    'CJK',
  );
  assert.ok(
    kept('\ud83d\ude00 smile and beta', '\ud83d\ude00 smile and gamma', '\ud83d\ude00 smile'),
    'astral characters',
  );
});

test('the edit budget is one for the whole diff, so many changed paragraphs cannot each spend their own', () => {
  const words = (w) => 'a '.repeat(800).replaceAll('a', w);
  const text = (w) => Array.from({ length: 50 }, (_, i) => `${words(w)}\n\nfixed${i}`).join('\n\n');
  const t0 = performance.now();
  const d = diffText(text('a'), text('b'));
  const ms = performance.now() - t0;
  assert.equal(d.exact, false);
  assert.ok(ms < 600, `took ${ms} ms`);
  assertValid(text('a'), text('b'), d);
});

test('deterministic: the same inputs give the same runs', () => {
  const r = rng(5);
  const text = () =>
    Array.from({ length: 200 }, () => 'abcdef'.repeat(1 + int(r, 2)).slice(0, 1 + int(r, 6))).join(
      ' ',
    );
  for (let t = 0; t < 20; t++) {
    const a = text();
    const b = text();
    assert.equal(JSON.stringify(diffText(a, b)), JSON.stringify(diffText(a, b)));
  }
});

test('past the edit cap the stretch counts as replaced, and the diff says it is not exact', () => {
  const words = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');
  const n = DIFF_EDIT_BUDGET + 200;
  const a = `keep this head\n\n${words('a', n)}\n\nkeep this tail`;
  const b = `keep this head\n\n${words('b', n)}\n\nkeep this tail`;
  const d = diffText(a, b);
  assertValid(a, b, d);
  assert.equal(d.exact, false);
  assert.deepEqual(mapRange(d, 0, 14), [0, 14]);
  assert.equal(mapRange(d, 20, 30), null);
  assert.deepEqual(d, diffText(a, b));
});
