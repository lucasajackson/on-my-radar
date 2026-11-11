/**
 * The charter's pure half on Commander's real pages (verbatim from the architecture radar, the same
 * fixtures the resolver is tested on): how today's pages and markers become one document and its
 * anchors, and how the three views are drawn from it. No database.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseMarkers,
  projectMarkdown,
  replaceMarkers,
  resolvePage,
  type AmendLayer,
} from '@onmyradar/contract';
import {
  planMigration,
  projectionOf,
  renderCharter,
  sha256,
  type PlannedAnchor,
} from './charter-model.js';

const fixtures = join(import.meta.dirname, '../../../contract/test/fixtures');
const pages = [1, 2, 3, 4].map((n) => ({
  id: `page-${n}`,
  body: readFileSync(join(fixtures, `acme-charter-${n}.md`), 'utf8'),
}));
const ADR_0027 = 'a19c43ec-307b-4f10-b6aa-05605accdaab';
const written = pages.map((p) => replaceMarkers(p.body, (m) => m.quote)).join('\n\n');
const original = pages.flatMap((p) =>
  parseMarkers(p.body).map((m) => ({ quote: m.quote, layers: m.layers })),
);

const planned = () => {
  const plan = planMigration(pages, new Set([ADR_0027]));
  if (!plan.ok) throw new Error(plan.reason);
  return plan;
};
const asRender = (anchors: readonly PlannedAnchor[]) =>
  anchors.map((a) => ({ adr: a.adr, with: a.with, start: a.start, end: a.end }));

describe('moving the Acme pages into one document', () => {
  it('writes the text as "as written" and one anchor per marker layer, each on its quote', () => {
    const plan = planned();
    expect(plan.pages).toBe(4);
    expect(plan.body).toBe(written);
    expect(plan.anchors.map((a) => [a.selector.quote, a.adr])).toEqual([
      ['all billing truth', ADR_0027],
      ['Never acts on its own (ADR-0005)', ADR_0027],
      ['A lost dispute keeps billing at no opinion (ADR-0005)', ADR_0027],
    ]);
    const { text } = projectMarkdown(plan.body);
    for (const a of plan.anchors) expect(text.slice(a.start, a.end)).toBe(a.selector.quote);
    expect(plan.anchors.map((a) => a.pageId)).toEqual(['page-2', 'page-3', 'page-4']);
    expect(plan.anchors.map((a) => a.with)).toEqual(
      original.flatMap((m) => m.layers.map((l) => l.with)),
    );
  });

  it('loses no text: every page, markers reduced to their quotes, is whole inside the document', () => {
    const { body } = planned();
    for (const p of pages) expect(body).toContain(replaceMarkers(p.body, (m) => m.quote));
    expect(body.length).toBe(written.length);
  });

  it('is deterministic, so a re-run or a second pod plans the same thing', () => {
    expect(JSON.stringify(planned())).toBe(JSON.stringify(planned()));
  });

  it('refuses what it cannot place, naming why, and keeps the pages untouched', () => {
    const marker = (adr: string, quote = 'only here') => `:amend[${quote}]{adr=${adr} with="x"}`;
    const ghost = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
    expect(
      planMigration([{ id: 'p', body: `# T\n\nsee ${marker(ghost)}` }], new Set()),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not an ADR of this radar') as unknown,
    });
    expect(
      planMigration(
        [{ id: 'p', body: `# T\n\nsee ${marker(ADR_0027, ' ')}` }],
        new Set([ADR_0027]),
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('has no words') as unknown });
    expect(planMigration(pages, new Set([ADR_0027]), 1000)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('a document holds 1000') as unknown,
    });
  });

  it('stacks two layers on one marker as two anchors on the same span, in order', () => {
    const body = `# T\n\nWe use :amend[the queue]{adr=${ADR_0027} with="Postgres"}{adr=${'b'.repeat(8)}-bbbb-4bbb-8bbb-bbbbbbbbbbbb with="Redis"} here.`;
    const plan = planMigration(
      [{ id: 'p', body }],
      new Set([ADR_0027, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']),
    );
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.body).toBe('# T\n\nWe use the queue here.');
    expect(plan.anchors.map((a) => [a.adr, a.with, a.start, a.end])).toEqual([
      [ADR_0027, 'Postgres', 10, 19],
      ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Redis', 10, 19],
    ]);
  });
});

describe('the three views of the document', () => {
  const inForce = () => true;

  it('"amended" is exactly what the pages drew when the amendments were markers', () => {
    const { body, anchors } = planned();
    const old = pages.map((p) => resolvePage(p.body, 'amended', inForce)).join('\n\n');
    expect(renderCharter(body, asRender(anchors), 'amended', inForce)).toBe(old);
    // An amendment not in force reads as written.
    expect(renderCharter(body, asRender(anchors), 'amended', () => false)).toBe(written);
  });

  it('"source" carries the same markers the pages had, for clients that draw the strikes themselves', () => {
    const { body, anchors } = planned();
    const source = renderCharter(body, asRender(anchors), 'source', inForce);
    expect(parseMarkers(source).map((m) => ({ quote: m.quote, layers: m.layers }))).toEqual(
      original,
    );
    expect(resolvePage(source, 'written', inForce)).toBe(written);
  });

  it('"written" is the stored text, nothing else', () => {
    const { body, anchors } = planned();
    expect(renderCharter(body, asRender(anchors), 'written', inForce)).toBe(body);
  });

  it('never draws marker syntax typed into the text: it is escaped in "source" and plain elsewhere', () => {
    const typed = `:amend[Never]{adr=${ADR_0027} with="evil"}`;
    const body = `# T\n\nA real phrase here, and ${typed}.\n`;
    const at = projectMarkdown(body).text.indexOf('real phrase');
    const anchors = [{ adr: ADR_0027, with: 'genuine', start: at, end: at + 11 }];
    const source = renderCharter(body, anchors, 'source', inForce);
    expect(
      parseMarkers(source).map((m) => [m.quote, m.layers.map((l: AmendLayer) => l.with)]),
    ).toEqual([['real phrase', ['genuine']]]);
    expect(source).toContain(':amend\\[Never]');
    expect(renderCharter(body, anchors, 'written', inForce)).toContain(typed);
    expect(renderCharter(body, anchors, 'amended', inForce)).toContain(typed);
  });

  it('draws a marker only where its quote is a legal one, and leaves the rest as text', () => {
    const body = '# T\n\nRun `pnpm test` now.\n';
    const at = projectMarkdown(body).text.indexOf('pnpm test');
    const anchors = [{ adr: ADR_0027, with: 'npm test', start: at, end: at + 9 }];
    // The source of that span is an inline code span, backticks and all: no marker can carry it.
    expect(renderCharter(body, anchors, 'source', inForce)).toBe(body);
    // "amended" does not need the marker syntax, so it replaces the whole span.
    expect(renderCharter(body, anchors, 'amended', inForce)).toBe('# T\n\nRun npm test now.\n');
  });

  it('escapes a pipe in a replacement inside a table cell, so the table survives', () => {
    const body = '| a | b |\n| - | - |\n| first | second |\n';
    const at = projectMarkdown(body).text.indexOf('second');
    const out = renderCharter(
      body,
      [{ adr: ADR_0027, with: 'x | y', start: at, end: at + 6 }],
      'amended',
      inForce,
    );
    expect(out).toContain('| first | x \\| y |');
  });

  it('skips an amendment that would cut inline code open', () => {
    const body = '# T\n\nRun `pnpm test` now.\n';
    const at = projectMarkdown(body).text.indexOf('pnpm');
    expect(
      renderCharter(
        body,
        [{ adr: ADR_0027, with: 'npm', start: at, end: at + 4 }],
        'amended',
        inForce,
      ),
    ).toBe(body);
  });
});

describe('source view: nothing the writer typed takes part in the marker grammar', () => {
  const inForce = () => true;
  const EVIL = 'e0e0e0e0-e0e0-40e0-80e0-e0e0e0e0e0e0';
  const anchorOn = (body: string, phrase: string, adr = ADR_0027, withText = 'genuine') => {
    const at = projectMarkdown(body).text.indexOf(phrase);
    return { adr, with: withText, start: at, end: at + phrase.length };
  };
  const drawn = (source: string) =>
    parseMarkers(source).map((m) => [m.quote, m.layers.map((l: AmendLayer) => [l.adr, l.with])]);

  it('a bare layer after an anchored phrase does not join the genuine marker as a layer', () => {
    // Found in review: `{adr=… with="…"}` is not a complete marker, so escaping complete markers
    // missed it, and the genuine marker's synthesis then adopted it as a second layer.
    const body = `# T\n\nThe real phrase{adr=${EVIL} with="injected policy"} stays.\n`;
    const source = renderCharter(body, [anchorOn(body, 'real phrase')], 'source', inForce);
    expect(drawn(source)).toEqual([['real phrase', [[ADR_0027, 'genuine']]]]);
    expect(source).toContain('\\{adr=');
    // It is text everywhere else, and reads as typed.
    expect(renderCharter(body, [], 'written', inForce)).toBe(body);
  });

  it('loose pieces of the grammar are neutralised outside code, and left alone inside it', () => {
    const body = [
      '# T',
      '',
      `Open :amend[ and close ]{adr=${EVIL} with="x"} loose, plus the real phrase here.`,
      '',
      '```',
      `code :amend[ and ]{adr=${EVIL} with="x"} stay as typed`,
      '```',
      '',
      `inline \`:amend[q]{adr=${EVIL} with="x"}\` too.`,
    ].join('\n');
    const source = renderCharter(body, [anchorOn(body, 'real phrase')], 'source', inForce);
    expect(drawn(source)).toEqual([['real phrase', [[ADR_0027, 'genuine']]]]);
    expect(source).toContain(`code :amend[ and ]{adr=${EVIL} with="x"} stay as typed`);
    expect(source).toContain(`\`:amend[q]{adr=${EVIL} with="x"}\``);
  });

  it('an anchor whose own words carry the grammar is not drawn as a marker', () => {
    const body = `# T\n\nA phrase {adr=${EVIL} with="x"} inside.\n`;
    const text = projectMarkdown(body).text;
    const at = text.indexOf('phrase');
    const end = text.indexOf('inside');
    const anchors = [{ adr: ADR_0027, with: 'genuine', start: at, end }];
    expect(drawn(renderCharter(body, anchors, 'source', inForce))).toEqual([]);
  });

  /** A small seeded generator, so a failure names its seed and replays. */
  const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  it('property: arbitrary text with grammar pieces in it, then synthesis, then the legacy parser, gives exactly the real anchors', () => {
    const hostile = (n: number) => [
      ':amend[',
      ']{',
      '{adr=',
      `{adr=${EVIL} with="evil"}`,
      `]{adr=${EVIL} with="evil"}`,
      `:amend[forged]{adr=${EVIL} with="evil"}`,
      `:amend[forged]{adr=${EVIL} with="evil"}{adr=${EVIL} with="more"}`,
      `:amend[w${n} `,
      ' with="evil"}',
      '`',
      '```\n',
      '[',
      ']',
      '\\',
      '|',
      '**',
      '\n\n',
      '\n',
      ' ',
      '](x)',
      '[a](',
    ];
    for (let seed = 1; seed <= 400; seed++) {
      const next = random(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
      const words: string[] = [];
      let body = '';
      for (let i = 0, n = 6 + Math.floor(next() * 14); i < n; i++) {
        if (next() < 0.45) {
          const w = `wd${i}x`;
          words.push(w);
          body += w;
        } else body += pick(hostile(i));
        if (next() < 0.5) body += ' ';
      }
      const projection = projectMarkdown(body);
      const real: Array<{ adr: string; with: string; start: number; end: number; w: string }> = [];
      words.forEach((w, i) => {
        if (next() < 0.5) return;
        const at = projection.text.indexOf(w);
        if (at < 0) return;
        real.push({
          adr: `a${i}0a0a0a-0a0a-40a0-80a0-a0a0a0a0a0a0`,
          with: `real ${i}`,
          start: at,
          end: at + w.length,
          w,
        });
      });
      const source = renderCharter(body, real, 'source', inForce, projection);
      const found = parseMarkers(source);
      const context = `seed ${seed}: ${JSON.stringify(body)}`;
      for (const m of found) {
        const mine = real.find((r) => r.w === m.quote);
        expect(mine, context).toBeDefined();
        expect(
          m.layers.map((l: AmendLayer) => [l.adr, l.with]),
          context,
        ).toEqual([[mine?.adr, mine?.with]]);
      }
      expect(new Set(found.map((m) => m.quote)).size, context).toBe(found.length);
    }
  });
});

