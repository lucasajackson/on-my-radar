/**
 * The architecture map's layout: pure and deterministic, so the web app and the
 * native apps draw the same picture from the same boundaries and contracts.
 *
 * Our boundaries sit in a grid inside a frame (the application); external
 * systems sit outside it on the side facing the boundaries they meet. A
 * contract is a line between two boxes with a labelled pill on it. No library:
 * a force layout is not deterministic, and dagre and elk are heavy for a grid.
 *
 * Input order never matters: everything is sorted by title, then id.
 */

export interface MapBoundary {
  readonly id: string;
  readonly title: string;
  readonly external: boolean;
}
export interface MapContract {
  readonly id: string;
  readonly title: string;
  readonly version: string | null;
  readonly a: string;
  readonly b: string;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface MapSeam {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  pill: Rect;
  label: string;
  /** One end is outside the frame: an external integration. */
  external: boolean;
}
export interface MapLayout {
  width: number;
  height: number;
  frame: Rect;
  boxes: Array<Rect & { id: string; external: boolean }>;
  seams: MapSeam[];
}

const BOX = { w: 150, h: 44 };
const GAP = { x: 40, y: 44 };
const PAD = 32;
const RING = { x: 140, y: 64 };
const MARGIN = 16;
const PILL_H = 18;
const STEPS = [0, ...Array.from({ length: 9 }, (_, i) => [(i + 1) / 10, -(i + 1) / 10]).flat()];
/** Offsets to try for a pill that has no room on or beside its line, nearest first. */
const ROAM = Array.from({ length: 17 * 13 }, (_, i) => ({
  dx: ((i % 17) - 8) * 24,
  dy: (Math.floor(i / 17) - 6) * 14,
})).sort((u, v) => Math.hypot(u.dx, u.dy) - Math.hypot(v.dx, v.dy) || u.dy - v.dy || u.dx - v.dx);
/** Past this many boundaries a fitted layout orders its cells with the cheaper search. */
const FAST_FROM = 40;
const SIDES = ['top', 'right', 'bottom', 'left'] as const;
type Side = (typeof SIDES)[number];

const byTitle = <T extends { title: string; id: string }>(list: readonly T[]): T[] =>
  [...list].sort(
    (a, b) =>
      a.title.localeCompare(b.title, 'en', { numeric: true, sensitivity: 'base' }) ||
      a.id.localeCompare(b.id),
  );
const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const overlaps = (a: Rect, b: Rect, pad = 0) =>
  a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;

/** Where a ray from the centre of `r` towards `to` leaves `r`. */
function exit(r: Rect, to: { x: number; y: number }) {
  const c = centre(r);
  const dx = to.x - c.x;
  const dy = to.y - c.y;
  const s = Math.min(
    dx ? r.w / 2 / Math.abs(dx) : Infinity,
    dy ? r.h / 2 / Math.abs(dy) : Infinity,
  );
  return { x: c.x + dx * s, y: c.y + dy * s };
}

export const seamLabel = (c: Pick<MapContract, 'title'>): string => {
  const name = c.title.replace(/\s*\(.*$/, '');
  return name.length > 16 ? `${name.slice(0, 15)}…` : name;
};

/** The sizes a layout is built from. The default is what every client has always drawn. */
interface Geometry {
  box: { w: number; h: number };
  gap: { x: number; y: number };
  pad: number;
  ring: { x: number; y: number };
  /** How far off its line a pill may sit when there is no room on it. */
  offsets: readonly number[];
  /** When nothing on or beside the line is free, take the nearest free spot anywhere around it. */
  roam: boolean;
  /** Height kept clear at the top of the frame for its label. */
  labelH: number;
  /** The cheaper search for the best order of the cells, used once there are many of them. */
  fast: boolean;
  /** Place the seams' pills. Off, only the boxes are laid out: enough to size a drawing. */
  pills: boolean;
}
const DEFAULT: Geometry = {
  box: BOX,
  gap: GAP,
  pad: PAD,
  ring: RING,
  offsets: [0, 36, -36],
  roam: false,
  labelH: 0,
  fast: false,
  pills: true,
};
/** Tighter, for a drawing that is fitted to a box: it is read at about 0.8x, so air costs legibility. */
const FITTED: Geometry = {
  box: { w: 140, h: 44 },
  gap: { x: 22, y: 40 },
  pad: 20,
  ring: { x: 40, y: 44 },
  offsets: [0, 28, -28, 44, -44, 60, -60, 76, -76, 96, -96, 120, -120],
  roam: true,
  labelH: 10,
  fast: true,
  pills: true,
};
/** Only the boxes and their rings, to size a drawing before its pills are placed. */
const SIZING: Geometry = { ...FITTED, pills: false };

export interface LayoutOptions {
  /**
   * The width / height of the box the drawing will be fitted to. Omitted, the layout is the
   * fixed one (a grid about 1.6 wide per row, the same on every client). Given, the internal
   * grid's column count and the tighter spacing are chosen so the drawing, externals included,
   * fits that box at the largest scale.
   */
  aspect?: number;
}

export function layoutMap(
  boundaries: readonly MapBoundary[],
  contracts: readonly MapContract[],
  options: LayoutOptions = {},
): MapLayout {
  const inside = byTitle(boundaries.filter((b) => !b.external));
  const outside = byTitle(boundaries.filter((b) => b.external));
  const seams = [...contracts].sort((a, b) => a.id.localeCompare(b.id));
  const { aspect } = options;
  if (aspect === undefined || !Number.isFinite(aspect) || aspect <= 0 || inside.length === 0)
    return build(
      inside,
      outside,
      seams,
      clamp(Math.ceil(Math.sqrt(1.6 * inside.length)), 2, 6),
      DEFAULT,
    );
  // The scale a drawing of this size would be fitted at, in a box `aspect` wide and 1 tall.
  const size = (m: MapLayout) => Math.min(aspect / m.width, 1 / m.height);
  // A pill on a box or another pill is worth a fifth of the scale each: legible beats large.
  const clashes = (m: MapLayout) => {
    const all: Rect[] = [...m.boxes, ...m.seams.map((s) => s.pill)];
    return all.reduce(
      (sum, one, i) => sum + all.slice(i + 1).filter((other) => overlaps(one, other)).length,
      0,
    );
  };
  const fit = (m: MapLayout) => size(m) * Math.max(0.1, 1 - 0.2 * clashes(m));
  // Bounded: every column count is sized without its pills (cheap), and only the two that would
  // fit the box best are drawn in full. A drawing of a hundred boundaries stays well under a
  // tenth of a second this way, where trying every count with everything took seconds.
  const arranged = new Map<number, string[]>();
  const ranked = Array.from({ length: 8 }, (_, i) => i + 2)
    .map((cols) => ({ cols, size: size(build(inside, outside, seams, cols, SIZING, arranged)) }))
    .sort((p, q) => q.size - p.size || p.cols - q.cols)
    .slice(0, 2);
  let chosen: MapLayout | null = null;
  let chosenCols = 2;
  for (const { cols } of ranked) {
    const next = build(inside, outside, seams, cols, FITTED, arranged);
    if (!chosen || fit(next) > fit(chosen) + 1e-12) {
      chosen = next;
      chosenCols = cols;
    }
  }
  let layout = chosen as MapLayout;
  // The columns come in whole steps, so the shape is rarely the box's. The side with room to
  // spare gets it as air between the boxes (more room for a pill, a label that breathes), for as
  // long as that does not cost any scale: the drawing fills the box rather than sitting in it.
  // The most air that costs nothing is found by halving, not by trying every amount.
  const roomy = aspect / layout.width <= 1 / layout.height ? 'y' : 'x';
  const roomed = (more: number): Geometry => ({
    ...FITTED,
    gap:
      roomy === 'y'
        ? { ...FITTED.gap, y: FITTED.gap.y + more }
        : { ...FITTED.gap, x: FITTED.gap.x + more },
    ring:
      roomy === 'y'
        ? { ...FITTED.ring, y: FITTED.ring.y + more / 2 }
        : { ...FITTED.ring, x: FITTED.ring.x + more / 2 },
  });
  const floor = fit(layout) - 1e-12;
  let lo = 0;
  let hi = 144;
  const top = build(inside, outside, seams, chosenCols, roomed(hi), arranged);
  if (fit(top) >= floor) layout = top;
  else
    for (let i = 0; i < 4; i += 1) {
      const mid = (lo + hi) / 2;
      const next = build(inside, outside, seams, chosenCols, roomed(mid), arranged);
      if (fit(next) >= floor) {
        lo = mid;
        layout = next;
      } else hi = mid;
    }
  return layout;
}

/** Swap cells while the internal seams get shorter, counting only the seams of the two that move. */
function improve(
  order: string[],
  pairs: ReadonlyArray<readonly [string, string]>,
  cols: number,
  box: { w: number; h: number },
  gap: { x: number; y: number },
  pad: number,
) {
  const at = new Map(order.map((id, i) => [id, i]));
  const near = new Map<string, string[]>();
  for (const [a, b] of pairs)
    if (a !== b) {
      near.set(a, [...(near.get(a) ?? []), b]);
      near.set(b, [...(near.get(b) ?? []), a]);
    }
  const cx = (i: number) => pad + (i % cols) * (box.w + gap.x) + box.w / 2;
  const cy = (i: number) => Math.floor(i / cols) * (box.h + gap.y) + box.h / 2;
  const d = (i: number, j: number) => Math.hypot(cx(i) - cx(j), cy(i) - cy(j));
  const moved = (id: string, from: number, to: number, other: string) =>
    (near.get(id) ?? []).reduce(
      (sum, nb) =>
        nb === other ? sum : sum + d(to, at.get(nb) as number) - d(from, at.get(nb) as number),
      0,
    );
  for (let pass = 0, improved = true; improved && pass < 8; pass += 1) {
    improved = false;
    for (let i = 0; i < order.length; i += 1)
      for (let j = i + 1; j < order.length; j += 1) {
        const u = order[i] as string;
        const v = order[j] as string;
        if (moved(u, i, j, v) + moved(v, j, i, u) < -1e-9) {
          order[i] = v;
          order[j] = u;
          at.set(v, i);
          at.set(u, j);
          improved = true;
        }
      }
  }
}

function build(
  inside: MapBoundary[],
  outside: MapBoundary[],
  seams: MapContract[],
  cols: number,
  g: Geometry,
  /** Orders already found, by column count: the order barely depends on the air between cells. */
  arranged?: Map<number, string[]>,
): MapLayout {
  const BOX = g.box;
  const GAP = g.gap;
  const PAD = g.pad;
  const RING = g.ring;
  const n = inside.length;
  const rows = Math.max(1, Math.ceil(n / cols));
  const frame: Rect = {
    x: 0,
    y: 0,
    w: 2 * PAD + cols * BOX.w + (cols - 1) * GAP.x,
    h: 2 * PAD + g.labelH + rows * BOX.h + (rows - 1) * GAP.y,
  };
  const cell = (i: number): Rect => ({
    x: frame.x + PAD + (i % cols) * (BOX.w + GAP.x),
    y: frame.y + PAD + g.labelH + Math.floor(i / cols) * (BOX.h + GAP.y),
    ...BOX,
  });

  // Swap pairs of cells while the total length of the internal seams falls.
  const order = inside.map((b) => b.id);
  const pairs = seams.flatMap((c) =>
    order.includes(c.a) && order.includes(c.b) ? [[c.a, c.b] as const] : [],
  );
  const length = () =>
    pairs.reduce((sum, [a, b]) => {
      const p = centre(cell(order.indexOf(a)));
      const q = centre(cell(order.indexOf(b)));
      return sum + Math.hypot(p.x - q.x, p.y - q.y);
    }, 0);
  if (g.fast && n > FAST_FROM) {
    const known = arranged?.get(cols);
    if (known) order.splice(0, order.length, ...known);
    else {
      improve(order, pairs, cols, BOX, GAP, PAD);
      arranged?.set(cols, [...order]);
    }
  } else {
    let best = length();
    for (let pass = 0, improved = true; improved && pass < 20; pass += 1) {
      improved = false;
      for (let i = 0; i < n; i += 1)
        for (let j = i + 1; j < n; j += 1) {
          [order[i], order[j]] = [order[j] as string, order[i] as string];
          const next = length();
          if (next < best - 1e-9) {
            best = next;
            improved = true;
          } else [order[i], order[j]] = [order[j] as string, order[i] as string];
        }
    }
  }

  const boxes = new Map<string, Rect & { id: string; external: boolean }>();
  order.forEach((id, i) => boxes.set(id, { ...cell(i), id, external: false }));

  // Each external goes to the frame side facing its counterparties; a full side overflows clockwise.
  const fc = centre(frame);
  const want = (id: string): Side => {
    const near = seams.flatMap((c) => (c.a === id ? [c.b] : c.b === id ? [c.a] : []));
    const pts = near.flatMap((o) => (boxes.has(o) ? [centre(boxes.get(o) as Rect)] : []));
    const bx = pts.length ? pts.reduce((s, p) => s + p.x, 0) / pts.length : fc.x;
    const by = pts.length ? pts.reduce((s, p) => s + p.y, 0) / pts.length : fc.y;
    const nx = (bx - fc.x) / (frame.w / 2);
    const ny = (by - fc.y) / (frame.h / 2);
    return Math.abs(ny) >= Math.abs(nx) ? (ny < 0 ? 'top' : 'bottom') : nx < 0 ? 'left' : 'right';
  };
  const room = (side: Side) =>
    side === 'top' || side === 'bottom'
      ? Math.floor(frame.w / (BOX.w + 12))
      : Math.floor(frame.h / (BOX.h + 10));
  const placed: Record<Side, Array<{ id: string; at: number }>> = {
    top: [],
    right: [],
    bottom: [],
    left: [],
  };
  for (const ext of outside) {
    const first = SIDES.indexOf(want(ext.id));
    const order = [...SIDES.slice(first), ...SIDES.slice(0, first)];
    const side = order.find((s) => placed[s].length < room(s)) ?? order[0] ?? 'top';
    const near = seams.flatMap((c) => (c.a === ext.id ? [c.b] : c.b === ext.id ? [c.a] : []));
    const pts = near.flatMap((o) => (boxes.has(o) ? [centre(boxes.get(o) as Rect)] : []));
    const along = pts.length
      ? pts.reduce((s, p) => s + (side === 'top' || side === 'bottom' ? p.x : p.y), 0) / pts.length
      : 0;
    placed[side].push({ id: ext.id, at: along });
  }
  for (const side of SIDES) {
    const list = placed[side].sort((a, b) => a.at - b.at);
    const flat = side === 'top' || side === 'bottom';
    const span = flat ? frame.w : frame.h;
    const pitch = flat ? BOX.w + 12 : BOX.h + 10;
    const step = Math.max(span / Math.max(1, list.length), pitch);
    list.forEach(({ id }, i) => {
      const mid = (flat ? frame.x : frame.y) + (span - step * list.length) / 2 + step * (i + 0.5);
      boxes.set(id, {
        id,
        external: true,
        ...BOX,
        x: flat ? mid - BOX.w / 2 : side === 'left' ? -RING.x - BOX.w : frame.w + RING.x,
        y: flat ? (side === 'top' ? -RING.y - BOX.h : frame.h + RING.y) : mid - BOX.h / 2,
      });
    });
  }

  // Lines run box to box; a pill sits at the midpoint, or on the wall when one end is outside.
  const pills: Rect[] = [];
  const out: MapSeam[] = [];
  const boxList = [...boxes.values()];
  for (const c of g.pills ? seams : []) {
    const a = boxes.get(c.a);
    const b = boxes.get(c.b);
    if (!a || !b) continue;
    const p = exit(a, centre(b));
    const q = exit(b, centre(a));
    const walled = a.external !== b.external;
    let base = 0.5;
    if (walled) {
      const [from, to] = a.external ? [q, p] : [p, q];
      // The wall is the first frame edge the line crosses on its way out.
      const ts = [0, 1].flatMap((axis) => {
        const lo = axis === 0 ? frame.x : frame.y;
        const hi = lo + (axis === 0 ? frame.w : frame.h);
        const f = axis === 0 ? from.x : from.y;
        const d = (axis === 0 ? to.x : to.y) - f;
        return d ? [(lo - f) / d, (hi - f) / d].filter((t) => t > 0 && t <= 1) : [];
      });
      const t = ts.length ? Math.min(...ts) : 0.5;
      base = a.external ? 1 - t : t;
    }
    const label = seamLabel(c);
    const w = Math.round(label.length * 6.4 + 14);
    const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
    const at = (t: number, off = 0): Rect => ({
      x: p.x + (q.x - p.x) * t + (-(q.y - p.y) / len) * off - w / 2,
      y: p.y + (q.y - p.y) * t + ((q.x - p.x) / len) * off - PILL_H / 2,
      w,
      h: PILL_H,
    });
    const free = (r: Rect) =>
      !(boxList.some((o) => overlaps(r, o, 2)) || pills.some((o) => overlaps(r, o, 2)));
    // On the line first, sliding along it; then beside it, where a short gap leaves no room on it.
    const along = (): Rect | undefined => {
      for (const off of g.offsets)
        for (const step of STEPS) {
          const r = at(clamp(base + step, 0.05, 0.95), off);
          if (free(r)) return r;
        }
      return undefined;
    };
    const roam = (): Rect | undefined => {
      const mid = at(base);
      for (const { dx, dy } of ROAM) {
        const r = { ...mid, x: mid.x + dx, y: mid.y + dy };
        if (free(r)) return r;
      }
      return undefined;
    };
    const pill = along() ?? (g.roam ? roam() : undefined) ?? at(base);
    pills.push(pill);
    out.push({ id: c.id, x1: p.x, y1: p.y, x2: q.x, y2: q.y, pill, label, external: walled });
  }

  // Normalise so everything sits MARGIN from the top left, and size the canvas.
  const rects = [frame, ...boxes.values(), ...pills];
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const dx = MARGIN - minX;
  const dy = MARGIN - minY;
  const move = <T extends Rect>(r: T): T => ({ ...r, x: r.x + dx, y: r.y + dy });
  return {
    width: Math.max(...rects.map((r) => r.x + r.w)) + dx + MARGIN,
    height: Math.max(...rects.map((r) => r.y + r.h)) + dy + MARGIN,
    frame: move(frame),
    boxes: [...boxes.values()].map(move).sort((a, b) => a.id.localeCompare(b.id)),
    seams: out.map((s) => ({
      ...s,
      x1: s.x1 + dx,
      y1: s.y1 + dy,
      x2: s.x2 + dx,
      y2: s.y2 + dy,
      pill: move(s.pill),
    })),
  };
}
