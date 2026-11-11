/**
 * The anchor resolver on named cases and on a synthetic charter (a fictional
 * product, "Acme Notes": four pages, over 90k characters, the three live
 * ADR-0027 amendments). The generated properties are in
 * anchor-properties.test.mjs; the Milkdown no-op save of these same pages is in
 * packages/ui (charter-anchors.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { performance } from 'node:perf_hooks';
import console from 'node:console';
import {
  parseMarkers,
  replaceMarkers,
  projectMarkdown,
  resolveAnchors,
  resolveSelection,
  selectorAt,
  ANCHOR_CONTEXT,
} from '../dist/index.js';

const here = new URL('./fixtures/', import.meta.url);
const pages = [1, 2, 3, 4].map((k) => readFileSync(new URL(`acme-charter-${k}.md`, here), 'utf8'));
/** The charter as the migration will write it: pages concatenated, markers reduced to their quote. */
const written = pages.map((p) => replaceMarkers(p, (m) => m.quote)).join('\n\n');
const quotes = pages.flatMap((p) => parseMarkers(p).map((m) => m.quote));

const anchor = (id, projection, quote, extra = {}) => {
  const sel = resolveSelection(projection, { quote, ...extra });
  assert.ok(sel.ok, `${id}: ${JSON.stringify(sel)}`);
  return { id, state: 'anchored', selector: sel.selector, start: sel.start, end: sel.end };
};
const resolve = (before, afterMarkdown, anchors) => {
  const after = projectMarkdown(afterMarkdown);
  return { after, ...resolveAnchors(before, after, anchors) };
};
const one = (res, id) => res.anchors.find((a) => a.id === id);

test('the fixtures are a charter of the size the plan measured: 3 live amendments, 90k+ characters, ADR-0005 repeated', () => {
  assert.equal(quotes.length, 3);
  assert.ok(pages.join('').length > 90_000);
  assert.deepEqual(quotes, [
    'all billing truth',
    'Never acts on its own (ADR-0005)',
    'A lost dispute keeps billing at no opinion (ADR-0005)',
  ]);
  assert.ok((written.match(/ADR-0005/g) ?? []).length >= 3);
});

test('Acme: each live quote is unique in the projection, so it anchors without context', () => {
  const p = projectMarkdown(written);
  for (const q of quotes) {
    const hits = p.text.split(q).length - 1;
    assert.equal(hits, 1, q);
  }
});

test('Acme: formatting-only edits keep all three anchors (bold, italic, escapes, table re-padding, wrapping)', () => {
  const before = projectMarkdown(written);
  const anchors = quotes.map((q, n) => anchor(`a${n}`, before, q));
  const churn = written
    // bold <-> italic <-> plain on the words around the quotes
    .replace(/\*\*Intent is declarative/, '_Intent is declarative')
    .replace(/converges every device to it\.\*\*/, 'converges every device to it._')
    // soft wrap a long paragraph
    .replace(/(These principles are decisions,) (not options\.)/, '$1\n$2')
    // an escape Milkdown would add
    .replace(/payment truth only/g, 'payment truth only')
    // table re-padding: add a column of padding to every table separator and cell
    .replace(/^\| ([^\n]*) \|$/gm, (line) => line.replace(/ \| /g, '   |   '));
  assert.notEqual(churn, written);
  const res = resolve(before, churn, anchors);
  assert.equal(res.after.text, before.text, 'formatting did not change the projection');
  for (const a of res.anchors) assert.equal(a.outcome, 'kept', a.id);
  res.anchors.forEach((a, n) => assert.equal(res.after.text.slice(a.start, a.end), quotes[n]));
});

