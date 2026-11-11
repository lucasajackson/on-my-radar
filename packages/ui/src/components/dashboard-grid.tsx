import { Select } from './select';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, GripVertical, X } from 'lucide-react';
import { arrangeWidgets, widgetMinimum, visibleWidgetLayout } from '../lib/dashboard';
import { Modal, notify } from './primitives';
import type { DashboardDto } from '@onmyradar/contract';
import { focusWhenPresent } from '../lib/focus';

export type GridItem = DashboardDto['widgets'][number];

const COLUMNS = 12;
const ROW_HEIGHT = 38;
const GAP = 14;

interface DragState {
  id: string;
  mode: 'move' | 'resize';
  pointerId: number;
  originX: number;
  originY: number;
  startItem: GridItem;
}

export function DashboardGrid({
  items,
  onChange,
  onRemove,
  renderItem,
  editable,
  busy = false,
  hiddenIds = new Set(),
  onRevealHidden,
}: {
  hiddenIds?: Set<string>;
  onRevealHidden?: () => void;
  items: GridItem[];
  onChange: (next: GridItem[]) => void;
  onRemove: (id: string) => void;
  renderItem: (item: GridItem) => ReactNode;
  editable: boolean;
  /**
   * A layout save is in flight. The controls stay mounted and inert rather
   * than disappearing: unmounting them while saving destroyed the button that
   * had focus, so every arrange and remove dropped focus onto the body.
   * `aria-disabled` rather than `disabled`, because a disabled button loses
   * focus as well.
   */
  busy?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [arranging, setArranging] = useState<GridItem | null>(null);
  const moved = useRef(false);
  // Removing a widget hands focus to the next one, or back to "Add widget".
  const removeAndRefocus = (id: string) => {
    const order = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
    const at = order.findIndex((item) => item.id === id);
    const neighbour = order[at + 1] ?? order[at - 1];
    onRemove(id);
    focusWhenPresent([
      ...(neighbour ? [`[data-widget-id="${neighbour.id}"] [aria-label="Arrange widget"]`] : []),
      '[data-omr="add-widget"]',
    ]);
  };
  const [preview, setPreview] = useState<GridItem[] | null>(null);
  const [stacked, setStacked] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < 900,
  );

  useEffect(() => {
    const query = window.matchMedia('(max-width: 899px)');
    const update = () => setStacked(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const live = preview ?? items;
  const visible = visibleWidgetLayout(live, hiddenIds);
  const viewById = new Map(visible.map((item) => [item.id, item]));
  const columnWidth = (container.current?.clientWidth ?? 1200) / COLUMNS;

  const beginDrag = useCallback(
    (event: React.PointerEvent, item: GridItem, mode: 'move' | 'resize') => {
      if (!editable || busy || stacked) return;
      if (hiddenIds.size) {
        onRevealHidden?.();
        return;
      }
      moved.current = false;
      event.preventDefault();
      (event.target as HTMLElement).setPointerCapture(event.pointerId);
      setDrag({
        id: item.id,
        mode,
        pointerId: event.pointerId,
        originX: event.clientX,
        originY: event.clientY,
        startItem: item,
      });
    },
    [editable, busy, stacked, hiddenIds.size, onRevealHidden],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const deltaColumns = Math.round((event.clientX - drag.originX) / (columnWidth || 1));
      const deltaRows = Math.round((event.clientY - drag.originY) / (ROW_HEIGHT + GAP));

      if (!preview && deltaColumns === 0 && deltaRows === 0) return;
      setPreview(
        items.map((item) => {
          if (item.id !== drag.id) return item;
          const start = drag.startItem;
          if (drag.mode === 'move') {
            return {
              ...item,
              x: clamp(start.x + deltaColumns, 0, COLUMNS - start.w),
              y: Math.max(0, start.y + deltaRows),
            };
          }
          return {
            ...item,
            w: clamp(start.w + deltaColumns, widgetMinimum(start).w, COLUMNS - start.x),
            h: Math.max(widgetMinimum(start).h, start.h + deltaRows),
          };
        }),
      );
    },
    [columnWidth, drag, items, preview],
  );

  const endDrag = useCallback(() => {
    if (drag && preview) {
      moved.current = true;
      const next = arrangeWidgets(preview, drag.id);
      if (next) onChange(next);
      else notify('There is no room for that arrangement.', 'error');
    }
    setDrag(null);
    setPreview(null);
  }, [drag, onChange, preview]);

  const rows = visible.reduce((max, item) => Math.max(max, item.y + item.h), 2);

  const arrangeDialog = arranging ? (
    <ArrangeWidget
      key={arranging.id}
      widget={arranging}
      onClose={() => setArranging(null)}
      onSave={(widget) => {
        const next = arrangeWidgets(
          items.map((item) => (item.id === widget.id ? widget : item)),
          widget.id,
        );
        if (next) {
          onChange(next);
          setArranging(null);
          focusWhenPresent([`[data-widget-id="${widget.id}"] [aria-label="Arrange widget"]`]);
        } else notify('There is no room for that arrangement.', 'error');
      }}
    />
  ) : null;

  if (stacked) {
    return (
      <div className="dashboard-mobile-grid">
        {arrangeDialog}
        {[...items]
          .sort((a, b) => a.y - b.y || a.x - b.x)
          .map((item) => (
            <div
              key={item.id}
              data-widget-id={item.id}
              className={`panel dashboard-mobile-widget relative overflow-hidden ${widgetMinimum(item).h === 2 ? 'is-count' : ''}`}
              style={{
                height: widgetMinimum(item).h === 2 ? 130 : undefined,
                display: hiddenIds.has(item.id) ? 'none' : undefined,
              }}
            >
              {editable ? (
                <button
                  className="btn btn-ghost absolute top-1 left-1 z-10 p-2"
                  aria-label="Arrange widget"
                  aria-disabled={busy}
                  onClick={() => {
                    if (!busy) setArranging(item);
                  }}
                >
                  <GripVertical className="h-4 w-4" />
                </button>
              ) : null}
              {editable ? (
                <button
                  className="btn btn-ghost absolute top-1 right-1 z-10 p-2"
                  aria-label="Remove from this tab"
                  aria-disabled={busy}
                  onClick={() => {
                    if (!busy) removeAndRefocus(item.id);
                  }}
                >
                  <X className="h-4 w-4" />
                </button>
              ) : null}
              {renderItem(item)}
            </div>
          ))}
      </div>
    );
  }

  return (
    <div
      ref={container}
      className="relative"
      style={{ height: rows * (ROW_HEIGHT + GAP) }}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={() => {
        setDrag(null);
        setPreview(null);
      }}
    >
      {arrangeDialog}
      {live.map((item) => {
        const dragging = drag?.id === item.id;
        const position = viewById.get(item.id) ?? item;
        return (
          <div
            key={item.id}
            data-widget-id={item.id}
            className={`panel absolute overflow-hidden ${dragging ? 'widget-dragging' : ''}`}
            style={{
              display: hiddenIds.has(item.id) ? 'none' : undefined,
              left: `${(position.x / COLUMNS) * 100}%`,
              width: `calc(${(item.w / COLUMNS) * 100}% - ${GAP}px)`,
              top: position.y * (ROW_HEIGHT + GAP),
              height: item.h * (ROW_HEIGHT + GAP) - GAP,
              transition: dragging ? 'none' : 'left 140ms ease, top 140ms ease',
            }}
          >
            {editable ? (
              <>
                <button
                  className="widget-handle absolute top-1.5 left-1.5 z-10 rounded p-1 text-[color:var(--paper-faint)] hover:text-[color:var(--paper)]"
                  aria-label="Arrange widget"
                  aria-disabled={busy}
                  title="Drag to move, or click for position and size"
                  onClick={() => {
                    if (busy) return;
                    if (moved.current) {
                      moved.current = false;
                      return;
                    }
                    onRevealHidden?.();
                    setArranging(item);
                  }}
                  onPointerDown={(event) => beginDrag(event, item, 'move')}
                >
                  <GripVertical className="h-3.5 w-3.5" />
                </button>
                <button
                  className="absolute top-1.5 right-1.5 z-10 rounded p-1 text-[color:var(--paper-faint)] hover:text-[color:var(--danger)]"
                  aria-label="Remove from this tab"
                  aria-disabled={busy}
                  onClick={() => {
                    if (!busy) removeAndRefocus(item.id);
                  }}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
                <span
                  className="widget-resize absolute right-0 bottom-0 z-10 h-4 w-4"
                  aria-hidden="true"
                  title="Drag to resize; position and size are also available under Arrange widget"
                  onPointerDown={(event) => beginDrag(event, item, 'resize')}
                  style={{
                    background:
                      'linear-gradient(135deg, transparent 50%, var(--line) 50%, var(--line) 62%, transparent 62%, transparent 74%, var(--line) 74%)',
                  }}
                />
              </>
            ) : null}
            <div className="h-full">{renderItem(item)}</div>
          </div>
        );
      })}
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function ArrangeWidget({
  widget,
  onClose,
  onSave,
}: {
  widget: GridItem;
  onClose: () => void;
  onSave: (widget: GridItem) => void;
}) {
  const [draft, setDraft] = useState(widget);
  return (
    <Modal
      title="Arrange widget"
      description="Choose its position and size. Other widgets move aside to make room."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-accent" onClick={() => onSave(draft)}>
            Apply layout
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex gap-2">
          <button
            className="btn flex-1"
            disabled={draft.y === 0}
            onClick={() =>
              setDraft((current) => ({ ...current, y: Math.max(0, current.y - current.h) }))
            }
          >
            <ArrowUp className="h-4 w-4" />
            Move up
          </button>
          <button
            className="btn flex-1"
            disabled={draft.y >= 400}
            onClick={() =>
              setDraft((current) => ({ ...current, y: Math.min(400, current.y + current.h) }))
            }
          >
            <ArrowDown className="h-4 w-4" />
            Move down
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="instrument">Column</span>
            <input
              className="field"
              type="number"
              min={1}
              max={13 - draft.w}
              value={draft.x + 1}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  x: Math.min(12 - current.w, Math.max(0, Number(event.target.value) - 1)),
                }))
              }
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="instrument">Row</span>
            <input
              className="field"
              type="number"
              min={1}
              max={401}
              value={draft.y + 1}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  y: Math.min(400, Math.max(0, Number(event.target.value) - 1)),
                }))
              }
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="instrument">Width</span>
            <Select
              className="field"
              value={String(draft.w)}
              onValueChange={(value) => {
                const w = Number(value);
                setDraft((current) => ({ ...current, w, x: Math.min(current.x, 12 - w) }));
              }}
              options={Array.from(new Set([widgetMinimum(draft).w, 3, 4, 6, 12, draft.w]))
                .sort((a, b) => a - b)
                .map((width) => ({ value: String(width), label: `${width} of 12 columns` }))}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="instrument">Height</span>
            <Select
              className="field"
              value={String(draft.h)}
              onValueChange={(value) => setDraft((current) => ({ ...current, h: Number(value) }))}
              options={Array.from(new Set([widgetMinimum(draft).h, 4, 6, 10, 14, 20, 40, draft.h]))
                .sort((a, b) => a - b)
                .map((height) => ({ value: String(height), label: `${height} rows` }))}
            />
          </label>
        </div>
        <p className="note">
          Phones stack widgets in row order. Columns and width apply on larger screens.
        </p>
      </div>
    </Modal>
  );
}
