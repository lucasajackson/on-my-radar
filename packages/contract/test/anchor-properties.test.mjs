/**
 * The properties the anchor resolver is held to, on generated charters
 * (helpers/charter-gen.mjs). Every run is reproducible from its seed, which a
 * failure prints. `ANCHOR_PROPERTY_RUNS` raises the number of seeds (default
 * 150 per property).
 *
 *  1. Formatting-only edits never orphan an anchor, even with unrelated word
 *     edits in the same save.
 *  2. Editing only the anchored words always orphans it, and undoing the edit
 *     heals it.
 *  3. A twin phrase never steals an anchor, even when its surroundings are
 *     identical for 64 characters on each side.
 *  4. A cut and paste of a block keeps the anchors inside it.
 *  5. The result is deterministic and does not depend on anchor order.
 *  7. When an edit removes a copy of a quote, no anchor on that quote is kept
 *     unless its own words and context are untouched and still in the same place.
 *  6. Identical neighbours cannot be told apart: deleting or pasting one orphans
 *     the anchors on both copies (ambiguous), and a bystander is kept.
 */
import { test } from 'node:test';
import process from 'node:process';
import assert from 'node:assert/strict';
import { projectMarkdown, resolveAnchors, selectorAt } from '../dist/index.js';
import {
  rng,
  int,
  pick,
  model,
  render,
  units,
  locate,
  expectedText,
  clone,
  freshWord,
  resetFresh,
  plainWord,
} from './helpers/charter-gen.mjs';

const RUNS = Number(process.env['ANCHOR_PROPERTY_RUNS'] ?? 150);
/** `ANCHOR_PROPERTY_SEED=n` replays one seed, with the failing assertion's message. */
const ONLY = process.env['ANCHOR_PROPERTY_SEED'];

function property(name, body) {
  test(name, () => {
    for (let seed = ONLY ? Number(ONLY) : 1; seed <= (ONLY ? Number(ONLY) : RUNS); seed++) {
      resetFresh();
      try {
        body(seed, rng(seed * 7919));
      } catch (e) {
        e.message = `seed ${seed}: ${e.message}`;
        throw e;
      }
    }
  });
}

// --- addresses that survive structural edits ---------------------------------------------------
// A unit is addressed by its block and its place in the block, not by its flat index.

const addrOf = (m, u) => {
  const all = units(m);
  const bi = all[u].bi;
  return { bi, k: all.slice(0, u).filter((x) => x.bi === bi).length };
};
const unitOf = (m, a) => {
  const all = units(m);
  let n = -1;
  return all.findIndex((x) => x.bi === a.bi && ++n === a.k);
};

/** refs: { a, i, j, a2? } ; words i..j of the unit at address a, or from i of a through j of a2. */
function refOf(m, u, i, j, u2) {
  return u2 === undefined
    ? { a: addrOf(m, u), i, j }
    : { a: addrOf(m, u), i, a2: addrOf(m, u2), j };
}
function flatRef(m, ref) {
  const u = unitOf(m, ref.a);
  return ref.a2 ? { u, i: ref.i, u2: unitOf(m, ref.a2), j: ref.j } : { u, i: ref.i, j: ref.j };
}
const rangeOf = (m, ref) => locate(m, flatRef(m, ref));

/** Up to `count` anchors on distinct units, each quote unique in the text. */
function chooseRefs(r, m, count, allowCross) {
  const text = expectedText(m);
  const all = units(m);
  const taken = new Set();
  const refs = [];
  for (let tries = 0; refs.length < count && tries < count * 20; tries++) {
    const u = int(r, all.length);
    const cross = allowCross && r() < 0.2 && u + 1 < all.length;
    if (taken.has(u) || (cross && taken.has(u + 1))) continue;
    const n = all[u].words.length;
    let ref;
    if (cross) {
      ref = refOf(m, u, int(r, n), int(r, all[u + 1].words.length), u + 1);
    } else {
      const i = int(r, n);
      ref = refOf(m, u, i, Math.min(n - 1, i + int(r, 6)));
    }
    const { start, end } = rangeOf(m, ref);
    const quote = text.slice(start, end);
    if (text.indexOf(quote) !== text.lastIndexOf(quote)) continue;
    taken.add(u);
    if (cross) taken.add(u + 1);
    refs.push(ref);
  }
  return refs;
}

const inputs = (m, text, refs) =>
  refs.map((ref, n) => {
    const { start, end } = rangeOf(m, ref);
    return { id: `a${n}`, state: 'anchored', selector: selectorAt(text, start, end), start, end };
  });

