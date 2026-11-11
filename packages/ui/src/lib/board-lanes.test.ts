import { expect, it } from 'vitest';
import { openLanes } from './board-lanes';

const lanes = [
  { id: 'backlog' },
  { id: 'todo' },
  { id: 'doing' },
  { id: 'blocked' },
  { id: 'done', terminal: true },
];
const order = lanes.map((lane) => lane.id);
const open = (
  counts: Record<string, number>,
  extra: { wanted?: string[]; furled?: string[] } = {},
) =>
  [
    ...openLanes({
      lanes,
      order,
      furled: new Set(extra.furled ?? []),
      wanted: extra.wanted ?? [],
      counts: (id) => counts[id] ?? 0,
      budget: 3,
    }),
  ].sort();

it('opens the lanes that hold cards before empty ones', () => {
  // Blocked holds the only work; the old template-order rule railed it.
  expect(open({ blocked: 2 })).toEqual(['backlog', 'blocked', 'todo']);
});

it('keeps finished lanes behind working ones, even when they hold cards', () => {
  expect(open({ done: 9 })).toEqual(['backlog', 'doing', 'todo']);
});

it('lets a lane opened from its rail outrank everything', () => {
  expect(open({ backlog: 1, todo: 1, doing: 1 }, { wanted: ['done'] })).toContain('done');
});

it('never reopens a lane furled on purpose', () => {
  expect(open({ blocked: 5 }, { furled: ['blocked'] })).not.toContain('blocked');
});
