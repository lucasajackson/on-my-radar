/**
 * The architecture radar's Map and Matrix.
 *
 * From 820px the map (`layoutMap`) is drawn in a box that fits it, with zoom,
 * drag and wheel inside the box, and the selected element's detail sits beside
 * it (from 1024px) or directly beneath it (820 to 1023px) - never a screen away.
 * The matrix is a table in the card. Below 820px neither can be read (the map
 * would be 0.2x, the matrix 24 by 40), so there the Map tab is a list of
 * boundaries that open onto their seams, with the drawing one tap away in a
 * full-screen pinch-zoom view, and the Matrix tab shows one boundary at a time.
 */
import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, Minus, Plus, ScanLine } from 'lucide-react';
import {
  layoutMap,
  seamLabel,
  type ArchitectureAdrDto,
  type ArchitectureDto,
  type MapLayout,
} from '@onmyradar/contract';
import { Select } from '../components/select';
import type { PanelSlot } from '../components/side-panel';
import { DESKTOP_QUERY, useMediaQuery } from '../lib/viewport';
import { EmptyTab } from './architecture-forms';
import { LinkedSections } from './architecture-links';

type Data = ArchitectureDto;
interface Handlers {
  onFocus: (id: string | null) => void;
  onAdr: (id: string) => void;
  /** Present for a reader who may write: change or remove the element in the detail. */
  onEdit?: ((id: string) => void) | undefined;
  onRemove?: ((id: string) => void) | undefined;
}

/** What the map is for, and the one way to start it. */
function NoBoundaries({
  canWrite,
  adding,
  onAdd,
  children,
  title,
}: {
  canWrite: boolean;
  adding: boolean;
  onAdd: () => void;
  children: string;
  title: string;
}) {
  return (
    <EmptyTab
      title={title}
      action={
        canWrite && !adding ? (
          <button type="button" className="btn btn-accent" onClick={onAdd}>
            Add boundary
          </button>
        ) : null
      }
    >
      {children}
    </EmptyTab>
  );
}

/** Red when an accepted ADR amends it, amber when only a proposed one does. */
const markOf = (amendedBy: readonly string[], adrs: readonly ArchitectureAdrDto[]) => {
  const lanes = amendedBy.map((id) => adrs.find((a) => a.id === id)?.lane);
  return lanes.includes('accepted') ? 'accepted' : lanes.includes('proposed') ? 'proposed' : null;
};

const between = (data: Data, x: string, y: string) =>
  data.contracts.filter((c) => (c.a === x && c.b === y) || (c.a === y && c.b === x));

