import { describe, expect, it } from 'vitest';
import { repoSlugFrom } from '@onmyradar/contract';
import { slugDraft } from './slug';

/** What a field holds after each keystroke of `typed`. */
function typeInto(typed: string, normalise: (value: string) => string): string {
  let field = '';
  for (const key of typed) field = normalise(field + key);
  return field;
}

describe('slugDraft', () => {
  it('lets a hyphenated slug be typed one key at a time', () => {
    expect(typeInto('pr-review', slugDraft)).toBe('pr-review');
    expect(repoSlugFrom(typeInto('pr-review', slugDraft))).toBe('pr-review');
  });

  it('is what the field needed: the final form eats the hyphen mid-word', () => {
    expect(typeInto('pr-review', repoSlugFrom)).toBe('prreview');
  });

  it('still normalises what cannot be in a slug', () => {
    expect(slugDraft('Café  Crème')).toBe('cafe-creme');
    expect(slugDraft('--lead')).toBe('lead');
    expect(slugDraft('ends-')).toBe('ends-');
    expect(repoSlugFrom(slugDraft('ends-'))).toBe('ends');
  });
});
