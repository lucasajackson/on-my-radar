/**
 * A seeded generator of charters for the anchor property tests.
 *
 * A document is a *model*: units of words, where a unit is whatever the
 * projection will call a block (a paragraph, a heading, a list item, a table
 * cell). `render(model, seed)` writes the model as markdown, and the seed
 * chooses only formatting: emphasis, links, code spans, escapes and entities,
 * soft wraps and hard breaks, list markers, setext or ATX headings, table
 * padding and alignment, blank lines, line endings. Rendering one model with
 * two seeds is therefore a formatting-only edit; changing a word in the model
 * is an edit to the words. The projection of a render must equal
 * `expectedText(model)`, which is checked wherever a test depends on it.
 *
 * No `Math.random`, no clock: every run is reproducible from its seed.
 */

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const int = (r, n) => Math.floor(r() * n);
export const pick = (r, list) => list[int(r, list.length)];
const chance = (r, p) => r() < p;

const ONSET = [
  'b',
  'c',
  'd',
  'f',
  'g',
  'h',
  'j',
  'k',
  'l',
  'm',
  'n',
  'p',
  'r',
  's',
  't',
  'v',
  'w',
  'z',
];
const VOWEL = ['a', 'e', 'i', 'o', 'u', 'ai', 'ou', 'ea'];
const CODA = ['', 'n', 'r', 's', 'l', 'm', 'x'];

/** A pronounceable word that is plain letters: a space of about 10^5 per syllable pair. */
export function plainWord(r) {
  let w = '';
  for (let n = 2 + int(r, 2); n > 0; n--) w += pick(r, ONSET) + pick(r, VOWEL) + pick(r, CODA);
  return w;
}

/** Words that need escaping somewhere in markdown. They never start a line and are never wrapped in emphasis. */
const SPECIAL = [
  'A*',
  'snake_case',
  'x[1]',
  'R&D',
  'a<b',
  'f(x)',
  'a|b',
  'tick`s',
  '#tag',
  'cost*s*',
  '(ADR-0005)',
];

export function word(r, atStart) {
  return !atStart && chance(r, 0.12) ? pick(r, SPECIAL) : plainWord(r);
}

const isPlain = (w) => /^[a-z]+$/.test(w);

/**
 * Never two equal words in a row. "a a" cannot tell which "a" an edit removed, so no resolver could say
 * whether the anchored one went: that ambiguity is real and is accepted, not something to generate.
 */
export function unit(r, min = 3, max = 24) {
  const n = min + int(r, max - min + 1);
  const words = [];
  for (let i = 0; i < n; i++) {
    let w = word(r, i === 0);
    while (w === words[i - 1]) w = word(r, i === 0);
    words.push(w);
  }
  return words;
}

/**
 * model: [{ type: 'p' | 'h' | 'ul' | 'table', ... }]
 *   p     { words }
 *   h     { words, level }
 *   ul    { items: [words], ordered }
 *   table { rows: [[words]] }   rows[0] is the header; every row has the same number of cells
 */
export function model(r, size = 24) {
  const blocks = [];
  while (blocks.length < size) {
    const roll = r();
    if (roll < 0.5) blocks.push({ type: 'p', words: unit(r) });
    else if (roll < 0.62) blocks.push({ type: 'h', level: 1 + int(r, 3), words: unit(r, 1, 6) });
    else if (roll < 0.82)
      blocks.push({
        type: 'ul',
        ordered: chance(r, 0.3),
        items: Array.from({ length: 2 + int(r, 3) }, () => unit(r, 2, 14)),
      });
    else {
      const cols = 2 + int(r, 3);
      blocks.push({
        type: 'table',
        rows: Array.from({ length: 2 + int(r, 3) }, () =>
          Array.from({ length: cols }, () => unit(r, 1, 9)),
        ),
      });
    }
  }
  return blocks;
}

/** The units of a model in projection order, as [blockIndex, ...path] addresses with their words. */
export function units(m) {
  const out = [];
  m.forEach((b, bi) => {
    if (b.type === 'p' || b.type === 'h')
      out.push({ bi, words: b.words, set: (w) => (b.words = w) });
    else if (b.type === 'ul')
      b.items.forEach((words, ii) => out.push({ bi, words, set: (w) => (b.items[ii] = w) }));
    else
      b.rows.forEach((row, ri) =>
        row.forEach((words, ci) => out.push({ bi, words, set: (w) => (b.rows[ri][ci] = w) })),
      );
  });
  return out;
}

export const expectedText = (m) =>
  units(m)
    .map((u) => u.words.join(' '))
    .join('\n\n');

export const clone = (m) => JSON.parse(JSON.stringify(m));

/** Offset of word `i` of unit `u` in the projection of model `m`. */
export function offsetOf(m, u, i) {
  let at = 0;
  const all = units(m);
  for (let k = 0; k < u; k++) at += all[k].words.join(' ').length + 2;
  return at + all[u].words.slice(0, i).join(' ').length + (i > 0 ? 1 : 0);
}

/**
 * Where a reference lands in the projection of `m`. A reference is
 * { u, i, j } (words i..j of unit u) or { u, i, u2, j } (from word i of unit u
 * through word j of unit u2, crossing a block boundary).
 */
export function locate(m, ref) {
  const all = units(m);
  const u2 = ref.u2 ?? ref.u;
  const start = offsetOf(m, ref.u, ref.i);
  const end = offsetOf(m, u2, ref.j) + all[u2].words[ref.j].length;
  return { start, end };
}