/** What a boundary owns, its seams and the ADRs that amend it; or a contract's two sides. */
function Detail({
  id,
  data,
  onFocus,
  onAdr,
  onEdit,
  onRemove,
}: { id: string | null } & Handlers & { data: Data }) {
  const boundary = data.boundaries.find((b) => b.id === id);
  const contract = data.contracts.find((c) => c.id === id);
  const title = (of: string) => data.boundaries.find((b) => b.id === of)?.title ?? '';
  const seams = boundary
    ? data.contracts.filter((c) => c.a === boundary.id || c.b === boundary.id)
    : [];
  const adrs = (ids: readonly string[]) => (
    <ul className="arch-links" aria-label="Amended by">
      {ids.length === 0 ? <li className="note">No ADR amends this.</li> : null}
      {ids.map((adr) => {
        const found = data.adrs.find((a) => a.id === adr);
        return found ? (
          <li key={adr}>
            <button type="button" className="btn btn-ghost" onClick={() => onAdr(adr)}>
              {found.label} <span className="instrument">{found.lane}</span>
            </button>
          </li>
        ) : null;
      })}
    </ul>
  );
  const actions = (of: string) =>
    onEdit || onRemove ? (
      <div className="arch-detail-actions">
        {onEdit ? (
          <button type="button" className="btn" onClick={() => onEdit(of)}>
            Edit
          </button>
        ) : null}
        {onRemove ? (
          <button type="button" className="btn btn-ghost" onClick={() => onRemove(of)}>
            Remove
          </button>
        ) : null}
      </div>
    ) : null;
  if (boundary)
    return (
      <div className="arch-detail">
        <span className="instrument">{boundary.external ? 'External system' : 'Boundary'}</span>
        <h3>{boundary.title}</h3>
        {actions(boundary.id)}
        <h4 className="instrument">Owns</h4>
        <ul className="arch-owns" aria-label="Owns">
          {(boundary.owns ?? []).length === 0 ? <li className="note">Nothing recorded.</li> : null}
          {(boundary.owns ?? []).map((item) => (
            <li key={item}>
              <code>{item}</code>
            </li>
          ))}
        </ul>
        <h4 className="instrument">Seams</h4>
        <ul className="arch-links" aria-label="Seams">
          {seams.length === 0 ? <li className="note">No contract touches this boundary.</li> : null}
          {seams.map((c) => (
            <li key={c.id}>
              <button type="button" className="btn btn-ghost" onClick={() => onFocus(c.id)}>
                {seamLabel(c)} {c.version ? `v${c.version}` : ''} →{' '}
                {title(c.a === boundary.id ? c.b : c.a)}
              </button>
            </li>
          ))}
        </ul>
        <h4 className="instrument">Amended by</h4>
        {adrs(boundary.amendedBy)}
        <LinkedSections data={data} id={boundary.id} />
      </div>
    );
  if (contract)
    return (
      <div className="arch-detail">
        <span className="instrument">
          Contract{contract.version ? ` · v${contract.version}` : ''}
        </span>
        <h3>{contract.title}</h3>
        {actions(contract.id)}
        <h4 className="instrument">Between</h4>
        <ul className="arch-links">
          {[contract.a, contract.b].map((end) => (
            <li key={end}>
              <button type="button" className="btn btn-ghost" onClick={() => onFocus(end)}>
                {title(end)}
              </button>
            </li>
          ))}
        </ul>
        <h4 className="instrument">Amended by</h4>
        {adrs(contract.amendedBy)}
        <LinkedSections data={data} id={contract.id} />
      </div>
    );
  return <p className="note">Pick a boundary or a seam to see what it owns and what amends it.</p>;
}

/**
 * A box's title as up to two lines, broken at spaces (or mid-word when a word will not fit),
 * with an ellipsis only when two lines still are not enough.
 */
export function wrapLabel(title: string, chars: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of title.split(/\s+/).filter(Boolean)) {
    let rest = word;
    while (rest.length > chars) {
      if (line) {
        lines.push(line);
        line = '';
      }
      lines.push(rest.slice(0, chars));
      rest = rest.slice(chars);
    }
    if (!line) line = rest;
    else if (line.length + 1 + rest.length <= chars) line = `${line} ${rest}`;
    else {
      lines.push(line);
      line = rest;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= 2) return lines;
  const last = (lines[1] ?? '').slice(0, Math.max(1, chars - 1));
  return [lines[0] ?? '', `${last}…`];
}

