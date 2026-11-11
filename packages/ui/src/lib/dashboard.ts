import type { DashboardDto, WidgetLayout } from '@onmyradar/contract';

/** Preserve identity and query config when only a widget's geometry changes. */
export function widgetLayout(widgets: DashboardDto['widgets']): WidgetLayout[] {
  return widgets.map(({ id, radarId, x, y, w, h, config }) => ({
    ...(id.startsWith('new-') ? {} : { id }),
    radarId,
    x,
    y,
    w,
    h,
    config,
  }));
}

type Widget = DashboardDto['widgets'][number];
const overlaps = (left: Widget, right: Widget) =>
  left.x < right.x + right.w &&
  left.x + left.w > right.x &&
  left.y < right.y + right.h &&
  left.y + left.h > right.y;

/** Resolve collisions without changing widget identity/config. The edited card keeps its position. */
export function arrangeWidgets(widgets: Widget[], preferredId?: string): Widget[] | null {
  const ordered = [...widgets].sort((a, b) =>
    a.id === preferredId ? -1 : b.id === preferredId ? 1 : a.y - b.y || a.x - b.x,
  );
  const placed: Widget[] = [];
  for (const original of ordered) {
    const widget = {
      ...original,
      w: Math.min(12, Math.max(widgetMinimum(original).w, original.w)),
      h: Math.min(40, Math.max(widgetMinimum(original).h, original.h)),
    };
    widget.x = Math.min(12 - widget.w, Math.max(0, widget.x));
    widget.y = Math.min(400, Math.max(0, widget.y));
    if (placed.some((item) => overlaps(item, widget))) {
      let position: { x: number; y: number } | null = null;
      // Prefer moving down in the same column before relocating across the canvas.
      for (let y = widget.y; y <= 400 && !position; y += 1) {
        if (!placed.some((item) => overlaps(item, { ...widget, y }))) position = { x: widget.x, y };
      }
      for (let y = 0; y <= 400 && !position; y += 1) {
        for (let x = 0; x <= 12 - widget.w; x += 1) {
          if (!placed.some((item) => overlaps(item, { ...widget, x, y }))) {
            position = { x, y };
            break;
          }
        }
      }
      if (!position) return null;
      Object.assign(widget, position);
    }
    placed.push(widget);
  }
  const positions = new Map(placed.map((item) => [item.id, item]));
  // Every widget was placed above; one that somehow was not keeps its own position.
  return widgets.map((item) => positions.get(item.id) ?? item);
}

/** A new card occupies the first available space rather than endlessly extending one column. */
export function addWidget(widgets: Widget[], widget: Widget): Widget[] | null {
  for (let y = 0; y <= 400; y += 1)
    for (let x = 0; x <= 12 - widget.w; x += 1) {
      const candidate = { ...widget, x, y };
      if (!widgets.some((item) => overlaps(item, candidate))) return [...widgets, candidate];
    }
  return null;
}

export function widgetMinimum(widget: Widget): { w: number; h: number } {
  return widget.config.type === 'query' && widget.config.display === 'count'
    ? { w: 2, h: 2 }
    : { w: 3, h: 4 };
}

/** Compact visible cards for display only; saved placement stays intact. */
export function visibleWidgetLayout(widgets: Widget[], hiddenIds: Set<string>): Widget[] {
  if (!hiddenIds.size) return widgets;
  let placed: Widget[] = [];
  for (const widget of [...widgets].sort((a, b) => a.y - b.y || a.x - b.x)) {
    if (hiddenIds.has(widget.id)) continue;
    placed = addWidget(placed, widget) ?? [...placed, widget];
  }
  return placed;
}

/** "1 radar and 1 live query" — what a tab holds, counted by kind. */
export function tabContents(dashboard: Pick<DashboardDto, 'widgets'>): string {
  const queries = dashboard.widgets.filter((widget) => widget.config.type === 'query').length;
  const radars = dashboard.widgets.length - queries;
  const parts = [
    radars ? `${radars} ${radars === 1 ? 'radar' : 'radars'}` : null,
    queries ? `${queries} live ${queries === 1 ? 'query' : 'queries'}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(' and ') : 'nothing yet';
}
