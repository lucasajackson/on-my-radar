import { describe, expect, it } from 'vitest';
import { anchorQuote, findQuote, type QuoteMatch } from '@onmyradar/contract';
import { PAGE_02, PAGE_04 } from '../../../server/src/__fixtures__/acme-architecture';
import { renderMarkdown, type AmendContext } from './markdown';

const A = '11111111-1111-4111-8111-111111111111';
const amend = (source: string, quote: string, replacement: string) => {
  const hit = findQuote([{ id: 'p', markdown: source }], quote) as QuoteMatch;
  return anchorQuote(source, quote, hit, { adr: A, with: replacement });
};
const ctx = (lane: string | null, view: AmendContext['view'] = 'written'): AmendContext => ({
  view,
  adrs: new Map([[A, { label: 'ADR-0027', lane }]]),
});
const row = amend(PAGE_02, 'all billing truth', 'payment truth only');

describe('amendment markers in a charter page', () => {
  it('strikes accepted text with a superscript link to its ADR', () => {
    const html = renderMarkdown(row, { amend: ctx('accepted') });
    expect(html).toContain(
      `<strong><del class="amend-struck">all billing truth</del><sup class="amend-ref"><a href="#adr-${A}" data-adr="ADR-0027" aria-label="ADR-0027"></a></sup></strong>`,
    );
  });

  it('shows the replacement instead in the amended view', () => {
    const html = renderMarkdown(row, { amend: ctx('accepted', 'amended') });
    expect(html).toContain('<ins class="amend-with" data-was="17">payment truth only</ins>');
    expect(html).not.toContain('<del');
    expect(html).not.toContain('all billing truth');
  });

  it('highlights a proposed amendment and leaves the rest of the lanes inert', () => {
    expect(renderMarkdown(row, { amend: ctx('proposed') })).toContain(
      '<mark class="amend-proposed">all billing truth</mark>',
    );
    for (const lane of ['rejected', 'repealed', null]) {
      const html = renderMarkdown(row, { amend: ctx(lane, 'amended') });
      expect(html, String(lane)).toContain('<strong>all billing truth</strong>');
      expect(html, String(lane)).not.toMatch(/<(del|ins|mark|sup)/);
    }
  });

  it('keeps the table, its code spans and its cell count whatever the replacement holds', () => {
    const piped = amend(PAGE_02, 'all billing truth', 'a | b "quoted" \\ done');
    const html = renderMarkdown(piped, { amend: ctx('accepted', 'amended') });
    expect(html).toContain('<table>');
    expect(html.match(/<td>/g)).toHaveLength(5);
    expect(html).toContain('<code>contracts/stripe.md</code>');
    expect(html).toContain('a | b &quot;quoted&quot; \\ done');
  });

  it('marks up a quote in prose beside a code span', () => {
    const quote = 'A lost dispute keeps billing at no opinion (ADR-0005)';
    const html = renderMarkdown(amend(PAGE_04, quote, 'x'), { amend: ctx('accepted') });
    expect(html).toContain(`<del class="amend-struck">${quote}</del>`);
    expect(html).toContain('<code>disputed</code>');
  });

  it('is inert against markup in the quote, the replacement and the label', () => {
    const quote = '<img src=x onerror=alert(1)>';
    const source = amend(`Before ${quote} after`, quote, '"><script>alert(2)</script>');
    const hostile = {
      view: 'written' as const,
      adrs: new Map([[A, { label: '"><b>x</b>', lane: 'accepted' }]]),
    };
    for (const view of ['written', 'amended'] as const) {
      const html = renderMarkdown(source, { amend: { ...hostile, view } });
      expect(html, view).not.toMatch(/<img|<script|<b>/);
    }
  });

  it('cannot be forged with the placeholder characters, and degrades to the quote without a context', () => {
    expect(renderMarkdown('plain 0 text')).not.toContain('undefined');
    expect(renderMarkdown(row)).toContain('<strong>all billing truth</strong>');
  });

  it('reads markers exactly as the server guard does: a forged one stays literal text', () => {
    // A private-use character inside the UUID: the guard sees no marker, so neither may the renderer.
    const forged = row.replace(A, `${A.slice(0, 8)}\uE000${A.slice(8)}`);
    const html = renderMarkdown(forged, { amend: ctx('accepted', 'amended') });
    expect(html).not.toMatch(/<(del|ins|sup)/);
    expect(html).toContain(':amend[all billing truth]');
  });
});