const project = (m, seed) => {
  const p = projectMarkdown(render(m, seed));
  assert.equal(p.text, expectedText(m), 'the projection is the words');
  return p;
};

function resolved(res, id) {
  return res.anchors.find((a) => a.id === id);
}

// --- edits ---------------------------------------------------------------------------------------

/** The protected word range of each unit that carries a ref: [lo, hi] inclusive, by unit address key. */
function protect(m, refs) {
  const all = units(m);
  const key = (a) => `${a.bi}:${a.k}`;
  const out = new Map();
  for (const ref of refs) {
    if (!ref.a2) out.set(key(ref.a), [ref.i, ref.j]);
    else {
      out.set(key(ref.a), [ref.i, all[unitOf(m, ref.a)].words.length - 1]);
      out.set(key(ref.a2), [0, ref.j]);
    }
  }
  return { out, key };
}

/**
 * Word edits and block inserts/deletes that stay clear of every anchored word.
 * Returns the new model and the refs remapped onto it.
 */
function editElsewhere(r, m0, refs0) {
  const m = clone(m0);
  const refs = refs0.map((ref) => ({
    ...ref,
    a: { ...ref.a },
    ...(ref.a2 ? { a2: { ...ref.a2 } } : {}),
  }));
  const { out: guard, key } = protect(m, refs);
  const crossPairs = refs.filter((x) => x.a2).map((x) => [x.a.bi, x.a2.bi]);

  for (let n = 1 + int(r, 5); n > 0; n--) {
    const all = units(m);
    const u = int(r, all.length);
    const unit = all[u];
    const a = addrOf(m, u);
    const g = guard.get(key(a));
    const words = unit.words.slice();
    const op = int(r, 4);
    if (op === 0) {
      const free = words.map((_, k) => k).filter((k) => !g || k < g[0] || k > g[1]);
      if (free.length) words[pick(r, free)] = freshWord();
    } else if (op === 1) {
      if (!g || g[0] > 0) {
        words.unshift(freshWord());
        for (const ref of refs) {
          if (key(ref.a) === key(a)) ref.i += 1;
          if (!ref.a2 && key(ref.a) === key(a)) ref.j += 1;
        }
        if (g) guard.set(key(a), [g[0] + 1, g[1] + 1]);
      }
    } else if (op === 2) {
      if (!g || g[1] < words.length - 1) words.push(freshWord());
    } else if (words.length > 3) {
      const free = words.map((_, k) => k).filter((k) => !g || k < g[0] || k > g[1]);
      if (free.length) {
        const k = pick(r, free);
        words.splice(k, 1);
        if (g && k < g[0]) {
          for (const ref of refs)
            if (key(ref.a) === key(a)) {
              ref.i -= 1;
              if (!ref.a2) ref.j -= 1;
            }
          guard.set(key(a), [g[0] - 1, g[1] - 1]);
        }
      }
    }
    unit.set(words);
  }

  // blocks: insert a paragraph somewhere that is not between a cross pair, delete an unanchored block
  const used = new Set(refs.flatMap((x) => [x.a.bi, ...(x.a2 ? [x.a2.bi] : [])]));
  const shift = (from, by) => {
    for (const ref of refs) {
      if (ref.a.bi >= from) ref.a.bi += by;
      if (ref.a2 && ref.a2.bi >= from) ref.a2.bi += by;
    }
    const moved = new Map();
    for (const [k, v] of guard) {
      const [bi, kk] = k.split(':').map(Number);
      moved.set(`${bi >= from ? bi + by : bi}:${kk}`, v);
    }
    guard.clear();
    for (const [k, v] of moved) guard.set(k, v);
  };
  if (r() < 0.7) {
    const at = int(r, m.length + 1);
    if (!crossPairs.some(([x, y]) => y === x + 1 && at === x + 1)) {
      m.splice(at, 0, {
        type: 'p',
        words: [freshWord(), plainWord(r), plainWord(r), plainWord(r)],
      });
      shift(at, 1);
      used.clear();
      for (const x of refs) {
        used.add(x.a.bi);
        if (x.a2) used.add(x.a2.bi);
      }
    }
  }
  if (r() < 0.6) {
    const candidates = m
      .map((_, bi) => bi)
      .filter((bi) => !used.has(bi) && !crossPairs.some(([x, y]) => bi > x && bi < y));
    if (candidates.length) {
      const bi = pick(r, candidates);
      m.splice(bi, 1);
      shift(bi + 1, -1);
    }
  }
  return { m, refs };
}

