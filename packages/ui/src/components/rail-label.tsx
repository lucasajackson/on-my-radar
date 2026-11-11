/**
 * The furled sidebar's labels: the name (and count, or shortcut) of whatever
 * the pointer is on or keyboard focus has reached, floating beside the rail.
 *
 * The rail used to lean on the browser's `title` tooltip — slow, unstyled,
 * and absent for a keyboard. Radars furled to identical coloured glyphs could
 * not be told apart until you hovered and waited.
 *
 * ## Why one label, fixed, and not one per item
 *
 * The rail scrolls (`overflow: auto`), and a label positioned inside it is
 * clipped by it — which is the whole of the space a label needs. So there is a
 * single label portaled to the body, `position: fixed`, placed from the item's
 * rect and clamped to the viewport so it never runs off an edge. It takes no
 * pointer events, so it can never catch a click meant for the page under it,
 * and it is `aria-hidden`: the item's own name is the accessible one (the
 * rail keeps its labels in the accessibility tree, only visually hidden), and
 * reading the name twice would be noise.
 *
 * Items opt in with `data-rail-label` (the name), and optionally
 * `data-rail-meta` (a count or ⌘K) and `data-rail-hot` (the count is unread).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';

interface Shown {
  name: string;
  meta: string | null;
  hot: boolean;
  /** The item's rect: the label sits beside it, centred on it. */
  anchor: { right: number; top: number; height: number };
}

const GAP = 10;
const EDGE = 8;

function readItem(
  target: EventTarget | null,
  rail: HTMLElement,
): { element: HTMLElement; shown: Shown } | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest<HTMLElement>('[data-rail-label]');
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    element,
    shown: {
      name: element.dataset['railLabel'] ?? '',
      meta: element.dataset['railMeta'] ?? null,
      hot: element.dataset['railHot'] === 'true',
      // Beside the rail, not beside the glyph: the glyph is centred in a
      // 60px column, and a label at its edge sat on the rail's own border.
      anchor: {
        right: Math.max(rect.right, rail.getBoundingClientRect().right),
        top: rect.top,
        height: rect.height,
      },
    },
  };
}

export function RailLabel({
  enabled,
  container,
}: {
  enabled: boolean;
  container: RefObject<HTMLElement | null>;
}) {
  const [shown, setShown] = useState<Shown | null>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const label = useRef<HTMLDivElement>(null);
  const current = useRef<HTMLElement | null>(null);

  const hide = useCallback(() => {
    current.current = null;
    setShown(null);
  }, []);

  useEffect(() => {
    const root = container.current;
    if (!enabled || !root) {
      hide();
      return;
    }
    const onOver = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
      const item = readItem(event.target, root);
      if (!item) {
        hide();
        return;
      }
      if (item.element === current.current) return;
      current.current = item.element;
      setShown(item.shown);
    };
    const onLeave = () => hide();
    const onFocus = (event: FocusEvent) => {
      const item = readItem(event.target, root);
      // Keyboard focus only: a click also focuses, and the pointer path has
      // already said what there is to say.
      if (!item || !(event.target instanceof Element) || !event.target.matches(':focus-visible'))
        return;
      current.current = item.element;
      setShown(item.shown);
    };
    const onBlur = (event: FocusEvent) => {
      if (!(event.relatedTarget instanceof Element) || !root.contains(event.relatedTarget)) hide();
    };
    root.addEventListener('pointerover', onOver);
    root.addEventListener('pointerleave', onLeave);
    root.addEventListener('focusin', onFocus);
    root.addEventListener('focusout', onBlur);
    // The rail scrolls under a label that was placed for where the item was.
    root.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      root.removeEventListener('pointerover', onOver);
      root.removeEventListener('pointerleave', onLeave);
      root.removeEventListener('focusin', onFocus);
      root.removeEventListener('focusout', onBlur);
      root.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [enabled, container, hide]);

  // Placed after it has a size, clamped so it never runs off the viewport.
  useLayoutEffect(() => {
    if (!shown || !label.current) {
      setPlace(null);
      return;
    }
    const { width, height } = label.current.getBoundingClientRect();
    const centre = shown.anchor.top + shown.anchor.height / 2;
    const top = Math.min(Math.max(centre - height / 2, EDGE), window.innerHeight - height - EDGE);
    const left = Math.min(shown.anchor.right + GAP, window.innerWidth - width - EDGE);
    setPlace({ left: Math.max(left, EDGE), top });
  }, [shown]);

  if (!shown) return null;
  return createPortal(
    <div
      ref={label}
      className={`rail-label ${place ? 'is-shown' : ''}`}
      data-rail-label-for={shown.name}
      aria-hidden="true"
      style={place ? { left: place.left, top: place.top } : { left: -9999, top: 0 }}
    >
      <span>{shown.name}</span>
      {shown.meta ? (
        <span className={`rail-label-meta ${shown.hot ? 'is-hot' : ''}`}>{shown.meta}</span>
      ) : null}
    </div>,
    document.body,
  );
}