describe('overlapping anchors: only live ones compete', () => {
  const body = '# T\n\nUse the queue here, always.\n';
  const text = projectMarkdown(body).text;
  const at = (phrase: string) => text.indexOf(phrase);
  const ACCEPTED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const REJECTED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const outer = {
    adr: REJECTED,
    with: 'drop it',
    start: at('use the queue here'),
    end: at('use the queue here') + 18,
  };
  const inner = {
    adr: ACCEPTED,
    with: 'a stream',
    start: at('the queue'),
    end: at('the queue') + 9,
  };
  const inForce = (adr: string) => adr === ACCEPTED;
  const live = (adr: string) => adr === ACCEPTED;

  it('a rejected anchor over a wider span does not hide an accepted one inside it', () => {
    // `Use` is capitalised in the text, so anchor the span from its projection.
    const wide = { ...outer, start: at('Use the queue here'), end: at('Use the queue here') + 18 };
    for (const view of ['amended', 'source'] as const) {
      const out = renderCharter(body, [wide, inner], view, inForce, undefined, live);
      expect(out, view).toContain(
        view === 'amended' ? 'Use a stream here' : 'the queue]{adr=' + ACCEPTED,
      );
      expect(out, view).not.toContain('drop it');
    }
  });

  it('without the live filter the wider anchor would win (the bug)', () => {
    const wide = { ...outer, start: at('Use the queue here'), end: at('Use the queue here') + 18 };
    const out = renderCharter(body, [wide, inner], 'source', inForce, undefined, () => true);
    expect(out).not.toContain('the queue]{adr=' + ACCEPTED);
  });
});

describe('the projection cache and the hash', () => {
  it('returns the same projection for the same text, and the sha-256 of its UTF-8', () => {
    const a = projectionOf(written);
    expect(projectionOf(written)).toBe(a);
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