function assertKept(res, m, refs, text) {
  refs.forEach((ref, n) => {
    const got = resolved(res, `a${n}`);
    const want = rangeOf(m, ref);
    assert.equal(got.outcome, 'kept', `anchor ${n} was ${got.outcome}`);
    assert.deepEqual(
      [got.start, got.end],
      [want.start, want.end],
      `anchor ${n} moved to the wrong place`,
    );
    assert.equal(text.slice(got.start, got.end), got.selector.quote);
  });
}

// --- 1. formatting-only edits never orphan -----------------------------------------------------

property(
  '1a. re-rendering the same words with other formatting keeps every anchor in place',
  (seed, r) => {
    const m = model(r, 12 + int(r, 14));
    const refs = chooseRefs(r, m, 8, true);
    const before = project(m, seed * 3 + 1);
    const anchors = inputs(m, before.text, refs);
    const after = project(m, seed * 3 + 2);
    const res = resolveAnchors(before, after, anchors);
    assert.ok(res.exact);
    assertKept(res, m, refs, after.text);
  },
);

property(
  '1b. formatting churn plus word edits elsewhere in the same save keep every anchor',
  (seed, r) => {
    const m = model(r, 12 + int(r, 14));
    const refs = chooseRefs(r, m, 8, true);
    const before = project(m, seed * 3 + 1);
    const anchors = inputs(m, before.text, refs);
    const edited = editElsewhere(r, m, refs);
    const after = project(edited.m, seed * 3 + 2);
    const res = resolveAnchors(before, after, anchors);
    assert.ok(res.exact);
    assertKept(res, edited.m, edited.refs, after.text);
  },
);

// --- 2. changing only the anchored words always orphans ----------------------------------------

/** Changes words inside the ref's range (replace, delete, or insert strictly inside). Returns false if it could not. */
function editInside(r, m, ref) {
  const all = units(m);
  const first = unitOf(m, ref.a);
  const last = ref.a2 ? unitOf(m, ref.a2) : first;
  const spots = [];
  for (let u = first; u <= last; u++) {
    const lo = u === first ? ref.i : 0;
    const hi = u === last ? ref.j : all[u].words.length - 1;
    for (let k = lo; k <= hi; k++) spots.push([u, k, lo, hi]);
  }
  const [u, k, lo, hi] = pick(r, spots);
  const words = all[u].words.slice();
  const op = int(r, 3);
  if (op === 0) words[k] = freshWord();
  else if (op === 1 && !(first === last && lo === hi)) {
    // deleting the only word of a unit would make the unit vanish, which is still a change of the anchored words
    if (words.length === 1) return false;
    words.splice(k, 1);
  } else if (k > lo || u > first || (u === first && k > lo)) words.splice(k, 0, freshWord());
  else words[k] = freshWord();
  all[u].set(words);
  return true;
}

property(
  '2. editing only the anchored words orphans the anchor, and undoing the edit heals it',
  (seed, r) => {
    const m = model(r, 12 + int(r, 14));
    const refs = chooseRefs(r, m, 6, true);
    if (refs.length < 2) return;
    const before = project(m, seed * 3 + 1);
    const anchors = inputs(m, before.text, refs);
    const m1 = clone(m);
    const hit = new Set();
    refs.forEach((ref, n) => {
      if (r() < 0.5 && editInside(r, m1, ref)) hit.add(n);
    });
    if (hit.size === 0) return;
    // The edited model changes unit contents but not their count, except a one-word unit that lost a word.
    const mid = projectMarkdown(render(m1, seed * 3 + 2));
    const res = resolveAnchors(before, mid, anchors);
    refs.forEach((_, n) => {
      const got = resolved(res, `a${n}`);
      if (hit.has(n)) {
        assert.equal(got.outcome, 'orphaned', `anchor ${n} survived an edit to its words`);
        assert.equal(got.start, null);
      } else assert.equal(got.outcome, 'kept', `anchor ${n} was ${got.outcome}`);
    });
    // undo: the text goes back, the orphans come back where they were
    const after = project(m, seed * 3 + 3);
    const back = resolveAnchors(
      mid,
      after,
      res.anchors.map((a) => ({
        id: a.id,
        state: a.state,
        selector: a.selector,
        start: a.start,
        end: a.end,
      })),
    );
    refs.forEach((ref, n) => {
      const got = resolved(back, `a${n}`);
      const want = rangeOf(m, ref);
      assert.equal(
        got.outcome,
        hit.has(n) ? 'healed' : 'kept',
        `anchor ${n} after undo was ${got.outcome}`,
      );
      assert.deepEqual([got.start, got.end], [want.start, want.end]);
    });
  },
);

