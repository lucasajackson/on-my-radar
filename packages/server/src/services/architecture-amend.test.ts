/**
 * The amendment marker, against a synthetic pack's tables, fences and ADR-0027's
 * three hand-written anchors. Pure: no database.
 */
import { describe, expect, it } from 'vitest';
import {
  anchorQuote,
  findQuote,
  markerKey,
  parseMarkers,
  resolvePage,
  type AmendLayer,
  type QuoteMatch,
  type QuoteRefusal,
} from '@onmyradar/contract';
import { PAGE_02, PAGE_02_ADR_0024, PAGE_03, PAGE_04 } from '../__fixtures__/acme-architecture.js';
import { ADR_0027_ANCHORS } from './architecture-import.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const pages = [
  { id: 'p02', markdown: PAGE_02 },
  { id: 'p03', markdown: PAGE_03 },
  { id: 'p04', markdown: PAGE_04 },
];
const isRefusal = (hit: QuoteMatch | QuoteRefusal): hit is QuoteRefusal => 'code' in hit;
const match = (quote: string, id?: string): QuoteMatch => {
  const hit = findQuote(pages, quote, id);
  if (isRefusal(hit)) throw new Error(`${hit.code}: ${hit.message}`);
  return hit;
};
const refusal = (quote: string, id?: string): QuoteRefusal => {
  const hit = findQuote(pages, quote, id);
  if (!isRefusal(hit)) throw new Error('expected a refusal');
  return hit;
};
const amend = (source: string, quote: string, layer: AmendLayer, id?: string) =>
  anchorQuote(source, quote, match(quote, id), layer);

describe('finding a quote', () => {
  it('matches each of ADR-0027’s three anchors exactly once', () => {
    expect(ADR_0027_ANCHORS.map((a) => match(a.quote).pageId)).toEqual(['p02', 'p03', 'p04']);
  });

  it('calls a phrase that recurs ambiguous, naming each page and its context', () => {
    const hit = refusal('ADR-0005');
    expect(hit.code).toBe('quote_ambiguous');
    // Three raw occurrences; the one in the mermaid fence is not text a reader can select.
    expect('matches' in hit && hit.matches.map((m) => m.pageId)).toEqual(['p03', 'p04']);
    expect('matches' in hit && hit.matches[0]?.context).toContain('Never acts on its own');
    expect(match('ADR-0005', 'p03').pageId).toBe('p03');
  });

  it('never matches inside a code fence', () => {
    expect(refusal('stays no opinion; staff decide').code).toBe('quote_not_found');
  });

  it('refuses a selection that crosses markdown the reader never sees', () => {
    expect(refusal('disputes: all billing truth').code).toBe('quote_not_found');
    expect(refusal('Stripe | Customers').code).toBe('quote_not_found');
  });

  it('refuses a quote that is not one line of plain text', () => {
    for (const quote of ['', 'a\nb', 'a [b', 'a | b', 'a `b`']) {
      expect(refusal(quote).code, quote).toBe('quote_not_found');
    }
  });

  it('refuses text that is already amended: replacement text, or part of the struck span', () => {
    const source = amend(PAGE_02, 'all billing truth', { adr: A, with: 'payment truth only' });
    const amended = [{ id: 'p02', markdown: source }];
    const replacement = findQuote(amended, 'payment truth only');
    expect(replacement).toMatchObject({ code: 'quote_in_amendment', adr: A });
    expect(findQuote(amended, 'billing truth')).toMatchObject({ code: 'quote_overlaps', adr: A });
    // The exact span stacks a second layer; it is not refused here.
    const exact = findQuote(amended, 'all billing truth');
    expect(isRefusal(exact) ? null : exact.stack?.layers).toHaveLength(1);
  });
});

describe('the marker', () => {
  it('survives a table cell, bold text and a replacement full of syntax', () => {
    const tricky = 'a | b "quoted" \\ done';
    const source = amend(PAGE_02, 'all billing truth', { adr: A, with: tricky });
    expect(source.split('\n')).toHaveLength(PAGE_02.split('\n').length);
    const [marker] = parseMarkers(source);
    expect(marker?.quote).toBe('all billing truth');
    expect(marker?.layers).toEqual([{ adr: A, with: tricky }]);
    expect(source).toContain('**:amend[all billing truth]{adr=');
  });

  it('stacks a second layer on the same span and keeps one marker', () => {
    const once = amend(PAGE_02, 'all billing truth', { adr: A, with: 'one' });
    const twice = anchorQuote(once, 'all billing truth', match2(once), { adr: B, with: 'two' });
    expect(parseMarkers(twice)).toHaveLength(1);
    expect(parseMarkers(twice)[0]?.layers.map((l) => l.adr)).toEqual([A, B]);
  });

  it('ignores a marker written inside a code fence', () => {
    const fenced = '```\n:amend[x]{adr=' + A + ' with="y"}\n```';
    expect(parseMarkers(fenced)).toHaveLength(0);
  });

  it('is unchanged by prose edits and changed by any edit to a marker', () => {
    const source = amend(PAGE_02, 'all billing truth', { adr: A, with: 'one' });
    expect(markerKey(`New line\n${source}`)).toBe(markerKey(source));
    expect(markerKey(source.replace('with="one"', 'with="two"'))).not.toBe(markerKey(source));
    expect(markerKey(source.replace(/:amend\[|\]\{adr=.*?\}/g, ''))).not.toBe(markerKey(source));
  });
});

