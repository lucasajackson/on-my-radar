import { expect, it } from 'vitest';
import type { DashboardDto } from '@onmyradar/contract';
import {
  addWidget,
  arrangeWidgets,
  tabContents,
  widgetLayout,
  visibleWidgetLayout,
} from './dashboard';
import { must } from './must';
type Widget = DashboardDto['widgets'][number];
const widget = (id: string, x = 0, y = 0): Widget => ({
  id,
  radarId: null,
  x,
  y,
  w: 4,
  h: 10,
  config: { type: 'query', title: id, query: 'is:inbox', limit: 12 },
});
it('preserves persisted widget identity and queries while omitting temporary IDs', () => {
  const result = widgetLayout([widget('saved'), widget('new-123')]);
  expect(result[0]).toEqual(widget('saved'));
  expect(result[1]).not.toHaveProperty('id');
  expect(must(result[1]).config).toEqual(widget('new-123').config);
});
it('moves obstructing cards below the edited widget without losing configuration', () => {
  const result = must(arrangeWidgets([widget('old'), widget('edited')], 'edited'));
  expect(must(result.find((w) => w.id === 'edited')).y).toBe(0);
  expect(must(result.find((w) => w.id === 'old')).y).toBe(10);
  expect(must(result[0]).config).toEqual(widget('old').config);
});
it('places new cards in available columns and then rows', () => {
  let widgets: Widget[] = [];
  for (let i = 0; i < 4; i++) widgets = must(addWidget(widgets, widget(String(i))));
  expect(widgets.map(({ x, y }) => [x, y])).toEqual([
    [0, 0],
    [4, 0],
    [8, 0],
    [0, 10],
  ]);
});
it('clamps resize and position to server limits', () => {
  const result = must(arrangeWidgets([{ ...widget('huge'), x: 20, y: 500, w: 30, h: 90 }]));
  expect(result[0]).toMatchObject({ x: 0, y: 400, w: 12, h: 40 });
});
it('returns failure rather than overlapping cards when the canvas is full', () => {
  const full = Array.from({ length: 11 }, (_, i) => ({
    ...widget(String(i), 0, i * 40),
    w: 12,
    h: 40,
  }));
  expect(addWidget(full, widget('new'))).toBeNull();
  expect(arrangeWidgets([...full, { ...widget('another'), w: 12, h: 40 }])).toBeNull();
});

it('packs six two-column count tiles across one row', () => {
  const counts = Array.from({ length: 6 }, (_, i) => ({
    ...widget(String(i)),
    w: 2,
    h: 2,
    config: {
      type: 'query' as const,
      title: String(i),
      query: '',
      limit: 12,
      display: 'count' as const,
    },
  }));
  const arranged = must(arrangeWidgets(counts));
  expect(arranged.every((item) => item.w === 2 && item.h === 2)).toBe(true);
  let packed: Widget[] = [];
  for (const item of counts) packed = must(addWidget(packed, item));
  expect(packed.map((item) => item.x)).toEqual([0, 2, 4, 6, 8, 10]);
  expect(packed.every((item) => item.y === 0)).toBe(true);
});
it('compacts hidden widgets without changing their saved arrangement', () => {
  const saved = [{ ...widget('empty'), w: 12 }, widget('visible', 0, 10)];
  const view = visibleWidgetLayout(saved, new Set(['empty']));
  expect(view.map((item) => [item.id, item.y])).toEqual([['visible', 0]]);
  expect(saved.map((item) => item.y)).toEqual([0, 10]);
  expect(visibleWidgetLayout(saved, new Set())).toBe(saved);
});

it('counts what a tab holds by kind, rather than calling a live query a radar', () => {
  const radar = (id: string): Widget => ({ ...widget(id), radarId: id, config: {} });
  const query = widget;
  const tab = (widgets: Widget[]) => ({ widgets }) as Pick<DashboardDto, 'widgets'>;
  expect(tabContents(tab([radar('a'), query('b')]))).toBe('1 radar and 1 live query');
  expect(tabContents(tab([radar('a'), radar('b')]))).toBe('2 radars');
  expect(tabContents(tab([query('a'), query('b')]))).toBe('2 live queries');
  expect(tabContents(tab([]))).toBe('nothing yet');
});