// --- 3. a twin never steals an anchor ----------------------------------------------------------

/**
 * Two units that are identical for 64+ characters around the phrase, apart from
 * their first words: the hardest twin, because the context cannot tell them apart.
 */
function twinModel(r) {
  const m = model(r, 6 + int(r, 8));
  const lead = Array.from({ length: 14 }, () => plainWord(r));
  const tail = Array.from({ length: 14 }, () => plainWord(r));
  const phrase = Array.from({ length: 3 + int(r, 3) }, () => plainWord(r));
  const build = () => [plainWord(r), plainWord(r), plainWord(r), ...lead, ...phrase, ...tail];
  const at = (n) => int(r, n + 1);
  const a = { type: 'p', words: build() };
  const b = { type: 'p', words: build() };
  const pa = at(m.length);
  m.splice(pa, 0, a);
  m.splice(at(m.length), 0, b);
  return { m, a, b, phrase };
}

property('3. a twin phrase never steals an anchor, even with identical surroundings', (seed, r) => {
  const { m, a, b, phrase } = twinModel(r);
  const at = (block) => {
    const bi = m.indexOf(block);
    return { bi, k: 0 };
  };
  const first = 3 + 14;
  const refA = { a: at(a), i: first, j: first + phrase.length - 1 };
  const refB = { a: at(b), i: first, j: first + phrase.length - 1 };
  const before = project(m, seed * 3 + 1);
  const anchors = inputs(m, before.text, [refA, refB]);
  assert.notEqual(anchors[0].start, anchors[1].start);

  const idx = m.indexOf(a);
  const bIdx = m.indexOf(b);
  const span = [first, first + phrase.length];
  for (const name of ['copy A deleted', 'words of A changed', 'phrase removed from A']) {
    const m1 = clone(m);
    let blockOfB = bIdx;
    if (name === 'copy A deleted') {
      m1.splice(idx, 1);
      if (bIdx > idx) blockOfB -= 1;
    } else if (name === 'words of A changed') {
      m1[idx].words[first + int(r, phrase.length)] = freshWord();
    } else m1[idx].words.splice(span[0], phrase.length);
    const want = locate(m1, {
      u: units(m1).findIndex((x) => x.bi === blockOfB),
      i: first,
      j: first + phrase.length - 1,
    });
    const after = projectMarkdown(render(m1, seed * 3 + 2));
    const res = resolveAnchors(before, after, anchors);
    const gotA = resolved(res, 'a0');
    const gotB = resolved(res, 'a1');
    assert.equal(gotA.outcome, 'orphaned', `${name}: the anchor on A went to ${gotA.start}`);
    assert.equal(gotB.outcome, 'kept', `${name}: the anchor on B was ${gotB.outcome}`);
    assert.deepEqual([gotB.start, gotB.end], [want.start, want.end]);
  }
});

// --- 4. cut and paste keeps the anchors in the block --------------------------------------------

property(
  '4. moving a block elsewhere keeps the anchors inside it, even a quote that fills the block',
  (seed, r) => {
    const m = model(r, 10 + int(r, 10));
    const paragraphs = m.map((b, bi) => [b, bi]).filter(([b]) => b.type === 'p');
    if (paragraphs.length < 2) return;
    const [block, bi] = pick(r, paragraphs);
    const n = block.words.length;
    const shapes = [
      [0, n - 1], // the whole block: its context is the neighbours, which change with the move
      [0, Math.min(n - 1, 2)], // the start of the block
      [Math.max(0, n - 3), n - 1], // the end of the block
      [1, Math.max(1, n - 2)], // well inside
    ];
    const [i, j] = pick(r, shapes);
    const text = expectedText(m);
    const refPlain = { a: { bi, k: 0 }, i, j };
    const quote = text.slice(rangeOf(m, refPlain).start, rangeOf(m, refPlain).end);
    if (text.indexOf(quote) !== text.lastIndexOf(quote)) return;
    const before = project(m, seed * 3 + 1);
    const anchors = inputs(m, before.text, [refPlain]);

    const m1 = clone(m);
    const [moved] = m1.splice(bi, 1);
    let to = int(r, m1.length + 1);
    if (to === bi) to = (to + 1) % (m1.length + 1);
    m1.splice(to, 0, moved);
    const after = project(m1, seed * 3 + 2);
    const res = resolveAnchors(before, after, anchors);
    const got = resolved(res, 'a0');
    const want = rangeOf(m1, { a: { bi: to, k: 0 }, i, j });
    assert.ok(got.state === 'anchored', `the anchor was ${got.outcome}`);
    assert.deepEqual([got.start, got.end], [want.start, want.end]);
  },
);