describe('what a reader gets, by the ADR’s lane', () => {
  const source = amend(PAGE_02, 'all billing truth', { adr: A, with: 'payment truth only' });
  const stacked = anchorQuote(source, 'all billing truth', match2(source), {
    adr: B,
    with: 'later',
  });
  const line = (view: 'written' | 'amended', inForce: (adr: string) => boolean, text = source) =>
    resolvePage(text, view, inForce).split('\n')[3] ?? '';

  it('shows the original unless an accepted ADR replaces it', () => {
    const none = () => false;
    expect(line('amended', none)).toContain('**all billing truth**');
    expect(line('written', (adr) => adr === A)).toContain('**all billing truth**');
    expect(line('amended', (adr) => adr === A)).toContain('**payment truth only**');
  });

  it('shows the last accepted layer of a stack, skipping one that is not in force', () => {
    expect(line('amended', () => true, stacked)).toContain('**later**');
    expect(line('amended', (adr) => adr === A, stacked)).toContain('**payment truth only**');
  });
});

function match2(source: string): QuoteMatch {
  const hit = findQuote([{ id: 'p02', markdown: source }], 'all billing truth');
  if (isRefusal(hit)) throw new Error(hit.message);
  return hit;
}

describe('anchoring the occurrence that was selected', () => {
  // Two rows of the real table name ADR-0024, on one page.
  const two = [{ id: 'p', markdown: PAGE_02_ADR_0024.join('\n') }];
  const pick = (context?: { occurrence: number; seen: number }, source = two) =>
    findQuote(source, 'ADR-0024', 'p', context);
  const line = (hit: QuoteMatch | QuoteRefusal, source = two) =>
    'at' in hit ? source[0]?.markdown.slice(0, hit.at).split('\n').length : -1;

  it('is ambiguous with no occurrence, and ignores one that names no page', () => {
    expect(pick()).toMatchObject({ code: 'quote_ambiguous' });
    expect(findQuote(two, 'ADR-0024', undefined, { occurrence: 0, seen: 2 })).toMatchObject({
      code: 'quote_ambiguous',
    });
  });

  it('anchors the occurrence that was selected, and writes the marker there', () => {
    expect(line(pick({ occurrence: 0, seen: 2 }))).toBe(1);
    expect(line(pick({ occurrence: 1, seen: 2 }))).toBe(2);
    const marked = anchorQuote(
      two[0]?.markdown ?? '',
      'ADR-0024',
      pick({ occurrence: 1, seen: 2 }) as QuoteMatch,
      { adr: A, with: 'x' },
    );
    expect(parseMarkers(marked).map((m) => marked.slice(0, m.start).split('\n').length)).toEqual([
      2,
    ]);
  });

  it('refuses with quote_moved when the count the reader saw is not the count there is', () => {
    // A second occurrence edited away since the page was read.
    const edited = [{ id: 'p', markdown: PAGE_02_ADR_0024.slice(0, 1).join('\n') }];
    expect(pick({ occurrence: 0, seen: 2 }, edited)).toMatchObject({ code: 'quote_moved' });
    expect(pick({ occurrence: 1, seen: 2 }, edited)).toMatchObject({ code: 'quote_moved' });
    // One added.
    expect(pick({ occurrence: 0, seen: 1 })).toMatchObject({ code: 'quote_moved' });
    expect(pick({ occurrence: 2, seen: 2 })).toMatchObject({ code: 'quote_moved' });
    // Text that is gone altogether is simply not found.
    expect(findQuote(edited, 'ADR-9999', 'p', { occurrence: 0, seen: 1 })).toMatchObject({
      code: 'quote_not_found',
    });
  });

  it('counts what a reader sees: list items count, a code fence label does not', () => {
    const list = [{ id: 'p', markdown: '1. Use TLS.\n2. Rotate keys.' }];
    expect(findQuote(list, 'Use TLS.', 'p', { occurrence: 0, seen: 1 })).toMatchObject({ at: 3 });
    const markdown = '```Use TLS.\ncode\n```\n\nUse TLS. Always.';
    const fenced = [{ id: 'p', markdown }];
    expect(findQuote(fenced, 'Use TLS.', 'p', { occurrence: 0, seen: 1 })).toMatchObject({
      at: markdown.lastIndexOf('Use TLS.'),
    });
  });

  it('counts the same with an amendment already on the page', () => {
    const source = PAGE_02_ADR_0024.join('\n');
    const struck = anchorQuote(
      source,
      'Only workspaces with an',
      findQuote(two, 'Only workspaces with an') as QuoteMatch,
      { adr: B, with: 'Some sites' },
    );
    const both = [{ id: 'p', markdown: struck }];
    expect(line(pick({ occurrence: 0, seen: 2 }, both), both)).toBe(1);
    expect(line(pick({ occurrence: 1, seen: 2 }, both), both)).toBe(2);
  });
});
