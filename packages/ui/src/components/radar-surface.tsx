/**
 * The container a radar's own theme is applied to.
 *
 * One component, used by the private radar screen and by the public page, so
 * there is exactly one answer to "where does a theme start and stop". That
 * boundary is the whole safety story, and two call sites drawing it slightly
 * differently is how a theme ends up reaching a surface nobody meant it to.
 *
 * ## What is inside and what is outside
 *
 * **Inside**: the radar's header, its bearing strip, the composer and the posts.
 * Everything a reader of this radar is looking at.
 *
 * **Outside**: the application shell, the sidebar, the tab bar, the toast layer
 * and — deliberately — every dialog. A settings dialog that repainted itself
 * while you were choosing the paper would make the picker unreadable at exactly
 * the moment you needed to read it, and the modal layer is chrome that belongs
 * to the application rather than to the radar.
 *
 * ## Nothing is rendered when the theme is the default
 *
 * No wrapper, no pattern pseudo-element, no attributes. The overwhelming
 * majority of radars are unthemed and should cost nothing, and it keeps "is this
 * radar styled" answerable by looking at the DOM.
 */
import type { ReactNode } from 'react';
import { isDefaultTheme, isThemeable, type RadarDto } from '@onmyradar/contract';
import { themeAttrs, themeStyle } from '../lib/theme';

export function RadarSurface({
  radar,
  page = false,
  children,
}: {
  radar: RadarDto;
  /**
   * The themed container is the whole window, not just its own content.
   *
   * True on the public page and false inside the application, where the shell
   * owns the window. Without it a short radar on a light paper ended with a band
   * of the application's near-black below the footer, which reads as a broken
   * page rather than as a design.
   */
  page?: boolean;
  children: ReactNode;
}) {
  // Themeability is a registry property of the template, never a check on its
  // id. A radar switched to a template that opts out keeps its stored theme —
  // it simply stops being drawn — so switching back is not data loss.
  const themed = isThemeable(radar.template) && !isDefaultTheme(radar.theme);
  if (!themed) return <>{children}</>;

  return (
    <div
      className={`radar-theme ${page ? 'is-page' : ''}`}
      style={themeStyle(radar.theme)}
      {...themeAttrs(radar.theme)}
    >
      {children}
    </div>
  );
}