// --- 5. determinism ------------------------------------------------------------------------------

property('5. the same input resolves the same way, in any anchor order', (seed, r) => {
  const m = model(r, 12 + int(r, 14));
  const refs = chooseRefs(r, m, 8, true);
  const before = project(m, seed * 3 + 1);
  const anchors = inputs(m, before.text, refs);
  const edited = editElsewhere(r, m, refs);
  const m2 = clone(edited.m);
  const u = int(r, units(m2).length);
  units(m2)[u].set(units(m2)[u].words.map((w, k) => (k % 3 === 0 ? freshWord() : w)));
  const after = projectMarkdown(render(m2, seed * 3 + 2));
  const one = JSON.stringify(resolveAnchors(before, after, anchors));
  const two = JSON.stringify(resolveAnchors(before, after, anchors));
  assert.equal(one, two);
  const shuffled = anchors.slice().reverse();
  const reversed = resolveAnchors(before, after, shuffled);
  const byId = (res) => JSON.stringify(res.anchors.slice().sort((x, y) => (x.id < y.id ? -1 : 1)));
  assert.equal(byId(resolveAnchors(before, after, anchors)), byId(reversed));
});

// --- 6. identical neighbours ----------------------------------------------------------------------

property(
  '6. identical neighbouring blocks: deleting or pasting a copy orphans the anchors on them',
  (seed, r) => {
    const m = model(r, 8 + int(r, 8));
    const paragraphs = m.map((b, bi) => [b, bi]).filter(([b]) => b.type === 'p');
    if (paragraphs.length < 3) return;
    const [block, bi] = pick(r, paragraphs);
    const n = block.words.length;
    const i = int(r, n);
    const j = Math.min(n - 1, i + int(r, 6));
    const bystanderBlock = pick(
      r,
      paragraphs.filter(([, k]) => k !== bi),
    );
    const withCopy = clone(m);
    withCopy.splice(bi + 1, 0, clone(block));
    const unitOfBlock = (model_, k) => units(model_).findIndex((x) => x.bi === k);
    const bystanderAt = bystanderBlock[1] > bi ? bystanderBlock[1] + 1 : bystanderBlock[1];
    const refs = [
      refOf(withCopy, unitOfBlock(withCopy, bi), i, j),
      refOf(withCopy, unitOfBlock(withCopy, bi + 1), i, j),
      refOf(
        withCopy,
        unitOfBlock(withCopy, bystanderAt),
        0,
        Math.min(2, bystanderBlock[0].words.length - 1),
      ),
    ];
    const text = expectedText(withCopy);
    const bystanderQuote = text.slice(
      rangeOf(withCopy, refs[2]).start,
      rangeOf(withCopy, refs[2]).end,
    );
    if (text.indexOf(bystanderQuote) !== text.lastIndexOf(bystanderQuote)) return;
    const before = project(withCopy, seed * 3 + 1);
    const anchors = inputs(withCopy, before.text, refs);

    // delete either copy
    const gone = clone(withCopy);
    gone.splice(bi + int(r, 2), 1);
    const afterDelete = project(gone, seed * 3 + 2);
    const deleted = resolveAnchors(before, afterDelete, anchors);
    assert.deepEqual(
      deleted.anchors.map((a) => [a.outcome, a.cause]),
      [
        ['orphaned', 'ambiguous'],
        ['orphaned', 'ambiguous'],
        ['kept', undefined],
      ],
      'deleting a copy',
    );
    // paste a third copy next to them
    const more = clone(withCopy);
    more.splice(bi + 1, 0, clone(block));
    const afterPaste = project(more, seed * 3 + 3);
    const pasted = resolveAnchors(before, afterPaste, anchors);
    assert.deepEqual(
      pasted.anchors.map((a) => a.outcome),
      ['orphaned', 'orphaned', 'kept'],
      'pasting a copy',
    );
  },
);

// --- 7. a lost copy of the quote -------------------------------------------------------------------

const findWords = (words, phrase) => {
  for (let k = 0; k + phrase.length <= words.length; k++)
    if (phrase.every((w, n) => words[k + n] === w)) return k;
  return -1;
};