// --- rendering ---------------------------------------------------------------------------------

const ESCAPABLE = new Set(['*', '_', '[', ']', '&', '<', '`', '|', '#', '(', ')']);
const ENTITY = {
  '*': '&#42;',
  _: '&#95;',
  '&': '&amp;',
  '<': '&lt;',
  '[': '&#91;',
  ']': '&#93;',
  '`': '&#96;',
  '#': '&#35;',
};

function escapeWord(r, w, inCell) {
  let out = '';
  for (const c of w) {
    if (c === '|' && inCell) out += '\\|';
    else if (!ESCAPABLE.has(c) || c === '(' || c === ')' || c === '#') out += c;
    else if (c === '|') out += c;
    else if (c === '&' && chance(r, 0.4)) out += c;
    else if (chance(r, 0.65) || !ENTITY[c]) out += '\\' + c;
    else out += ENTITY[c];
  }
  return out;
}

const WRAPS = [
  (t) => `**${t}**`,
  (t) => `__${t}__`,
  (t) => `_${t}_`,
  (t) => `*${t}*`,
  (t) => `~~${t}~~`,
  (t) => `[${t}](https://example.test/a?b=1)`,
  (t) => `\`${t}\``,
  (t) => `***${t}***`,
];

/** Words of one unit as markdown inline text. */
function inline(r, words, inCell) {
  const parts = [];
  for (let k = 0; k < words.length;) {
    // wrap a run of plain words, never at the very first word of a table cell's line start worries: wraps are safe anywhere
    if (isPlain(words[k]) && chance(r, 0.18)) {
      let run = 1;
      while (k + run < words.length && isPlain(words[k + run]) && run < 4 && chance(r, 0.5)) run++;
      parts.push(pick(r, WRAPS)(words.slice(k, k + run).join(' ')));
      k += run;
    } else {
      parts.push(escapeWord(r, words[k], inCell));
      k++;
    }
  }
  let out = parts[0];
  for (let k = 1; k < parts.length; k++) {
    let sep = ' ';
    if (inCell) {
      const roll = r();
      sep = roll < 0.1 ? '  ' : roll < 0.15 ? ' <br> ' : ' ';
    } else {
      const roll = r();
      sep =
        roll < 0.6
          ? ' '
          : roll < 0.7
            ? '  '
            : roll < 0.8
              ? '\n'
              : roll < 0.88
                ? '\n  '
                : roll < 0.94
                  ? '  \n'
                  : '\\\n';
    }
    out += sep + parts[k];
  }
  return out;
}

function renderTable(r, rows) {
  const cols = rows[0].length;
  const cells = rows.map((row) => row.map((words) => inline(r, words, true)));
  const pad = chance(r, 0.6);
  const widths = Array.from({ length: cols }, (_, c) =>
    Math.max(3, ...cells.map((row) => row[c].length)),
  );
  const fmt = (row) =>
    '| ' + row.map((cell, c) => (pad ? cell.padEnd(widths[c]) : cell)).join(' | ') + ' |';
  const align = Array.from({ length: cols }, () => pick(r, ['none', 'left', 'right', 'center']));
  const bar = (kind, w) =>
    kind === 'left'
      ? ':' + '-'.repeat(w - 1)
      : kind === 'right'
        ? '-'.repeat(w - 1) + ':'
        : kind === 'center'
          ? ':' + '-'.repeat(w - 2) + ':'
          : '-'.repeat(w);
  const rule = '| ' + align.map((a, c) => bar(a, pad ? widths[c] : 3)).join(' | ') + ' |';
  return [fmt(cells[0]), rule, ...cells.slice(1).map(fmt)].join('\n');
}

export function render(m, seed) {
  const r = rng(seed);
  const out = [];
  for (const b of m) {
    if (b.type === 'p') out.push(inline(r, b.words, false));
    else if (b.type === 'h') {
      const text = inline(r, b.words, true).replace(/ <br> /g, ' ');
      if (b.level < 3 && !b.words.some((w) => !isPlain(w)) && chance(r, 0.3))
        out.push(`${text}\n${b.level === 1 ? '=' : '-'.repeat(3)}`);
      else
        out.push(
          '#'.repeat(b.level) + ' ' + text + (chance(r, 0.2) ? ' ' + '#'.repeat(b.level) : ''),
        );
    } else if (b.type === 'ul') {
      const marker = b.ordered ? pick(r, ['.', ')']) : pick(r, ['-', '*', '+']);
      out.push(
        b.items
          .map(
            (words, n) =>
              (b.ordered ? `${n + 1}${marker}` : marker) +
              ' ' +
              inline(r, words, false).replace(/\n {0,2}/g, '\n   '),
          )
          .join('\n'),
      );
    } else out.push(renderTable(r, b.rows));
  }
  let doc = out.join(chance(r, 0.2) ? '\n\n\n' : '\n\n') + '\n';
  if (chance(r, 0.15)) doc = doc.replace(/\n/g, '\r\n');
  return doc;
}

// --- editing -----------------------------------------------------------------------------------

let fresh = 0;
/** A word no generated model contains, and that differs on every call. */
export const freshWord = () => `qz${(fresh++).toString(36)}x`;
/** Restarts the counter, so a seed produces the same words however it is reached. */
export const resetFresh = () => {
  fresh = 0;
};