test('Acme: unrelated word edits and a new paragraph keep all three anchors, shifted', () => {
  const before = projectMarkdown(written);
  const anchors = quotes.map((q, n) => anchor(`a${n}`, before, q));
  const edited = written
    .replace('Status: Draft', 'Status: Review')
    .replace('Every component', 'Each component')
    .replace(/\n\n## /, '\n\nAn inserted paragraph about nothing in particular.\n\n## ');
  const res = resolve(before, edited, anchors);
  for (const a of res.anchors) assert.equal(a.outcome, 'kept', a.id);
  res.anchors.forEach((a, n) => {
    assert.equal(res.after.text.slice(a.start, a.end), quotes[n]);
    assert.ok(a.start > anchors[n].start, 'shifted by the inserted paragraph');
  });
});

test('Acme: changing a word of one quote orphans that anchor and only that one', () => {
  const before = projectMarkdown(written);
  const anchors = quotes.map((q, n) => anchor(`a${n}`, before, q));
  const res = resolve(
    before,
    written.replace('Never acts on its own (ADR-0005)', 'Never acts by itself (ADR-0005)'),
    anchors,
  );
  assert.deepEqual(
    res.anchors.map((a) => a.outcome),
    ['kept', 'orphaned', 'kept'],
  );
  assert.equal(one(res, 'a1').start, null);
  assert.equal(
    one(res, 'a1').selector.quote,
    quotes[1],
    'the last good selector is kept for healing',
  );
});

test('Acme: the ADR-0005 twin. Deleting the copy an anchor is on orphans it; the other copy is not stolen', () => {
  const before = projectMarkdown(written);
  const anchors = quotes.map((q, n) => anchor(`a${n}`, before, q));
  // The second and third quotes both end "(ADR-0005)", a phrase that recurs. Delete the line that holds the third.
  const line = written.split('\n').find((l) => l.includes(quotes[2]));
  assert.ok(line);
  const res = resolve(before, written.replace(line + '\n', ''), anchors);
  assert.deepEqual(
    res.anchors.map((a) => a.outcome),
    ['kept', 'kept', 'orphaned'],
  );
  // and rewording the second quote's cell does not rebind it to anything else with ADR-0005 in it
  const reworded = resolve(
    before,
    written.replace('Never acts on its own', 'Does nothing alone'),
    anchors,
  );
  assert.deepEqual(
    reworded.anchors.map((a) => a.outcome),
    ['kept', 'orphaned', 'kept'],
  );
});

test('Acme: undo heals an orphan', () => {
  const before = projectMarkdown(written);
  const anchors = quotes.map((q, n) => anchor(`a${n}`, before, q));
  const mid = resolve(before, written.replace('all billing truth', 'all billing facts'), anchors);
  assert.equal(one(mid, 'a0').outcome, 'orphaned');
  const back = resolveAnchors(mid.after, projectMarkdown(written), mid.anchors);
  assert.equal(one(back, 'a0').outcome, 'healed');
  assert.equal(one(back, 'a0').start, anchors[0].start);
  const stillOrphan = resolveAnchors(
    mid.after,
    projectMarkdown(written.replace('all billing truth', 'all billing facts') + '\n\nMore.'),
    mid.anchors,
  );
  assert.equal(one(stillOrphan, 'a0').outcome, 'still-orphaned');
});

// --- named cases from the plan ------------------------------------------------------------------

const twinDoc = (a, b) =>
  `# Doc\n\nIntro paragraph that says nothing at all.\n\n${a}\n\nA middle paragraph, unrelated to either copy.\n\n${b}\n\nThe end.\n`;
const COPY = 'Never acts on its own (ADR-0005)';

test('a pasted duplicate elsewhere does not steal the anchor', () => {
  const before = projectMarkdown(twinDoc(`First: ${COPY} then more.`, 'Second paragraph.'));
  const a = anchor('a', before, COPY);
  const res = resolve(
    before,
    twinDoc(`First: ${COPY} then more.`, `Second paragraph. ${COPY} pasted.`),
    [a],
  );
  assert.equal(one(res, 'a').outcome, 'kept');
  assert.equal(one(res, 'a').start, a.start);
});

test('a twin whose surroundings differ does not take over when the anchored copy is deleted', () => {
  const before = projectMarkdown(
    twinDoc(`First: ${COPY} then more.`, `Second: ${COPY} and other things.`),
  );
  const a = anchor('a', before, COPY, { prefix: 'First: ' });
  const res = resolve(before, twinDoc('Gone.', `Second: ${COPY} and other things.`), [a]);
  assert.equal(one(res, 'a').outcome, 'orphaned');
});

test('a twin with identical surroundings cannot take over either: only new text is a candidate', () => {
  const lead = 'This sentence leads into the phrase and runs for well over sixty-four characters, ';
  const tail = ' and this one trails after it, also for well over sixty-four characters in total.';
  const doc = (head) =>
    twinDoc(`${head} ${lead}${COPY}${tail}`, `Other head. ${lead}${COPY}${tail}`);
  const before = projectMarkdown(doc('First head.'));
  const a = anchor('a', before, COPY, { occurrence: 0, seen: 2 });
  assert.equal(a.selector.prefix.length, ANCHOR_CONTEXT);
  assert.equal(
    a.selector.prefix,
    anchor('b', before, COPY, { occurrence: 1, seen: 2 }).selector.prefix,
    'the 64 characters cannot tell the copies apart',
  );
  const edited = resolve(
    before,
    doc('First head.').replace(`${lead}${COPY}${tail}`, `${lead}Something else entirely${tail}`),
    [a],
  );
  assert.equal(one(edited, 'a').outcome, 'orphaned');
});

test('a moved paragraph rebinds, even when the quote fills it', () => {
  const doc = (order) => order.map((p) => `${p}.`).join('\n\n') + '\n';
  const para = [
    'Alpha paragraph here',
    'Bravo paragraph here',
    'Charlie paragraph here',
    'Delta paragraph here',
  ];
  const before = projectMarkdown(doc(para));
  for (const quote of ['Bravo paragraph here.', 'Bravo']) {
    const a = anchor('a', before, quote);
    for (const order of [
      [para[1], para[0], para[2], para[3]],
      [para[0], para[2], para[3], para[1]],
      [para[0], para[2], para[1], para[3]],
    ]) {
      const res = resolve(before, doc(order), [a]);
      assert.equal(one(res, 'a').state, 'anchored', `${quote} / ${order.join('|')}`);
      assert.equal(res.after.text.slice(one(res, 'a').start, one(res, 'a').end), quote);
    }
  }
});

test('a block moved off the end of the text keeps its anchor when the old window ended with the text', () => {
  // 63 characters after the quote, then the end of the text; after the move a separator follows and cuts the window.
  const para = `Alpha beta gamma ${'w'.repeat(62)}`;
  const doc = (order) => order.join('\n\n') + '\n';
  const others = ['Another paragraph here.', 'And one more of them.'];
  const before = projectMarkdown(doc([...others, para]));
  const a = anchor('a', before, 'Alpha beta gamma');
  assert.equal(a.selector.suffix.length, 63);
  const res = resolve(before, doc([para, ...others]), [a]);
  assert.equal(one(res, 'a').state, 'anchored');
  assert.equal(res.after.text.slice(one(res, 'a').start, one(res, 'a').end), 'Alpha beta gamma');
});

test('the quote pasted into other surroundings is a copy, not the passage: the anchor orphans', () => {
  const sentence = 'The service level is derived from payment truth and the clock';
  const doc = (inFirst, inSecond) =>
    `# Doc\n\nBefore it, ${inFirst} and after it, long enough that the context is inside this paragraph.\n\nElsewhere ${inSecond} is mentioned in passing, with its own words around it on both sides.\n`;
  const before = projectMarkdown(doc(sentence, 'something else'));
  const a = anchor('a', before, sentence);
  const res = resolve(before, doc('a rewritten sentence', sentence), [a]);
  assert.equal(one(res, 'a').outcome, 'orphaned');
});

test('a block moved to the end of the text keeps its anchor when the context window ended inside the separator', () => {
  // The suffix window is 64 characters: 63 of the block's own text, then the first newline of the separator.
  const tail = ' ' + 'w'.repeat(62);
  const para = `Alpha beta gamma${tail}`;
  const doc = (order) => order.join('\n\n') + '\n';
  const others = ['Another paragraph here.', 'And one more of them.'];
  const before = projectMarkdown(doc([para, ...others]));
  const a = anchor('a', before, 'Alpha beta gamma');
  assert.ok(a.selector.suffix.endsWith('\n') && !a.selector.suffix.endsWith('\n\n'));
  const res = resolve(before, doc([...others, para]), [a]);
  assert.equal(one(res, 'a').state, 'anchored');
  assert.equal(res.after.text.slice(one(res, 'a').start, one(res, 'a').end), 'Alpha beta gamma');
});

test('a copy that agrees on only one side is not the passage either', () => {
  const sentence = 'The service level is derived from payment truth and the clock';
  const head = 'Before it we say these words in this order and keep saying them for a good while, ';
  const tail =
    ', and after it we say these other words in this other order, which goes on for a good while longer so that matching it is worth a great deal to any diff';
  // Filler between the passage and the copy, so the diff cannot call the copy the passage moved.
  const filler = Array.from(
    { length: 8 },
    (_, i) => `Filler paragraph number ${i} says something of its own.`,
  ).join('\n\n');
  const doc = (first, last) => `Intro.\n\n${first}\n\n${filler}\n\n${last}\n\nEnd.\n`;
  const before = projectMarkdown(doc(`${head}${sentence}${tail}.`, 'Nothing to see.'));
  const a = anchor('a', before, sentence);
  const edited = `${head}a rewritten sentence${tail}.`;
  const cases = [
    [
      'same prefix, other suffix',
      `${head}${sentence}, but this tail is entirely different.`,
      'orphaned',
    ],
    [
      'same suffix, other prefix',
      `Nothing like that head at all but the ${sentence}${tail}.`,
      'orphaned',
    ],
    ['same both: the passage cut and pasted', `${head}${sentence}${tail}.`, 'moved'],
  ];
  for (const [name, copy, outcome] of cases)
    assert.equal(one(resolve(before, doc(edited, copy), [a]), 'a').outcome, outcome, name);
});

test('identical neighbours cannot be told apart: deleting one orphans both anchors as ambiguous', () => {
  const before = projectMarkdown('Never act.\n\nNever act.\n\nEnd.\n');
  const first = {
    id: 'first',
    state: 'anchored',
    selector: selectorAt(before.text, 0, 10),
    start: 0,
    end: 10,
  };
  const second = {
    id: 'second',
    state: 'anchored',
    selector: selectorAt(before.text, 12, 22),
    start: 12,
    end: 22,
  };
  const end = {
    id: 'end',
    state: 'anchored',
    selector: selectorAt(before.text, 24, 28),
    start: 24,
    end: 28,
  };
  for (const edited of [
    'Never act.\n\nEnd.\n',
    'Never act.\n\nNever act.\n\nNever act.\n\nEnd.\n',
  ]) {
    const res = resolve(before, edited, [first, second, end]);
    assert.deepEqual(
      res.anchors.map((a) => [a.outcome, a.cause]),
      [
        ['orphaned', 'ambiguous'],
        ['orphaned', 'ambiguous'],
        ['kept', undefined],
      ],
    );
  }
});

test('S2: the only copy of a quote going is text_changed, not a doubt between twins', () => {
  const before = projectMarkdown('Intro.\n\nNever act alone.\n\nOutro.\n');
  const at = before.text.indexOf('Never act alone.');
  const a = {
    id: 'solo',
    state: 'anchored',
    selector: selectorAt(before.text, at, at + 16),
    start: at,
    end: at + 16,
  };
  const res = resolve(before, 'Intro.\n\nAlways ask first.\n\nOutro.\n', [a]);
  assert.deepEqual(
    [one(res, 'solo').outcome, one(res, 'solo').cause],
    ['orphaned', 'text_changed'],
  );
});

test('S2: a quote past the 1,000-match cap in both texts is a possible lost copy, so only an untouched context keeps it', () => {
  // 1,100 copies of "ab" in one paragraph; one copy near the start is edited, which no count can see.
  const words = Array.from({ length: 1100 }, () => 'ab');
  const oldMd = `${words.join(' ')}\n`;
  const edited = [...words];
  edited[10] = 'cd';
  const before = projectMarkdown(oldMd);
  const at = (word) => word * 3;
  const anchor = (id, word) => ({
    id,
    state: 'anchored',
    selector: selectorAt(before.text, at(word), at(word) + 2),
    start: at(word),
    end: at(word) + 2,
  });
  const res = resolve(before, `${edited.join(' ')}\n`, [anchor('near', 11), anchor('far', 600)]);
  // the copy next to the edit cannot be told from its twins: the old rule saw 1,001 and 1,001 and kept it
  assert.deepEqual([one(res, 'near').outcome, one(res, 'near').cause], ['orphaned', 'ambiguous']);
  // 64 characters either side of this one are untouched, in both diffs
  assert.equal(one(res, 'far').outcome, 'kept');
  assert.equal(one(res, 'far').start, at(600));
});

test('Codex round 2: a lost copy of the quote orphans every anchor on it unless its own context is untouched', () => {
  const run = (oldMd, newMd) => {
    const before = projectMarkdown(oldMd);
    const anchors = [];
    for (
      let i = before.text.indexOf('Never act.');
      i >= 0;
      i = before.text.indexOf('Never act.', i + 1)
    )
      anchors.push({
        id: `c${anchors.length}`,
        state: 'anchored',
        selector: selectorAt(before.text, i, i + 10),
        start: i,
        end: i + 10,
      });
    return resolve(before, newMd, anchors).anchors.map((a) => [a.outcome, a.cause]);
  };
  // 1. one sentence says it twice, and one saying goes: both anchors orphan, though both diffs keep the first
  assert.deepEqual(run('Never act. Never act.\n', 'Never act.\n'), [
    ['orphaned', 'ambiguous'],
    ['orphaned', 'ambiguous'],
  ]);
  // 2. the last paragraph goes and the intro changes: both diffs map the anchor on the deleted copy to the survivor
  assert.deepEqual(run('Intro.\n\nNever act.\n\nNever act.\n', 'Changed.\n\nNever act.\n'), [
    ['orphaned', 'ambiguous'],
    ['orphaned', 'ambiguous'],
  ]);
  // far from the edit a surviving copy keeps its anchor: its own words and 64 characters either side are untouched
  const far =
    'A long enough stretch of unrelated words to keep every edit well beyond the sixty-four character window around it.';
  const kept = run(
    `Never act.\n\n${far}\n\n${far}\n\nNever act.\n`,
    `${far}\n\n${far}\n\nNever act.\n`,
  );
  assert.deepEqual(kept, [
    ['orphaned', 'ambiguous'],
    ['kept', undefined],
  ]);
});

test('three identical paragraphs: deleting any one orphans every anchor on them', () => {
  const before = projectMarkdown('Same.\n\nSame.\n\nSame.\n\nTail.\n');
  const anchors = [0, 7, 14].map((at, n) => ({
    id: `a${n}`,
    state: 'anchored',
    selector: selectorAt(before.text, at, at + 5),
    start: at,
    end: at + 5,
  }));
  const res = resolve(before, 'Same.\n\nSame.\n\nTail.\n', anchors);
  assert.deepEqual(
    res.anchors.map((a) => a.outcome),
    ['orphaned', 'orphaned', 'orphaned'],
  );
});

test('doubt is not stretched: typing a repeated word, or editing one of two distant twins, keeps the others', () => {
  const before = projectMarkdown('A very good plan.\n\nFiller here.\n');
  const a = anchor('a', before, 'very good');
  const typed = resolve(before, 'A very very good plan.\n\nFiller here.\n', [a]);
  assert.equal(one(typed, 'a').state, 'anchored');
  assert.equal(typed.after.text.slice(one(typed, 'a').start, one(typed, 'a').end), 'very good');
  const filler = Array.from(
    { length: 8 },
    (_, i) => `Filler paragraph ${i} says something of its own.`,
  ).join('\n\n');
  const doc = (x, y) => `Intro.\n\n${x}\n\n${filler}\n\n${y}\n\nEnd.\n`;
  const twins = projectMarkdown(doc('Never act.', 'Never act.'));
  const t1 = anchor('t1', twins, 'Never act.', { occurrence: 0, seen: 2 });
  const t2 = anchor('t2', twins, 'Never act.', { occurrence: 1, seen: 2 });
  const res = resolve(twins, doc('Always act.', 'Never act.'), [t1, t2]);
  assert.deepEqual(
    res.anchors.map((x) => x.outcome),
    ['orphaned', 'kept'],
  );
});

test('when the diff ran out of budget nothing is rebound: an untouched twin cannot take the anchor', () => {
  const quote = 'the anchored phrase appears twice in this paragraph';
  const context = 'surrounding words that are identical for sixty-four characters on each side ';
  const words = (tag) => Array.from({ length: 2200 }, (_, i) => `${tag}${i}`).join(' ');
  // The copy count stays at two (a new copy appears in the rewritten stretch), so only the budget decides.
  const doc = (inner, first) =>
    `${context}${first} ${context} ${inner} ${context}${quote} ${context}\n`;
  const before = projectMarkdown(doc(words('a'), quote));
  const a = anchor('a', before, quote, { occurrence: 0, seen: 2 });
  const res = resolve(before, doc(`${words('b')} ${quote}`, 'something else entirely'), [a]);
  assert.equal(res.exact, false);
  assert.equal(one(res, 'a').outcome, 'orphaned');
  assert.equal(one(res, 'a').cause, 'diff_not_exact');
  const stillOrphan = resolveAnchors(before, res.after, [{ ...res.anchors[0] }]);
  assert.equal(stillOrphan.anchors[0].outcome, 'still-orphaned');
});

test('a degenerate quote cannot make the resolver quadratic or overflow the stack', () => {
  const run = (n) => {
    const before = projectMarkdown(`x${'a'.repeat(n / 2)}y\n`);
    const quote = 'a'.repeat(n / 2);
    const anchorInput = {
      id: 'a',
      state: 'anchored',
      selector: selectorAt(before.text, 1, 1 + quote.length),
      start: 1,
      end: 1 + quote.length,
    };
    const t0 = performance.now();
    const res = resolve(before, `${'a'.repeat(n)}\n`, [anchorInput]);
    return { ms: performance.now() - t0, res };
  };
  const { ms, res } = run(94_000);
  assert.ok(ms < 1500, `took ${ms} ms`);
  assert.equal(one(res, 'a').state, 'orphaned');
  const wide = resolveSelection({ text: 'a'.repeat(150_000) }, { quote: 'a' });
  assert.equal(wide.code, 'quote_ambiguous');
  assert.ok(wide.matches.length <= 20);
});

test('a diff with many changed paragraphs spends one budget, not one per paragraph', () => {
  const paragraphs = (word) =>
    Array.from(
      { length: 50 },
      (_, i) => `${'a '.repeat(800).replaceAll('a', word)}\n\nfixed${i} stays`,
    ).join('\n\n');
  const before = projectMarkdown(paragraphs('a'));
  const t0 = performance.now();
  const res = resolve(before, paragraphs('b'), [anchor('x', before, 'fixed3 stays')]);
  const ms = performance.now() - t0;
  assert.equal(res.exact, false);
  assert.ok(ms < 600, `took ${ms} ms`);
});

test('invalid occurrence or seen is invalid_selection, not an offset of NaN', () => {
  const p = projectMarkdown('needle one. needle two.');
  for (const bad of [
    { occurrence: 0.5, seen: 2 },
    { occurrence: -1, seen: 2 },
    { occurrence: 0, seen: 1.5 },
    { occurrence: Number.NaN, seen: 2 },
    { occurrence: 0, seen: undefined },
    { occurrence: undefined, seen: 2 },
  ])
    assert.deepEqual(resolveSelection(p, { quote: 'needle', ...bad }), {
      ok: false,
      code: 'invalid_selection',
    });
  assert.equal(resolveSelection(p, { quote: 'needle', occurrence: 1, seen: 2 }).ok, true);
});

test('the result is deterministic across runs', () => {
  const before = projectMarkdown(written);
  const anchors = quotes.map((q, n) => anchor(`a${n}`, before, q));
  const edited = written
    .replace('all billing truth', 'billing truth')
    .replace('Status: Draft', 'Status: Final');
  const runs = Array.from({ length: 5 }, () => JSON.stringify(resolve(before, edited, anchors)));
  assert.equal(new Set(runs).size, 1);
});

test('dismissed anchors are left alone; an anchored one with no position cache is not trusted to the diff', () => {
  const before = projectMarkdown(twinDoc('Alpha beta gamma.', 'Delta.'));
  const a = anchor('a', before, 'Alpha beta gamma');
  const dismissed = { ...a, id: 'd', state: 'dismissed' };
  const uncached = { ...a, id: 'u', start: null, end: null };
  const res = resolve(before, twinDoc('Alpha beta gamma.', 'Delta.'), [dismissed, uncached]);
  assert.equal(one(res, 'd').outcome, 'dismissed');
  assert.equal(one(res, 'd').state, 'dismissed');
  assert.equal(one(res, 'u').outcome, 'orphaned');
});

test('an anchor with an empty quote is orphaned, never looped on', () => {
  const before = projectMarkdown('Some text.');
  const res = resolveAnchors(before, projectMarkdown('Some text!'), [
    {
      id: 'e',
      state: 'orphaned',
      selector: { quote: '', prefix: '', suffix: '' },
      start: null,
      end: null,
    },
  ]);
  assert.equal(res.anchors[0].outcome, 'still-orphaned');
});

test('exact is false when the diff gave up on a huge rewrite, and the anchors in it orphan rather than guess', () => {
  const para = (tag, n) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(' ');
  const md = (tag) => `Head stays.\n\n${para(tag, 2200)}\n\nTail stays.\n`;
  const before = projectMarkdown(md('a'));
  const inside = anchor('in', before, 'a100 a101 a102');
  const outside = anchor('out', before, 'Head stays.');
  const res = resolve(before, md('b'), [inside, outside]);
  assert.equal(res.exact, false);
  assert.equal(one(res, 'in').outcome, 'orphaned');
  assert.equal(one(res, 'out').outcome, 'kept');
});

// --- selections -----------------------------------------------------------------------------------

test('a unique quote is accepted whatever the whitespace; the selector carries the context', () => {
  const p = projectMarkdown('First paragraph.\n\nThe quick brown fox jumps.\n\nLast.');
  const sel = resolveSelection(p, { quote: '  The quick\n  brown   fox ' });
  assert.ok(sel.ok);
  assert.equal(sel.selector.quote, 'The quick brown fox');
  assert.equal(sel.selector.prefix, 'First paragraph.\n\n');
  assert.equal(sel.selector.suffix, ' jumps.\n\nLast.');
});

test('a quote may cross blocks; the blank line is part of it', () => {
  const p = projectMarkdown('First paragraph.\n\nSecond one.');
  const sel = resolveSelection(p, { quote: 'paragraph.\n\nSecond' });
  assert.ok(sel.ok);
  assert.equal(p.text.slice(sel.start, sel.end), 'paragraph.\n\nSecond');
});

test('a recurring quote is settled by the longest agreeing context, and a tie is ambiguous', () => {
  const p = projectMarkdown('Alpha says the thing. Beta says the thing. Gamma says the thing.');
  const q = 'says the thing';
  const hit = (prefix, suffix) => resolveSelection(p, { quote: q, prefix, suffix });
  const beta = hit('Alpha says the thing. Beta ', '. Gamma');
  assert.ok(beta.ok);
  assert.equal(p.text.slice(beta.start - 5, beta.start), 'Beta ');
  const gamma = hit('Gamma ', undefined);
  assert.ok(gamma.ok);
  assert.ok(gamma.start > beta.start);
  for (const none of [hit(undefined, undefined), hit('Zzz ', '. Omega')]) {
    assert.equal(none.ok, false);
    assert.equal(none.code, 'quote_ambiguous');
    assert.equal(none.matches.length, 3);
  }
  const tie = resolveSelection(p, { quote: q, prefix: 'a ', suffix: undefined });
  assert.equal(tie.ok, false);
});

test('iOS 0.6.2 occurrence and seen are counted on the projection; a changed page is quote_moved', () => {
  const p = projectMarkdown('One **needle** here.\n\nTwo needle there.\n\nThree needle too.');
  const second = resolveSelection(p, { quote: 'needle', occurrence: 1, seen: 3 });
  assert.ok(second.ok);
  assert.equal(p.text.slice(second.start - 4, second.start), 'Two ');
  assert.deepEqual(resolveSelection(p, { quote: 'needle', occurrence: 1, seen: 2 }), {
    ok: false,
    code: 'quote_moved',
  });
  assert.deepEqual(resolveSelection(p, { quote: 'needle', occurrence: 3, seen: 3 }), {
    ok: false,
    code: 'quote_moved',
  });
});

test('a quote that is not in the text, or is empty, is quote_not_found', () => {
  const p = projectMarkdown('Hello world.');
  assert.deepEqual(resolveSelection(p, { quote: 'goodbye' }), {
    ok: false,
    code: 'quote_not_found',
  });
  assert.deepEqual(resolveSelection(p, { quote: '   ' }), { ok: false, code: 'quote_not_found' });
  assert.deepEqual(
    resolveSelection(p, { quote: '**Hello**' }),
    { ok: false, code: 'quote_not_found' },
    'markup is not text',
  );
});

test('selectorAt takes the context the resolver will compare', () => {
  const text = 'x'.repeat(100) + 'QUOTE' + 'y'.repeat(100);
  const s = selectorAt(text, 100, 105);
  assert.equal(s.prefix, 'x'.repeat(ANCHOR_CONTEXT));
  assert.equal(s.suffix, 'y'.repeat(ANCHOR_CONTEXT));
  assert.equal(selectorAt('QUOTE tail', 0, 5).prefix, '');
});

// --- the save budget ------------------------------------------------------------------------------

test('performance: a save re-resolving 30 anchors on a charter of 90k+ characters', () => {
  const before = projectMarkdown(written);
  const anchors = [];
  const long = before.blocks.filter((b) => b.end - b.start >= 30);
  const step = Math.floor(long.length / 45);
  for (let i = 0; i < long.length && anchors.length < 30; i += step) {
    const block = long[i];
    const quote = before.text.slice(block.start, block.start + 40).replace(/\s\S*$/, '');
    const sel = resolveSelection(before, { quote });
    if (sel.ok)
      anchors.push({
        id: `a${anchors.length}`,
        state: 'anchored',
        selector: sel.selector,
        start: sel.start,
        end: sel.end,
      });
  }
  assert.equal(anchors.length, 30);
  const edited = written
    .replace('Status: Draft', 'Status: Review')
    .replace('Every component', 'Each component')
    .replace(/\n\n## /, '\n\nA new paragraph.\n\n## ');
  const projectMs = [];
  const resolveMs = [];
  for (let i = 0; i < 15; i++) {
    const t0 = performance.now();
    const after = projectMarkdown(edited);
    const t1 = performance.now();
    const res = resolveAnchors(before, after, anchors);
    const t2 = performance.now();
    projectMs.push(t1 - t0);
    resolveMs.push(t2 - t1);
    if (i === 0) assert.ok(res.anchors.every((a) => a.state === 'anchored'));
  }
  const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const projectMed = median(projectMs);
  const resolveMed = median(resolveMs);
  console.log(
    `# 90k+ charter, 30 anchors: project (one parse) median ${projectMed.toFixed(1)} ms, diff+resolve median ${resolveMed.toFixed(2)} ms, save total ${(projectMed + resolveMed).toFixed(1)} ms`,
  );
  // Loose on purpose: shared CI machines are noisy. The budget is 50 ms for a save; the real numbers are in the line above.
  assert.ok(resolveMed < 25, `diff + resolve took ${resolveMed} ms`);
  assert.ok(projectMed + resolveMed < 200, `a save took ${projectMed + resolveMed} ms`);
});

test('S2 review: occurrence and seen leave ignored ranges (inline code) out of the count', () => {
  const projection = projectMarkdown('Use `Redis` internally.\n\nRedis is the queue.');
  const { text, code } = projection;
  const prose = text.lastIndexOf('Redis');
  // The reader saw one match (the prose one), as the old findQuote counted: code is not shown.
  const seen = resolveSelection(projection, {
    quote: 'Redis',
    occurrence: 0,
    seen: 1,
    ignore: code,
  });
  assert.deepEqual([seen.ok, seen.start], [true, prose]);
  // Counted on the whole projection (no ignore), the same selection is stale: two matches.
  assert.equal(
    resolveSelection(projection, { quote: 'Redis', occurrence: 0, seen: 1 }).code,
    'quote_moved',
  );
  // A count that includes the code span is the stale one when the code is ignored.
  assert.equal(
    resolveSelection(projection, { quote: 'Redis', occurrence: 0, seen: 2, ignore: code }).code,
    'quote_moved',
  );
  // Every match inside ignored text: nothing was counted, so the numbers are read as given.
  const only = projectMarkdown('Use `Redis` only.');
  assert.equal(
    resolveSelection(only, { quote: 'Redis', occurrence: 0, seen: 1, ignore: only.code }).ok,
    true,
  );
});
