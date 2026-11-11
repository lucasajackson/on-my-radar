import { expect, it } from 'vitest';
import type { CharterDiffDto, CharterVersionDto } from '@onmyradar/contract';
import {
  agoOf,
  changesFit,
  changesOf,
  countOf,
  limitNote,
  stampOf,
  whoOf,
  whyOf,
} from './charter-history';

const v = (over: Partial<CharterVersionDto>): CharterVersionDto => ({
  version: 3,
  createdAt: '2026-10-30T14:14:00',
  cause: 'edit',
  label: 'v3',
  note: null,
  by: { kind: 'person', id: 'u', name: 'Lucas' },
  via: null,
  subject: null,
  ...over,
});

it('says why a version exists, in the lane the ADR was in then (not now)', () => {
  const adr = { id: 'a', label: 'ADR-0027', lane: 'repealed' };
  expect(whyOf(v({ cause: 'adr', subject: adr, lane: 'accepted' }))).toBe('Accepted ADR-0027');
  expect(whyOf(v({ cause: 'adr', subject: adr, lane: 'proposed' }))).toBe('Proposed ADR-0027');
  expect(whyOf(v({ cause: 'edit' }))).toBe('Edited');
  expect(whyOf(v({ cause: 'migration' }))).toBe('Migrated');
  expect(whyOf(v({ cause: 'restore', restoredFrom: 3 }))).toBe('Restored from v3');
  expect(whyOf(v({ cause: 'restore', restoredFrom: null }))).toBe('Restored');
  expect(
    whyOf(v({ cause: 'anchor', subject: { id: 'b', label: 'Billing', lane: 'boundary' } })),
  ).toBe('Linked Billing');
  expect(whyOf(v({ cause: 'anchor', subject: adr }))).toBe('Re-anchored ADR-0027');
});

it('names who made a version: the person, the agent, or the migration for the seed', () => {
  expect(whoOf(v({}))).toBe('Lucas');
  expect(whoOf(v({ by: { kind: 'agent', id: 'a', name: 'Scout' } }))).toBe('Scout');
  expect(whoOf(v({ by: { kind: 'agent', id: 'a', name: null } }))).toBe('an agent');
  expect(whoOf(v({ by: { kind: 'person', id: null, name: null } }))).toBe('someone');
  // The migrated v1 has no author at all.
  expect(whoOf(v({ cause: 'migration', by: { kind: 'person', id: null, name: null } }))).toBe(
    'Migration',
  );
  // A name that is there is kept, whatever made the version.
  expect(whoOf(v({ cause: 'migration' }))).toBe('Lucas');
});

it('reads a stamp and a time ago', () => {
  expect(stampOf('2026-10-30T14:14:00')).toBe('30 Oct, 2:14pm');
  expect(stampOf('2026-10-30T00:05:00')).toBe('30 Oct, 12:05am');
  const at = new Date('2026-10-30T14:14:00').getTime();
  expect(agoOf('2026-10-30T14:14:00', at + 10_000)).toBe('just now');
  expect(agoOf('2026-10-30T14:14:00', at + 5 * 60_000)).toBe('5 min ago');
  expect(agoOf('2026-10-30T14:14:00', at + 3 * 3_600_000)).toBe('3 h ago');
  expect(agoOf('2026-10-30T14:14:00', at + 2 * 86_400_000)).toBe('2 d ago');
  expect(agoOf('2026-10-30T14:14:00', at + 30 * 86_400_000)).toBe('30 Oct, 2:14pm');
});

const diff = (
  hunks: CharterDiffDto['hunks'],
  over: Partial<CharterDiffDto> = {},
): CharterDiffDto => ({
  from: { version: 1 },
  to: { version: 'head' },
  identical: false,
  exact: true,
  truncated: false,
  stats: { hunks: hunks.length, struckChars: 0, insertedChars: 0 },
  hunks,
  ...over,
});

it('places a deletion in the newer text: between two hunks the texts are equal', () => {
  // old: "AAAA" + "xx" + "BBBB" + "yyy" + "CCCC"   (struck: xx at 4, yyy at 10)
  // new: "AAAA" + "ZZZ" + "BBBB" + "CCCC"          (inserted ZZZ at 4; yyy gone)
  const changes = changesOf(
    diff([
      {
        section: null,
        struck: { start: 4, end: 6, text: 'xx' },
        inserted: { start: 4, end: 7, text: 'ZZZ' },
      },
      { section: null, struck: { start: 10, end: 13, text: 'yyy' }, inserted: null },
      { section: null, struck: null, inserted: { start: 15, end: 17, text: 'WW' } },
    ]),
  );
  expect(changes.map((c) => c.at)).toEqual([4, 11, 15]);
  expect(changes[1]).toMatchObject({ struck: 'yyy', inserted: null, index: 1 });
  // an insertion's place in the old text, by the same walk, is where the last hunk ended there
  expect(changes[2]?.struck).toBeNull();
});

it('draws a diff only on the text it was made on', () => {
  const text = 'AAAA ZZZ BBBB';
  const changes = changesOf(
    diff([{ section: null, struck: null, inserted: { start: 5, end: 8, text: 'ZZZ' } }]),
  );
  expect(changesFit(changes, text)).toBe(true);
  expect(changesFit(changes, 'AAAA YYY BBBB')).toBe(false);
  // a passage the answer cut short cannot be checked in full, so it is not held against the text
  const cut = changesOf(
    diff([{ section: null, struck: null, inserted: { start: 5, end: 8, text: 'Z…' } }]),
  );
  expect(changesFit(cut, 'anything at all')).toBe(true);
});

it('counts, and says when the list is cut or not word for word', () => {
  expect(countOf(0)).toBe('No changes');
  expect(countOf(1)).toBe('1 change');
  expect(countOf(4)).toBe('4 changes');
  expect(limitNote(diff([]))).toBeNull();
  expect(
    limitNote(
      diff(new Array(200).fill({ section: null, struck: null, inserted: null }) as never, {
        truncated: true,
        stats: { hunks: 250, struckChars: 0, insertedChars: 0 },
      }),
    ),
  ).toBe('Showing the first 200 of 250 changes.');
  expect(limitNote(diff([], { exact: false }))).toBe(
    'Some stretches are shown as wholly replaced.',
  );
});