/** The drawing. `focus` dims everything except that element and what it touches. */
function Drawing({
  data,
  map,
  viewBox,
  focus,
  onFocus,
}: { data: Data; map: MapLayout; viewBox: string; focus: string | null } & Pick<
  Handlers,
  'onFocus'
>) {
  const lit = new Set<string>();
  if (focus) {
    lit.add(focus);
    for (const c of data.contracts)
      if (c.id === focus || c.a === focus || c.b === focus) lit.add(c.id).add(c.a).add(c.b);
  }
  const dim = (id: string) => (focus && !lit.has(id) ? ' is-dim' : '');
  // What the focused element touches stays at full strength and takes the accent.
  const near = (id: string) => (focus && id !== focus && lit.has(id) ? ' is-lit' : '');
  const press = (id: string) => ({
    tabIndex: 0,
    role: 'button',
    onClick: (event: React.MouseEvent) => {
      event.stopPropagation();
      onFocus(id);
    },
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onFocus(id);
      }
    },
  });
  return (
    <svg
      className="arch-map-svg"
      viewBox={viewBox}
      role="group"
      aria-label="Boundary and contract map"
      onClick={() => onFocus(null)}
    >
      <rect
        className="map-frame"
        x={map.frame.x}
        y={map.frame.y}
        width={map.frame.w}
        height={map.frame.h}
        rx={14}
      />
      <text className="map-frame-label" x={map.frame.x + 16} y={map.frame.y + 22}>
        {data.radar.name.toUpperCase()}
      </text>
      {map.seams.map((s) => (
        <line
          key={s.id}
          className={`map-edge${dim(s.id)}${near(s.id)}`}
          x1={s.x1}
          y1={s.y1}
          x2={s.x2}
          y2={s.y2}
        />
      ))}
      {map.boxes.map((b) => {
        const el = data.boundaries.find((x) => x.id === b.id);
        const mark = el ? markOf(el.amendedBy, data.adrs) : null;
        const lines = wrapLabel(el?.title ?? '', Math.floor((b.w - 20) / 6.6));
        return (
          <g
            key={b.id}
            className={`map-node${b.external ? ' is-external' : ''}${dim(b.id)}${near(b.id)}${focus === b.id ? ' is-selected' : ''}`}
            aria-label={el?.title}
            {...press(b.id)}
          >
            <title>{el?.title}</title>
            <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={8} />
            <text x={b.x + 10} y={b.y + b.h / 2 + (lines.length > 1 ? -2 : 4)}>
              {lines.map((line, i) => (
                <tspan key={i} x={b.x + 10} dy={i === 0 ? 0 : 14}>
                  {line}
                </tspan>
              ))}
            </text>
            {mark ? (
              <circle className={`map-badge is-${mark}`} cx={b.x + b.w - 8} cy={b.y + 8} r={6} />
            ) : null}
          </g>
        );
      })}
      {map.seams.map((s) => {
        const c = data.contracts.find((x) => x.id === s.id);
        const mark = c ? markOf(c.amendedBy, data.adrs) : null;
        return (
          <g
            key={s.id}
            className={`map-seam${mark ? ` is-${mark}` : ''}${dim(s.id)}${near(s.id)}`}
            aria-label={`Contract ${c?.title ?? ''}`}
            {...press(s.id)}
          >
            <title>{c?.title}</title>
            <rect x={s.pill.x} y={s.pill.y} width={s.pill.w} height={s.pill.h} rx={9} />
            <text x={s.pill.x + s.pill.w / 2} y={s.pill.y + 13} textAnchor="middle">
              {s.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

interface Camera {
  /** Pixels per map unit. */
  k: number;
  /** The map point at the middle of the box. */
  cx: number;
  cy: number;
}
interface Point {
  x: number;
  y: number;
}
/** How far in or out from "fits the box" a reader can go. */
/** The most a fitted map is drawn at. */
const MAX_FIT = 1.25;
const OUT = 0.5;
const IN = 10;
/** A press that moves less than this is a click on a box, not the start of a drag. */
const DRAG_PX = 4;

/** How much of the box, along each axis, the drawing must keep covering however it is panned. */
const KEEP = 0.4;

/**
 * Keep the drawing in reach: `camera` moved so the drawing (0..width by 0..height in its own
 * units) still covers at least KEEP of the box along each axis (or all of itself, when it is
 * smaller than that on screen). Wheel, drag and pinch all go through here, so a few hard ticks can
 * never carry the drawing out of the box, and Fit always has something to come back to.
 */
export function keepInReach(
  camera: Camera,
  box: { w: number; h: number },
  width: number,
  height: number,
): Camera {
  const along = (centre: number, size: number, extent: number) => {
    const half = size / camera.k / 2;
    const need = Math.min((KEEP * size) / camera.k, extent);
    // The window [centre - half, centre + half] overlaps [0, extent] by at least `need`.
    return Math.min(extent - need + half, Math.max(need - half, centre));
  };
  return { ...camera, cx: along(camera.cx, box.w, width), cy: along(camera.cy, box.h, height) };
}

/**
 * The drawing in a box that fits it. The box's own size sets the viewBox, so the
 * picture scales to the box rather than the box scrolling; zoom, drag and wheel
 * (or two fingers) move the camera and Fit puts it back. `data-zoom` is the zoom
 * relative to that fit, 1 when fitted.
 */
function PanZoom({
  width,
  height,
  onBox,
  children,
}: {
  width: number;
  height: number;
  /** The box's size, whenever it has one or it changes. */
  onBox: (w: number, h: number) => void;
  children: (viewBox: string) => React.ReactNode;
}) {
  const pane = useRef<HTMLDivElement>(null);
  // Below 1024 the page scrolls under a finger; only above it is the wheel the map's.
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const desktopNow = useRef(desktop);
  desktopNow.current = desktop;
  const [size, setSize] = useState({ w: 0, h: 0 });
  // Null follows the box: refit whenever it is resized.
  const [camera, setCamera] = useState<Camera | null>(null);
  const touches = useRef(new Map<number, Point>());
  const press = useRef<{ at: Point; panning: boolean } | null>(null);
  const swallow = useRef(false);

  useLayoutEffect(() => {
    const node = pane.current;
    if (!node) return;
    const measure = () => {
      setSize({ w: node.clientWidth, h: node.clientHeight });
      if (node.clientWidth > 0 && node.clientHeight > 0) onBox(node.clientWidth, node.clientHeight);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const watcher = new ResizeObserver(measure);
    watcher.observe(node);
    return () => watcher.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A different layout (the box changed shape) is in different units: start from its fit.
  useEffect(() => setCamera(null), [width, height]);

  // A box with no size yet (first paint, jsdom) is drawn at the map's own size.
  const box = { w: size.w || width, h: size.h || height };
  // A small map is not blown up to fill a big box: past 1.25x it is boxes the size of buttons.
  const fit = Math.min(box.w / width, box.h / height, MAX_FIT) || 1;
  const now = { k: camera?.k ?? fit, cx: camera?.cx ?? width / 2, cy: camera?.cy ?? height / 2 };
  const latest = useRef({ ...now, box, fit });
  latest.current = { ...now, box, fit };

  // Written through at once: two events can land before React renders between them.
  const commit = (wanted: Camera) => {
    const next = keepInReach(wanted, latest.current.box, width, height);
    latest.current = { ...latest.current, ...next };
    setCamera(next);
  };
  /** Scale by `factor` keeping the map point under `from` under `to`. */
  const zoomAt = (factor: number, from: Point, to: Point = from) => {
    const { k, cx, cy, box: b, fit: f } = latest.current;
    const next = Math.min(f * IN, Math.max(f * OUT, k * factor));
    const mx = cx + (from.x - b.w / 2) / k;
    const my = cy + (from.y - b.h / 2) / k;
    commit({ k: next, cx: mx - (to.x - b.w / 2) / next, cy: my - (to.y - b.h / 2) / next });
  };
  const panBy = (dx: number, dy: number) => {
    const { k, cx, cy } = latest.current;
    commit({ k, cx: cx - dx / k, cy: cy - dy / k });
  };
  const zoomRef = useRef(zoomAt);
  zoomRef.current = zoomAt;
  const panRef = useRef(panBy);
  panRef.current = panBy;
  const middle = () => ({ x: latest.current.box.w / 2, y: latest.current.box.h / 2 });

  // React's onWheel is passive, so it could not keep the page from scrolling. A pinch on a
  // trackpad arrives as a wheel with ctrl held, and ⌘-scroll is the same ask: both zoom, on any
  // width. A plain wheel is the map's to pan only where the page does not scroll (1024 and up);
  // below that it is left alone, so a finger or wheel over the map still scrolls the page.
  useEffect(() => {
    const node = pane.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      const zooming = event.ctrlKey || event.metaKey;
      if (!zooming && !desktopNow.current) return;
      event.preventDefault();
      const lines = event.deltaMode === 1 ? 16 : 1;
      if (zooming) {
        const rect = node.getBoundingClientRect();
        zoomRef.current(Math.exp(-event.deltaY * lines * (event.ctrlKey ? 0.01 : 0.004)), {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        });
      } else {
        panRef.current(-event.deltaX * lines, -event.deltaY * lines);
      }
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, []);

  const move = (event: React.PointerEvent) => {
    const before = touches.current.get(event.pointerId);
    if (!before) return;
    // A mouse that came back with nothing held let go somewhere we did not hear about.
    if (event.pointerType === 'mouse' && event.buttons === 0) {
      drop(event);
      return;
    }
    const was = [...touches.current.values()];
    const at = { x: event.clientX, y: event.clientY };
    touches.current.set(event.pointerId, at);
    const rect = pane.current?.getBoundingClientRect();
    if (!rect) return;
    const local = (p: Point) => ({ x: p.x - rect.left, y: p.y - rect.top });
    const live = [...touches.current.values()];
    if (live.length === 2 && was.length === 2) {
      const [a, b] = live as [Point, Point];
      const [p, q] = was as [Point, Point];
      swallow.current = true;
      zoomAt(
        Math.hypot(a.x - b.x, a.y - b.y) / (Math.hypot(p.x - q.x, p.y - q.y) || 1),
        local({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }),
        local({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }),
      );
    } else if (live.length === 1 && press.current) {
      if (!press.current.panning) {
        if (Math.hypot(at.x - press.current.at.x, at.y - press.current.at.y) < DRAG_PX) return;
        press.current.panning = true;
        swallow.current = true;
        // Only now: capturing at pointerdown would send a box's click to the pane.
        try {
          pane.current?.setPointerCapture(event.pointerId);
        } catch {
          // A synthetic pointer has nothing to capture; the drag still works.
        }
      }
      panBy(at.x - before.x, at.y - before.y);
    }
  };
  const drop = (event: React.PointerEvent) => {
    touches.current.delete(event.pointerId);
    if (touches.current.size === 0) {
      press.current = null;
      // The click that ends a drag arrives after this; it must not select a box.
      setTimeout(() => {
        swallow.current = false;
      }, 0);
    }
  };
  const factor = 1.4;
  const viewW = box.w / now.k;
  const viewH = box.h / now.k;
  const viewBox = `${now.cx - viewW / 2} ${now.cy - viewH / 2} ${viewW} ${viewH}`;
  return (
    <div className="arch-mapbox">
      <div
        ref={pane}
        className="arch-pinch"
        data-zoom={(now.k / fit).toFixed(2)}
        data-extent={`${width}x${height}`}
        onPointerDown={(event) => {
          touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          if (touches.current.size === 1) {
            swallow.current = false;
            press.current = { at: { x: event.clientX, y: event.clientY }, panning: false };
          }
        }}
        onPointerMove={move}
        onPointerUp={drop}
        onPointerCancel={drop}
        onLostPointerCapture={(event) => {
          // Handing capture from the node a finger landed on to the pane (when a drag starts)
          // makes that node lose it, and the event bubbles here: that is not a release. Only the
          // pane itself losing it, for a pointer we are following, is.
          if (event.currentTarget !== event.target) return;
          if (!touches.current.has(event.pointerId)) return;
          drop(event);
        }}
        onPointerLeave={(event) => {
          if (event.buttons === 0) drop(event);
        }}
        onClickCapture={(event) => {
          if (swallow.current) {
            event.stopPropagation();
            event.preventDefault();
          }
        }}
      >
        {children(viewBox)}
      </div>
      {desktop && (
        <p className="arch-hint" data-testid="zoom-hint">
          Pinch or ⌘-scroll to zoom
        </p>
      )}
      <div className="arch-zoom" role="group" aria-label="Zoom">
        <button
          type="button"
          className="btn"
          aria-label="Zoom in"
          title="Zoom in"
          onClick={() => zoomAt(factor, middle())}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="btn"
          aria-label="Zoom out"
          title="Zoom out"
          onClick={() => zoomAt(1 / factor, middle())}
        >
          <Minus className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="btn"
          aria-label="Fit to box"
          title="Fit to box"
          onClick={() => setCamera(null)}
        >
          <ScanLine className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/** What the colours and shapes on the map mean. */
export function MapKey() {
  return (
    <ul className="arch-legend instrument" aria-label="Key">
      <li>
        <i className="arch-key" /> Boundary
      </li>
      <li>
        <i className="arch-key is-external" /> External
      </li>
      <li>
        <i className="arch-key is-seam" /> Contract
      </li>
      <li>
        <i className="map-badge is-accepted" /> Amended
      </li>
    </ul>
  );
}

const layouts = new WeakMap<Data, Map<number | null, MapLayout>>();
/** A layout by the data's identity and the box's shape: opening the full-screen map or coming back to the tab does not redo it. */
export function laidOut(data: Data, aspect: number | null): MapLayout {
  const known = layouts.get(data) ?? new Map<number | null, MapLayout>();
  layouts.set(data, known);
  const hit = known.get(aspect);
  if (hit) return hit;
  const made = layoutMap(data.boundaries, data.contracts, aspect === null ? {} : { aspect });
  known.set(aspect, made);
  return made;
}

/**
 * The drawing in its fitted box: what both the side-by-side map and the full-screen one show.
 * The layout is asked for the box's own shape, so the drawing fills it instead of leaving bands of
 * nothing above and below; a box that changes shape (a window resize) is laid out again, in steps
 * of a tenth so a drag of the window is not a layout per pixel.
 */
function MapStage({
  data,
  focus,
  onFocus,
}: { data: Data; focus: string | null } & Pick<Handlers, 'onFocus'>) {
  const [measured, setAspect] = useState<number | null>(null);
  // Laying out is the one slow thing here, so a resize paints the box first and the new drawing
  // when it is ready; a window dragged through twenty shapes is not twenty layouts in the way of
  // the pointer.
  const aspect = useDeferredValue(measured);
  const map = useMemo(() => laidOut(data, aspect), [data, aspect]);
  return (
    <PanZoom
      width={map.width}
      height={map.height}
      onBox={(w, h) => setAspect(Math.max(0.3, Math.round((w / h) * 10) / 10))}
    >
      {(viewBox) => (
        <Drawing data={data} map={map} viewBox={viewBox} focus={focus} onFocus={onFocus} />
      )}
    </PanZoom>
  );
}

/** The drawing full screen, for a phone: pinch it, tap a box, read it underneath. */
function MapOverlay({
  data,
  focus,
  onFocus,
  onAdr,
  onClose,
}: Handlers & { data: Data; focus: string | null; onClose: () => void }) {
  return (
    <div className="arch-overlay" role="dialog" aria-modal="true" aria-label="Map">
      <div className="arch-overlay-bar">
        <button type="button" className="btn" onClick={onClose}>
          Close map
        </button>
      </div>
      <MapStage data={data} focus={focus} onFocus={onFocus} />
      {focus ? (
        <div className="arch-overlay-detail">
          <Detail id={focus} data={data} onFocus={onFocus} onAdr={onAdr} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Where the open panel sits when it is a column of the card. The panel itself is drawn once, by the
 * radar; this only leaves room for it (and nothing at all when it is a sheet over the page).
 */
function PanelPlace({ panel }: { panel: PanelSlot }) {
  return panel.show ? <div ref={panel.ref} className="side-panel-slot" /> : null;
}

/** Where the map's forms and its empty states sit. */
interface Writing {
  /** The open boundary or contract panel: where it sits when it is a column of the card. */
  form: PanelSlot;
  canWrite: boolean;
  onAdd: () => void;
}

export function MapTab({
  data,
  focus,
  wide,
  form,
  canWrite,
  onAdd,
  onFocus,
  onAdr,
  onEdit,
  onRemove,
}: Handlers & Writing & { data: Data; focus: string | null; wide: boolean }) {
  const [open, setOpen] = useState(false);
  const [lastOpen, setLastOpen] = useState<string | null>(null);
  const detail = { onFocus, onAdr, onEdit, onRemove };
  if (data.boundaries.length === 0)
    return (
      <div className="arch-seams">
        <NoBoundaries
          title="No boundaries yet"
          canWrite={canWrite}
          adding={form.open}
          onAdd={onAdd}
        >
          {canWrite
            ? 'The map shows the parts of the application (boundaries) and the contracts between them. Start with the boundaries: what each one is, and what it owns. A contract then joins two of them.'
            : 'The map shows the parts of the application (boundaries) and the contracts between them. Nobody has drawn it yet.'}
        </NoBoundaries>
        <PanelPlace panel={form} />
      </div>
    );
  const overlay = open ? (
    <MapOverlay
      data={data}
      focus={focus}
      onFocus={onFocus}
      onAdr={onAdr}
      onClose={() => setOpen(false)}
    />
  ) : null;
  // Quiet on purpose: the list is the phone's map, and this is the way to the drawing.
  const openButton = (
    <button type="button" className="btn arch-open-map" onClick={() => setOpen(true)}>
      <Maximize2 className="h-4 w-4" aria-hidden="true" />
      Open map
    </button>
  );
  if (wide)
    return (
      <div className="arch-mapgrid">
        <MapStage data={data} focus={focus} onFocus={onFocus} />
        <aside className="arch-focus" aria-label="Focus" aria-live="polite">
          {form.show ? <PanelPlace panel={form} /> : <Detail id={focus} data={data} {...detail} />}
        </aside>
      </div>
    );
  const contract = data.contracts.find((c) => c.id === focus);
  const known = (id: string | null) => data.boundaries.some((b) => b.id === id);
  // A seam opens inside the row it was tapped in; failing that, under its first side.
  const openId = known(focus)
    ? focus
    : contract
      ? contract.a === lastOpen || contract.b === lastOpen
        ? lastOpen
        : contract.a
      : null;
  const pick = (id: string | null) => {
    if (known(id)) setLastOpen(id);
    onFocus(id);
  };
  return (
    <div className="arch-seams">
      {openButton}
      {data.boundaries.map((b) => {
        const mark = markOf(b.amendedBy, data.adrs);
        const shown = openId === b.id;
        return (
          <div key={b.id} className="arch-seam-row">
            <button
              type="button"
              className="arch-seam-head"
              aria-expanded={shown}
              onClick={() => (shown ? onFocus(null) : pick(b.id))}
            >
              <span>{b.title}</span>
              <span className="instrument">
                {b.external ? 'external · ' : ''}
                {(b.owns ?? []).length} owned
                {mark ? (
                  <i className={`map-badge is-${mark}`} aria-label={`amended: ${mark}`} />
                ) : null}
              </span>
            </button>
            {shown ? (
              <Detail id={contract?.id ?? b.id} data={data} {...detail} onFocus={pick} />
            ) : null}
          </div>
        );
      })}
      {overlay}
    </div>
  );
}

/** What opens a contract's panel in the matrix: an existing one, or a new one between two boundaries. */
type OpenContract = (form: {
  kind: 'contract';
  id: string | null;
  ends?: { a: string; b: string };
}) => void;

export function MatrixTab({
  data,
  focus,
  wide,
  panel,
  openContract,
  canWrite,
  onAdd,
  onFocus,
  onAdr,
  onEdit,
  onRemove,
}: Handlers &
  Omit<Writing, 'form'> & {
    data: Data;
    focus: string | null;
    wide: boolean;
    /** The open contract panel: a column beside the grid from 1024px, a sheet below. */
    panel: PanelSlot;
    /** Present for a reader who may write: a cell opens its contract here. */
    openContract?: OpenContract | undefined;
  }) {
  const [sel, setSel] = useState<string | null>(null);
  const contract = data.contracts.find((c) => c.id === focus);
  const ours = data.boundaries.filter((b) => !b.external);
  const all = [...ours, ...data.boundaries.filter((b) => b.external)];
  /** A cell's contracts: the version, as the grid shows it, and the title for a reader's tooltip. */
  const names = (x: string, y: string) =>
    between(data, x, y).map((c) => (
      <button
        key={c.id}
        type="button"
        className={`arch-cell-link ${c.id === focus ? 'is-selected' : ''}`}
        title={c.title}
        aria-label={`${c.title}${c.version ? `, version ${c.version}` : ''}`}
        onClick={() =>
          openContract ? openContract({ kind: 'contract', id: c.id }) : onFocus(c.id)
        }
      >
        {c.version ? `v${c.version}` : seamLabel(c)}
      </button>
    ));
  if (data.boundaries.length === 0)
    return (
      <div className="arch-seams">
        <NoBoundaries
          title="Nothing to compare yet"
          canWrite={canWrite}
          adding={false}
          onAdd={onAdd}
        >
          {canWrite
            ? 'The matrix lays the boundaries out against each other and shows which pairs share a contract. Add the boundaries first, on the Map.'
            : 'The matrix lays the boundaries out against each other and shows which pairs share a contract. There are none to compare yet.'}
        </NoBoundaries>
      </div>
    );
  if (!wide) {
    const one =
      data.boundaries.find((b) => b.id === sel) ??
      data.boundaries.find((b) => b.id === focus) ??
      data.boundaries[0];
    const pick = (id: string | null) => {
      if (data.boundaries.some((b) => b.id === id)) setSel(id);
      onFocus(id);
    };
    return (
      <div className="arch-matrix-one">
        <span className="instrument">Boundary</span>
        <Select
          aria-label="Boundary"
          value={one?.id ?? ''}
          onValueChange={pick}
          options={data.boundaries.map((b) => ({ value: b.id, label: b.title }))}
        />
        <ul className="arch-links">
          {data.boundaries
            .filter((b) => b.id !== one?.id)
            .filter((b) => !(b.external && one?.external))
            .map((b) => (
              <li key={b.id}>
                <span>{b.title}</span>
                {one && between(data, one.id, b.id).length > 0 ? (
                  names(one.id, b.id)
                ) : openContract && one ? (
                  <button
                    type="button"
                    className="arch-cell-link"
                    onClick={() =>
                      openContract({ kind: 'contract', id: null, ends: { a: one.id, b: b.id } })
                    }
                  >
                    + Add a contract
                  </button>
                ) : (
                  <span className="note">no seam</span>
                )}
              </li>
            ))}
        </ul>
        {contract && !openContract ? (
          <Detail
            id={contract.id}
            data={data}
            onFocus={pick}
            onAdr={onAdr}
            onEdit={onEdit}
            onRemove={onRemove}
          />
        ) : null}
      </div>
    );
  }
  // The pair a new contract in the open panel is between, so its cell reads as the open one.
  const open = new Set(
    contract ? [`${contract.a}|${contract.b}`, `${contract.b}|${contract.a}`] : [],
  );
  return (
    <div className="arch-matrixgrid">
      <div className="arch-matrix-scroll">
        <table className="arch-matrix">
          <caption className="sr-only">
            Boundaries against boundaries: a cell holds the contract between the pair.
          </caption>
          <thead>
            <tr>
              <th scope="col">
                <span className="arch-matrix-corner">
                  {openContract ? (
                    'Click a cell to edit its contract'
                  ) : (
                    <span className="sr-only">Boundary</span>
                  )}
                </span>
              </th>
              {all.map((c) => (
                <th key={c.id} scope="col" className={c.external ? 'is-external' : ''}>
                  <span className="arch-matrix-name is-column" title={c.title}>
                    {c.title}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {all.map((r) => (
              <tr key={r.id}>
                <th scope="row" className={r.external ? 'is-external' : ''}>
                  <span className="arch-matrix-name" title={r.title}>
                    {r.title}
                  </span>
                </th>
                {all.map((c) => {
                  const here = between(data, r.id, c.id);
                  if (c.id === r.id || (r.external && c.external))
                    return <td key={c.id} className="is-self" aria-hidden="true" />;
                  if (here.length > 0)
                    return (
                      <td
                        key={c.id}
                        className={`is-hit ${open.has(`${r.id}|${c.id}`) ? 'is-open' : ''}`}
                      >
                        {names(r.id, c.id)}
                      </td>
                    );
                  return (
                    <td key={c.id} className="is-none">
                      {openContract ? (
                        <button
                          type="button"
                          className="arch-cell-add"
                          aria-label={`Add a contract between ${r.title} and ${c.title}`}
                          onClick={() =>
                            openContract({ kind: 'contract', id: null, ends: { a: r.id, b: c.id } })
                          }
                        >
                          +
                        </button>
                      ) : (
                        <span aria-label="No contract">·</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <PanelPlace panel={panel} />
    </div>
  );
}
