/** Colour-scheme preference and per-radar accent application. */
import { useEffect } from 'react';
import {
  DEFAULT_RADAR_ACCENT,
  RADAR_ACCENTS,
  RADAR_SURFACES,
  isRadarAccent,
  isThemeable,
  isDefaultTheme,
  themeFor,
  type RadarTheme,
  type RadarDto,
} from '@onmyradar/contract';
import { entry } from './registry';

export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'omr.theme';

/**
 * Applied to <html> so the first paint is correct. 'system' removes the
 * attribute entirely and lets the prefers-color-scheme block in styles.css win.
 */
export function applyTheme(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', preference);
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Private browsing; the server-side preference still applies next load.
  }
}

/**
 * Dark for as long as the calling screen is mounted, whatever the device or the
 * stored preference says; the attribute that was there is put back after.
 *
 * For /login and the waiting room only: they are the step after the marketing
 * site, which is dark, and arriving from it onto a white page read as leaving
 * the product. The stored preference is not touched — this is how these two
 * screens look, not a choice made for the person.
 */
export function useDarkScreen(): void {
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.getAttribute('data-theme');
    root.setAttribute('data-theme', 'dark');
    return () => {
      if (previous === null) root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', previous);
    };
  }, []);
}

export function storedTheme(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'light' || value === 'dark' || value === 'system') return value;
  } catch {
    /* ignore */
  }
  return 'system';
}

/**
 * The accent variables every radar-scoped surface reads. Set on a container
 * rather than on :root so two radars can sit side by side on a dashboard, each
 * in its own colour.
 */
export function accentStyle(accent: string | undefined): React.CSSProperties {
  const key = isRadarAccent(accent) ? accent : DEFAULT_RADAR_ACCENT;
  const value = RADAR_ACCENTS[key];
  return {
    ['--accent-from' as string]:
      'color-mix(in srgb, var(--accent-raw-from) var(--accent-strength), var(--paper))',
    ['--accent-fill' as string]: value.from,
    ['--accent-to' as string]: value.to,
    ['--accent-ink' as string]: value.ink,
    ['--accent' as string]: 'var(--accent-from)',
    // The unmixed value, so a themed surface can pull the accent toward its own
    // ink without a self-referential cycle. See `.radar-theme` in styles.css.
    ['--accent-raw-from' as string]: value.from,
  };
}

/* --------------------------- per-radar themes ---------------------------- */

/**
 * The colour half of a radar theme, as an inline token override.
 *
 * Exactly the same trick as `accentStyle`, one layer out: the design system is
 * already token-driven, so redefining the tokens on a container re-skins
 * everything nested inside it without a single component knowing a theme
 * exists. That is why `styles.css` needs no per-component theme rules.
 *
 * ## What may cross this boundary
 *
 * Only hexes read out of `RADAR_SURFACES`, indexed by a key `themeFor` has
 * already proved is one of that registry's own. **No value a person or an agent
 * typed ever appears here** — the stored theme selects among our literals, it
 * never supplies one. The key list below is fixed, so a theme cannot write
 * `--accent-*` (which would let it repaint chrome it does not own) or any
 * property outside this set.
 *
 * The other eight axes do not come through here at all: they are `data-`
 * attributes matching static rules, so nothing crosses for them at all. See the
 * radar-theme section of `styles.css`.
 *
 * `surface: 'default'` returns nothing, so the application's own tokens show
 * through untouched rather than being reset to themselves.
 */
export function themeStyle(theme: RadarTheme | undefined): React.CSSProperties {
  const surface = entry(RADAR_SURFACES, theme?.surface ?? 'default');
  if (!surface?.bg) return {};
  return {
    colorScheme: surface.scheme,
    ['--accent-strength' as string]: '35%',
    ['--danger' as string]: 'color-mix(in srgb, #ef4444 35%, var(--paper))',
    ['--warn' as string]: 'color-mix(in srgb, #d98a3a 35%, var(--paper))',
    ['--ok' as string]: 'color-mix(in srgb, #22c55e 35%, var(--paper))',
    ['--ink-900' as string]: surface.bg,
    ['--ink-850' as string]: surface.bg,
    ['--ink-800' as string]: surface.panel,
    ['--ink-750' as string]: surface.panel,
    ['--ink-700' as string]: surface.panel,
    ['--line' as string]: surface.line,
    ['--line-soft' as string]: surface.line,
    ['--paper' as string]: surface.ink,
    ['--paper-dim' as string]: surface.inkDim,
    // Deliberately `inkDim` rather than something fainter still. The instrument
    // voice is the smallest text on the page, and a surface's dim ink is the
    // palest value that was contrast-checked — see theme.test.ts. A themed page
    // therefore has a *more* readable chrome voice than an unthemed one.
    ['--paper-faint' as string]: surface.inkDim,
  };
}

/**
 * The `data-` attributes for the eight non-colour axes.
 *
 * Spread onto the same element as `themeStyle`. React escapes attribute values,
 * and a value that is not in the registry matches no rule in `styles.css`, so
 * the worst a corrupted row can do is look default.
 */
export function themeAttrs(theme: RadarTheme | undefined): Record<string, string> {
  const resolved = themeFor(theme);
  return {
    'data-omr-surface': resolved.surface,
    'data-omr-pattern': resolved.pattern,
    'data-omr-body': resolved.bodyFont,
    'data-omr-chrome': resolved.chromeFont,
    'data-omr-corners': resolved.corners,
    'data-omr-rule': resolved.rule,
    'data-omr-density': resolved.density,
    'data-omr-cursor': resolved.cursor,
    'data-omr-headline': resolved.headline,
  };
}

/** Safe appearance tokens for search while reading a themed radar. */
export function searchThemeStyle(
  radar: Pick<RadarDto, 'template' | 'theme' | 'accent'> | undefined,
): React.CSSProperties | undefined {
  if (!radar || !isThemeable(radar.template) || isDefaultTheme(radar.theme)) return undefined;
  const theme = themeFor(radar.theme);
  const chrome = { sans: 'var(--font-sans)', serif: 'var(--font-serif)', mono: 'var(--font-mono)' }[
    theme.chromeFont
  ];
  return {
    ...accentStyle(radar.accent),
    ...themeStyle(theme),
    fontFamily: chrome,
    ['--search-radius-control' as string]:
      theme.corners === 'sharp' ? '0px' : theme.corners === 'round' ? '18px' : '10px',
    ['--search-radius-menu' as string]:
      theme.corners === 'sharp' ? '0px' : theme.corners === 'round' ? '18px' : '12px',
  };
}
