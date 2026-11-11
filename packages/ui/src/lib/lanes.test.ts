import { expect, it } from 'vitest';
import { draftFromLanes, lanesFromDraft, type LaneDraft } from './lanes';

const fresh = (key: string, label: string): LaneDraft => ({
  key,
  id: null,
  label,
  state: 'active',
  terminal: false,
});

it('keeps a saved lane id through a rename, so its blips stay filed', () => {
  const [backlog] = draftFromLanes([{ id: 'backlog', label: 'Backlog', state: 'inbox' }]);
  if (!backlog) throw new Error('no lane');
  expect(lanesFromDraft([{ ...backlog, label: 'Someday' }])).toEqual([
    { id: 'backlog', label: 'Someday', state: 'inbox' },
  ]);
});

it('names a new lane from its label, unique against the rest of the set', () => {
  const saved = draftFromLanes([{ id: 'review', label: 'Review', state: 'active' }]);
  const ids = lanesFromDraft([
    ...saved,
    fresh('a', 'Review'),
    fresh('b', 'Review!'),
    fresh('c', 'Ready to ship — v2'),
    fresh('d', '✨'),
  ]).map((lane) => lane.id);
  expect(ids).toEqual(['review', 'review-2', 'review-3', 'ready-to-ship-v2', 'lane']);
});

it('keeps a minted id inside the id length limit when it needs a suffix', () => {
  const long = 'An extremely long lane name indeed';
  const ids = lanesFromDraft([fresh('a', long), fresh('b', long)]).map((lane) => lane.id);
  expect(ids.every((id) => id.length <= 24 && /^[a-z0-9][a-z0-9-]*$/.test(id))).toBe(true);
  expect(new Set(ids).size).toBe(2);
});
