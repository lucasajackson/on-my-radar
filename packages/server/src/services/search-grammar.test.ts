import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  pendingClosedFilter,
  pendingSearchFilter,
  parseSearchQuery,
  tokensFor,
} from '@onmyradar/contract';
import { must } from '../errors.js';

describe('structured search groups', () => {
  it('parses both negations and pipe alternatives without consuming ordinary text exclusions', () => {
    const parsed = parseSearchQuery(
      'release -draft -tag:bug|techdebt not:in:"Noise radar" topic:"Product work"',
    );
    expect(parsed.text).toBe('release -draft');
    expect(parsed.problems).toEqual([]);
    expect(parsed.tokens[0]).toMatchObject({
      field: 'tag',
      values: ['bug', 'techdebt'],
      negated: true,
    });
    expect(parsed.tokens[1]).toMatchObject({ field: 'in', value: 'Noise radar', negated: true });
    expect(tokensFor(parsed, 'topic')).toEqual(['Product work']);
  });
  it('reads array: as a synonym of topic:, negated, alternated and completed', () => {
    const viaTopic = parseSearchQuery('topic:"Product work"|Design -topic:Old');
    const viaArray = parseSearchQuery('array:"Product work"|Design not:array:Old');
    expect(viaArray.problems).toEqual([]);
    expect(tokensFor(viaArray, 'topic')).toEqual(tokensFor(viaTopic, 'topic'));
    expect(viaArray.tokens.map((t) => [t.field, t.values, t.negated])).toEqual(
      viaTopic.tokens.map((t) => [t.field, t.values, t.negated]),
    );
    const input = 'array:"Product work';
    const pending = pendingSearchFilter(input, input.length);
    expect(pending).toMatchObject({ field: 'topic', typed: 'Product work' });
  });
  it('preserves quoted pipes and colons while splitting unquoted alternatives', () => {
    expect(parseSearchQuery('in:"A|B"|"9:30 work"').tokens[0]?.values).toEqual([
      'A|B',
      '9:30 work',
    ]);
    expect(parseSearchQuery('"tag:bug" https://example.com -word').text).toBe(
      '"tag:bug" https://example.com -word',
    );
  });
  it('reports every malformed known filter, including empty alternatives and invalid not syntax', () => {
    for (const input of [
      'tag:bug||debt',
      '-kind:fake',
      'not:word',
      'not:nope:value',
      'is:active|fake',
      'stale:wrong',
    ]) {
      expect(parseSearchQuery(input).problems.length, input).toBeGreaterThan(0);
    }
  });
  it('rejects excess filters and values explicitly rather than truncating', () => {
    const overflow = parseSearchQuery(
      Array.from({ length: LIMITS.searchFiltersPerField + 1 }, (_, i) => `in:r${i}`).join(' '),
    );
    expect(overflow.problems[0]?.raw).toBe(`in:r${LIMITS.searchFiltersPerField}`);
    expect(overflow.problems[0]?.message).toContain('No filters were ignored');
    expect(
      parseSearchQuery(
        'tag:' +
          Array.from({ length: LIMITS.searchFiltersPerField + 1 }, (_, i) => `t${i}`).join('|'),
      ).problems,
    ).toHaveLength(1);
    expect(parseSearchQuery('in:' + 'x'.repeat(LIMITS.searchValue + 1)).problems).toHaveLength(1);
  });
  it('completes a quoted topic or a negative OR alternative without discarding its prefix', () => {
    for (const input of ['-in:Engineering|Else', 'not:topic:"Product work', 'from:Lucas|Ada']) {
      const pending = pendingSearchFilter(input, input.length);
      expect(pending).not.toBeNull();
      const completed = input.slice(0, must(pending).replacementStart) + '"New choice"';
      expect(parseSearchQuery(completed).problems).toEqual([]);
      expect(parseSearchQuery(completed).tokens[0]?.negated ?? false).toBe(
        !input.startsWith('from'),
      );
    }
    expect(pendingSearchFilter('in:Work ', 8)).toBeNull();
  });
  it('accepts activity spans and dates using the same UTC date validation', () => {
    expect(parseSearchQuery('touched:7d stale:2026-01-01').problems).toEqual([]);
    expect(parseSearchQuery('touched:2026-02-31').problems).toHaveLength(1);
  });
});

describe('completing a closed filter', () => {
  it('offers the values that start with what is typed, after any alternatives', () => {
    expect(pendingClosedFilter('falcon has:', 11)).toEqual({
      field: 'has',
      typed: '',
      replacementStart: 11,
      options: ['link', 'attachment', 'comment'],
    });
    expect(pendingClosedFilter('is:do', 5)?.options).toEqual(['done']);
    expect(pendingClosedFilter('-kind:link|no', 13)).toMatchObject({
      field: 'kind',
      typed: 'no',
      replacementStart: 11,
      options: ['note'],
    });
    expect(pendingClosedFilter('in:Board', 8)).toBeNull();
    expect(pendingClosedFilter('has:link words', 14)).toBeNull();
  });
});
