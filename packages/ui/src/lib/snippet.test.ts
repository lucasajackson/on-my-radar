/**
 * The properties a search snippet has to hold.
 *
 * The one that motivated the whole thing is `takes the excerpt from around the
 * match`: a blip can match on a word 600 words in, and showing the top of the
 * body is the version of this feature that makes you read the whole blip to find
 * out why it is in the list.
 */
import { describe, expect, it } from 'vitest';
import { highlightTerms, snippetFor } from './snippet';

const joined = (body: string, query: string, title?: string): string =>
  snippetFor(body, query, title)
    .segments.map((s) => s.text)
    .join('');

const marked = (body: string, query: string): string[] =>
  snippetFor(body, query)
    .segments.filter((s) => s.match)
    .map((s) => s.text);

describe('highlightTerms', () => {
  it('keeps quoted phrases whole', () => {
    expect(highlightTerms('"lane budget" board')).toContain('lane budget');
  });

  it('drops excluded terms rather than marking them', () => {
    // A `-` term is the reason a blip did NOT match on that word. Marking it
    // would say the opposite of what happened.
    expect(highlightTerms('radar -kanban')).toEqual(['radar']);
  });

  it('drops one-character terms, which would turn a snippet into confetti', () => {
    expect(highlightTerms('a radar')).toEqual(['radar']);
  });

  it('is case-insensitive and de-duplicates', () => {
    expect(highlightTerms('Radar radar RADAR')).toEqual(['radar']);
  });

  it('strips trailing punctuation so a sentence-final word still matches', () => {
    expect(highlightTerms('radar,')).toEqual(['radar']);
  });
});

describe('snippetFor', () => {
  it('takes the excerpt from around the match, not from the top of the body', () => {
    const body = `${'filler word '.repeat(120)}the needle is here${' more '.repeat(40)}`;
    const text = joined(body, 'needle');
    expect(text).toContain('needle');
    expect(snippetFor(body, 'needle').clippedStart).toBe(true);
  });

  it('marks every occurrence inside the window', () => {
    expect(marked('a needle and another needle', 'needle')).toEqual(['needle', 'needle']);
  });

  it('marks case-insensitively but keeps the body’s own casing', () => {
    expect(marked('The Needle', 'needle')).toEqual(['Needle']);
  });

  it('merges overlapping terms into one mark rather than nesting them', () => {
    // "radars" and "radar" both hit the same word; two marks over one span would
    // render as a doubled highlight.
    const segments = snippetFor('one radars here', 'radar radars').segments;
    expect(segments.filter((s) => s.match).map((s) => s.text)).toEqual(['radars']);
  });

  it('falls back to the head of the body when nothing matches', () => {
    // Legitimate: a tag: or from: filter with no free text at all.
    const snippet = snippetFor('a body with words in it', '');
    expect(snippet.segments.every((s) => !s.match)).toBe(true);
    expect(joined('a body with words in it', '')).toBe('a body with words in it');
    expect(snippet.clippedStart).toBe(false);
    expect(snippet.clippedEnd).toBe(false);
  });

  it('says when there is more body on either side', () => {
    const short = snippetFor('short', 'short');
    expect(short.clippedStart).toBe(false);
    expect(short.clippedEnd).toBe(false);

    const long = snippetFor('word '.repeat(400), 'word');
    expect(long.clippedEnd).toBe(true);
  });

  it('counts matches in the whole body, not only in the window', () => {
    const body = `needle ${'filler '.repeat(200)} needle`;
    expect(snippetFor(body, 'needle').matches).toBe(2);
  });

  it('reassembles to a contiguous slice of the body', () => {
    const body = 'the quick brown fox jumps over the lazy dog';
    expect(joined(body, 'brown')).toBe(body);
  });

  it('does not choke on a query that is regex metacharacters', () => {
    // A person typing `c++` or `(a)` must get a snippet, not a thrown SyntaxError
    // that white-screens the results list.
    expect(() => snippetFor('some c++ code here', 'c++')).not.toThrow();
    expect(marked('some c++ code here', 'c++')).toEqual(['c++']);
    expect(() => snippetFor('a (b) c', '(b)')).not.toThrow();
  });

  it('drops the title when the body opens with it', () => {
    // A title is derived from a real markdown heading, so on a titled blip the
    // first line of the body IS the title. Rendering both prints the same words
    // twice — the defect `createBlip` was corrected for at the other end.
    const body = '## The pelmet\n\nMeasure it before ordering the blind.';
    expect(joined(body, 'pelmet', 'The pelmet')).toBe('Measure it before ordering the blind.');
  });

  it('keeps a title that the body merely mentions later', () => {
    const body = 'Some words, and then the pelmet again.';
    expect(joined(body, 'pelmet', 'The pelmet')).toBe(body);
  });

  it('strips markdown, so a heading does not arrive as hashes', () => {
    expect(joined('## A heading\n\nand a body', 'heading')).toContain('A heading');
    expect(joined('## A heading\n\nand a body', 'heading')).not.toContain('#');
  });
});
