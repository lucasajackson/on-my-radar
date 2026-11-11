import { useCallback, useRef } from 'react';

/**
 * The radar header's real height, published as `--radar-header-h` on the radar's own column
 * (`[data-radar-column]`), for everything that sticks beneath it: the architecture tab bar, the
 * discussion rail, the anchors that scroll under it.
 *
 * It was a hardcoded 6.25rem, and the header is 118px when the tagline wraps, so the bar stuck 18px
 * short and the page showed between the two. Measured rather than guessed, as `--arch-fill` is:
 * set on the node itself (not React state), so a re-render never re-applies a stale value, and the
 * same number twice changes nothing, so watching the header cannot loop.
 *
 * Returns a callback ref for the `<header>`; the property is removed when the header unmounts.
 */
export function useRadarHeaderHeight(): (header: HTMLElement | null) => void {
  const release = useRef<(() => void) | null>(null);
  return useCallback((header: HTMLElement | null) => {
    release.current?.();
    release.current = null;
    if (!header) return;
    const column = header.closest<HTMLElement>('[data-radar-column]');
    if (!column) return;
    const measure = () =>
      column.style.setProperty(
        '--radar-header-h',
        `${Math.ceil(header.getBoundingClientRect().height)}px`,
      );
    measure();
    const watcher = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    watcher?.observe(header);
    release.current = () => {
      watcher?.disconnect();
      column.style.removeProperty('--radar-header-h');
    };
  }, []);
}
