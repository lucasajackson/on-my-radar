/**
 * What the person can actually see.
 *
 * There are two viewports on a phone and they are not the same rectangle. The
 * **layout** viewport is what `position: fixed`, `100vh` and `100dvh` are all
 * measured against. The **visual** viewport is the part of it currently on
 * screen. On iOS Safari the software keyboard shrinks only the visual one — the
 * layout viewport stays its full height — so a sheet anchored to the bottom of
 * `inset-0` anchors itself squarely underneath the keyboard. That is precisely
 * what put the whole compose sheet off-screen on the product owner's phone: `dvh` does not
 * track keyboard insets, and nothing else in CSS does either.
 *
 * `window.visualViewport` is the only thing that reports the truth, and it is a
 * JS API. So we publish it as two custom properties on the document element and
 * let layout be written in CSS against the region that is really visible:
 *
 * - `--vv-height` — the visible height, in px
 * - `--vv-top` — how far the visual viewport has been scrolled down the layout
 *   viewport, which is what iOS does to bring a focused field into view
 *
 * Installed once at the root. Everything downstream just reads the properties;
 * the static fallbacks in `styles.css` mean a browser without the API (or the
 * first paint before this runs) still gets a sensible full-height box.
 */
import { useEffect, useState } from 'react';

/** Phones: below Tailwind's `sm`. */
export const PHONE_QUERY = '(max-width: 639px)';
/** Matches the `lg` breakpoint the shell furls at, so chrome and content agree. */
export const DESKTOP_QUERY = '(min-width: 1024px)';
/** Wide enough to draw a diagram: a tablet in portrait and up. A phone gets lists instead. */
export const WIDE_QUERY = '(min-width: 820px)';

export function useVisualViewport(): void {
  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;

    const apply = () => {
      const height = viewport ? viewport.height : window.innerHeight;
      const top = viewport ? viewport.offsetTop : 0;
      // Rounded because sub-pixel values here produce a visible shimmer as the
      // keyboard animates in, and nothing needs the precision.
      root.style.setProperty('--vv-height', `${Math.round(height)}px`);
      root.style.setProperty('--vv-top', `${Math.round(top)}px`);
    };

    apply();

    if (!viewport) {
      window.addEventListener('resize', apply);
      return () => window.removeEventListener('resize', apply);
    }

    // `scroll` matters as much as `resize`: iOS scrolls the visual viewport to
    // reveal a focused field without ever firing a resize.
    viewport.addEventListener('resize', apply);
    viewport.addEventListener('scroll', apply);
    window.addEventListener('orientationchange', apply);
    return () => {
      viewport.removeEventListener('resize', apply);
      viewport.removeEventListener('scroll', apply);
      window.removeEventListener('orientationchange', apply);
    };
  }, []);
}

/**
 * A media query as state.
 *
 * Used where a phone and a desktop need genuinely different markup rather than
 * the same markup restyled — the board's lane pager, and the composer, where the
 * primary control has to move into the header to stay clear of the keyboard.
 * Anything that is only a matter of appearance belongs in CSS instead.
 */
export function useMediaQuery(query: string): boolean {
  // No `matchMedia` (a test environment, an ancient browser) is no match, not a crash.
  const has = typeof window !== 'undefined' && typeof window.matchMedia === 'function';
  const [matches, setMatches] = useState(() => has && window.matchMedia(query).matches);
  useEffect(() => {
    if (!has) return;
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query, has]);
  return matches;
}