/** A document with `copies` copies of one phrase, in different units, one unit sometimes holding a second copy. */
function withCopies(r, m) {
  const phrase = Array.from({ length: 3 + int(r, 3) }, () => plainWord(r));
  // identical: the same 64+ characters around every copy; only the words further out differ
  const identical = r() < 0.4;
  const lead = Array.from({ length: 14 }, () => plainWord(r));
  const tail = Array.from({ length: 14 }, () => plainWord(r));
  const all = units(m);
  const picked = all
    .map((_, k) => k)
    .sort(() => r() - 0.5)
    .slice(0, 2 + int(r, 2));
  const placed = []; // one per copy: the unit, the word it starts at, and whether its unit holds another copy
  for (const u of picked) {
    if (identical) {
      all[u].set([plainWord(r), plainWord(r), plainWord(r), ...lead, ...phrase, ...tail]);
      placed.push({ u, i: 3 + lead.length, shared: false });
      continue;
    }
    const words = all[u].words.slice();
    const at = int(r, words.length + 1);
    words.splice(at, 0, ...phrase);
    const copy = { u, i: at, shared: false };
    placed.push(copy);
    if (r() < 0.25) {
      const spots = words.map((_, k) => k).filter((k) => k <= at || k >= at + phrase.length);
      const k = pick(r, [...spots, words.length]);
      words.splice(k, 0, ...phrase);
      if (k <= at) copy.i = at + phrase.length;
      copy.shared = true;
      placed.push({ u, i: k, shared: true });
    }
    all[u].set(words);
  }
  return { phrase, placed };
}

property(
  '7. a lost copy of the quote: an anchor on it is kept only where its words and context are untouched',
  (seed, r) => {
    const m = model(r, 8 + int(r, 8));
    const { phrase, placed } = withCopies(r, m);
    const quote = phrase.join(' ');
    const before = project(m, seed * 3 + 1);
    if (before.text.split(quote).length - 1 !== placed.length) return;
    const anchors = inputs(
      m,
      before.text,
      placed.map((c) => refOf(m, c.u, c.i, c.i + phrase.length - 1)),
    );

    // One copy goes (its words, or its whole paragraph); then edits anywhere, near the copies or not.
    const lost = int(r, placed.length);
    const gone = placed[lost];
    const m1 = clone(m);
    const u1 = units(m1);
    let deletedUnit = -1;
    if (!gone.shared && m1[u1[gone.u].bi].type === 'p' && r() < 0.5) {
      deletedUnit = gone.u;
      m1.splice(u1[gone.u].bi, 1);
    } else {
      const words = u1[gone.u].words.slice();
      words.splice(gone.i, phrase.length);
      u1[gone.u].set(words);
    }
    for (let n = int(r, 5); n > 0; n--) {
      const now = units(m1);
      const u = int(r, now.length);
      const words = now[u].words.slice();
      const op = int(r, 3);
      if (op === 0) words[int(r, words.length)] = freshWord();
      else if (op === 1) words.splice(int(r, words.length + 1), 0, freshWord());
      else if (words.length > 4) words.splice(int(r, words.length), 1);
      now[u].set(words);
    }
    const after = project(m1, seed * 3 + 2);
    const res = resolveAnchors(before, after, anchors);

    assert.equal(
      resolved(res, `a${lost}`).outcome,
      'orphaned',
      'the anchor on the deleted copy must orphan',
    );
    placed.forEach((c, n) => {
      const got = resolved(res, `a${n}`);
      if (got.state !== 'anchored') return;
      // kept: the quote and the 64 characters either side are byte for byte what they were...
      assert.deepEqual(
        selectorAt(after.text, got.start, got.end),
        anchors[n].selector,
        `anchor ${n} is anchored on changed context (${got.outcome})`,
      );
      // ...and, where the copy was alone in its unit, it is in that unit's own place
      if (c.shared) return;
      const unitAfter = deletedUnit >= 0 && c.u > deletedUnit ? c.u - 1 : c.u;
      const at = findWords(units(m1)[unitAfter]?.words ?? [], phrase);
      assert.notEqual(at, -1, `anchor ${n} was kept though its words are gone`);
      const want = locate(m1, { u: unitAfter, i: at, j: at + phrase.length - 1 });
      assert.deepEqual(
        [got.start, got.end],
        [want.start, want.end],
        `anchor ${n} is on another copy`,
      );
    });
  },
);
