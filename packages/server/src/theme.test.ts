/**
 * Radar themes — the properties the feature rests on.
 *
 * A theme is applied to a page strangers read, so these are not style tests.
 * Three claims are made in `theme.ts` and in `docs/DESIGN.md`, and each one is
 * only true if something checks it:
 *
 *  1. **Nothing a caller supplies reaches CSS.** `themeFor` is the only way a
 *     stored value becomes a rendered one, and it returns registry keys or
 *     defaults — never the input.
 *  2. **A theme cannot hide an author's name.** That rests entirely on surfaces
 *     shipping their ink with their ground, so every surface is held to a
 *     contrast floor here. Without this assertion the claim is an intention.
 *  3. **A preset is a starting point, not state.** `presetOf` is derived, so it
 *     stops claiming a preset the moment the theme stops being one.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RADAR_THEME,
  RADAR_SURFACES,
  RADAR_SURFACE_KEYS,
  REFUSED_STYLE_KEYS,
  radarThemeSchema,
  THEME_AXES,
  THEME_AXIS_KEYS,
  THEME_PRESETS,
  THEME_PRESET_KEYS,
  isDefaultTheme,
  presetOf,
  themeFor,
  type RadarSurface,
} from '@onmyradar/contract';
import { resolveThemeInput } from './services/radars.js';

/* ------------------------------- contrast -------------------------------- */

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  // Every channel goes through `channel`. An earlier draft of this file left the
  // blue term raw, which put every luminance above 1 and made three of the
  // assertions below fail against a palette that was fine — a reminder that when
  // a check fails the first question is whether the assertion or the code is
  // wrong. Two of them were the palette; one was this.
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

/** WCAG 2.1 contrast ratio. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const THEMED: RadarSurface[] = RADAR_SURFACE_KEYS.filter((key) => key !== 'default');

describe('surfaces', () => {
  it('are authored as a pair, so no theme can pick invisible text', () => {
    // The single most load-bearing decision in the vocabulary: a person chooses
    // a *paper*, never a background and a foreground independently. With no
    // positioning in the vocabulary either, this is what makes "a theme cannot
    // hide the byline" a property rather than a hope.
    for (const key of THEMED) {
      const s = RADAR_SURFACES[key];
      expect(s.bg, key).toMatch(/^#[0-9a-f]{6}$/);
      expect(s.ink, key).toMatch(/^#[0-9a-f]{6}$/);
      expect(s.inkDim, key).toMatch(/^#[0-9a-f]{6}$/);
      expect(s.panel, key).toMatch(/^#[0-9a-f]{6}$/);
      expect(s.line, key).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('keeps body text at WCAG AA on its own ground', () => {
    for (const key of THEMED) {
      const s = RADAR_SURFACES[key];
      expect(contrast(s.ink, s.bg), `${key} ink on bg`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(s.ink, s.panel), `${key} ink on panel`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the instrument voice — where the byline lives — above 3:1', () => {
    // `--paper-dim` and `--paper-faint` both resolve to `inkDim` on a themed
    // surface, and the attribution line is `.instrument`. This is therefore the
    // assertion that stands directly behind the byline claim.
    for (const key of THEMED) {
      const s = RADAR_SURFACES[key];
      expect(contrast(s.inkDim, s.bg), `${key} dim ink on bg`).toBeGreaterThanOrEqual(3);
      expect(contrast(s.inkDim, s.panel), `${key} dim ink on panel`).toBeGreaterThanOrEqual(3);
    }
  });

  it('says which way its own scheme reads, so form controls are not inverted', () => {
    for (const key of THEMED) {
      const s = RADAR_SURFACES[key];
      const light = luminance(s.bg) > 0.4;
      expect(s.scheme, key).toBe(light ? 'light' : 'dark');
    }
  });

  it('leaves `default` empty, so the app tokens show through untouched', () => {
    // `themeStyle` keys off `bg` being empty to return no override at all. A
    // hex here would silently pin the default theme to today's palette.
    expect(RADAR_SURFACES.default.bg).toBe('');
  });
});

/* -------------------------------- themeFor ------------------------------- */

describe('themeFor', () => {
  it('returns a whole theme from nothing at all', () => {
    expect(themeFor(undefined)).toEqual(DEFAULT_RADAR_THEME);
    expect(themeFor(null)).toEqual(DEFAULT_RADAR_THEME);
    expect(themeFor({})).toEqual(DEFAULT_RADAR_THEME);
  });

  it('never lets a value it does not recognise through to the page', () => {
    // The whole safety model in one assertion. If any of these came back as
    // given, a stored value would be reaching CSS.
    const hostile = themeFor({
      surface: 'url(https://evil.test/x.png)',
      pattern: '"><script>alert(1)</script>',
      bodyFont: '@import url(//evil.test)',
      chromeFont: 42,
      corners: null,
      rule: ['double'],
      density: { toString: () => 'roomy' },
      cursor: 'url(https://evil.test/cur.png), auto',
      headline: 'expression(alert(1))',
      // A key the vocabulary does not have at all.
      backgroundImage: 'url(https://evil.test/x.png)',
    });
    expect(hostile).toEqual(DEFAULT_RADAR_THEME);
    expect(Object.keys(hostile).sort()).toEqual([...THEME_AXIS_KEYS].sort());
  });

  it('keeps the axes it knows and defaults only the ones it does not', () => {
    // Partial degradation, not total: a radar stored by a future build with one
    // unknown surface must not lose the other eight choices with it.
    expect(themeFor({ surface: 'terminal', pattern: 'lava', bodyFont: 'mono' })).toEqual({
      ...DEFAULT_RADAR_THEME,
      surface: 'terminal',
      bodyFont: 'mono',
    });
  });

  it('accepts every value the registry offers on every axis', () => {
    for (const axis of THEME_AXES) {
      for (const option of axis.options) {
        expect(themeFor({ [axis.key]: option })[axis.key], `${axis.key}=${option}`).toBe(option);
      }
    }
  });

  it('gives every axis option a label, so no control renders a raw key', () => {
    for (const axis of THEME_AXES) {
      for (const option of axis.options) {
        expect(axis.labelFor(option).length, `${axis.key}=${option}`).toBeGreaterThan(0);
      }
    }
  });
});

/* -------------------------------- presets -------------------------------- */

describe('presets', () => {
  it('are whole themes, so picking one leaves nothing half-set', () => {
    for (const key of THEME_PRESET_KEYS) {
      expect(Object.keys(THEME_PRESETS[key].theme).sort()).toEqual([...THEME_AXIS_KEYS].sort());
      expect(themeFor(THEME_PRESETS[key].theme)).toEqual(THEME_PRESETS[key].theme);
    }
  });

  it('are each recognised as themselves', () => {
    for (const key of THEME_PRESET_KEYS) {
      expect(presetOf(THEME_PRESETS[key].theme)).toBe(key);
    }
  });

  it('stop claiming a preset the moment one axis moves', () => {
    // Derived rather than stored, which is the reason this holds. A second
    // stored field would have gone on saying "Geocities" forever.
    const nudged = { ...THEME_PRESETS.geocities.theme, bodyFont: 'serif' as const };
    expect(presetOf(nudged)).toBeNull();
  });

  it('offers both directions Lucas asked for', () => {
    // A sanity check on the range, not on taste: at least one preset that is
    // clean and light, at least one that is unmistakably the old web.
    expect(presetOf(THEME_PRESETS.paper.theme)).toBe('paper');
    expect(THEME_PRESETS.geocities.theme.pattern).toBe('stars');
    expect(THEME_PRESETS.geocities.theme.bodyFont).toBe('marker');
    expect(THEME_PRESETS.terminal.theme.surface).toBe('terminal');
  });

  it('treats plain as the default look and nothing else', () => {
    expect(isDefaultTheme(THEME_PRESETS.plain.theme)).toBe(true);
    for (const key of THEME_PRESET_KEYS) {
      if (key !== 'plain') expect(isDefaultTheme(THEME_PRESETS[key].theme), key).toBe(false);
    }
  });
});

/* ------------------------------ the refusals ----------------------------- */

describe('asking for raw styling', () => {
  it('is refused by name rather than dropped in silence', () => {
    // Found by driving the real MCP transport rather than by reading the code.
    // zod strips unknown keys by default, so `{ css: '…' }` used to *succeed*,
    // change nothing, and hand back a theme that looked like it had worked —
    // which teaches the caller that the argument exists. Silence is the worst
    // possible answer to this particular question.
    for (const key of REFUSED_STYLE_KEYS) {
      const result = radarThemeSchema.safeParse({ [key]: 'body { color: red }' });
      expect(result.success, key).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message, key).toMatch(/fixed vocabulary/i);
      }
    }
  });

  it('says what to use instead, and names every axis', () => {
    const result = radarThemeSchema.safeParse({ css: 'x' });
    const message = result.success ? '' : (result.error.issues[0]?.message ?? '');
    for (const axis of THEME_AXIS_KEYS) expect(message, axis).toContain(axis);
    expect(message).toContain('preset');
  });

  it('still accepts a theme that only uses the vocabulary', () => {
    expect(radarThemeSchema.safeParse({ preset: 'terminal', bodyFont: 'serif' }).success).toBe(
      true,
    );
  });
});

/* ---------------------------- what gets stored --------------------------- */

describe('resolveThemeInput', () => {
  it('patches one axis and leaves the other eight alone', () => {
    const existing = THEME_PRESETS.terminal.theme;
    const stored = resolveThemeInput({ bodyFont: 'serif' }, existing);
    expect(stored).toEqual({ ...existing, bodyFont: 'serif' });
  });

  it('expands a preset and never stores its name', () => {
    const stored = resolveThemeInput({ preset: 'geocities' });
    expect(stored).toEqual(THEME_PRESETS.geocities.theme);
    expect(stored).not.toHaveProperty('preset');
  });

  it('lets an explicit axis beat the preset it came with', () => {
    // "Geocities, but with a serif" has to be one call, or an agent needs two
    // and the page flickers through a look nobody asked for in between.
    const stored = resolveThemeInput({ preset: 'geocities', bodyFont: 'serif' });
    expect(stored).toEqual({ ...THEME_PRESETS.geocities.theme, bodyFont: 'serif' });
  });

  it('stores the empty object when the result is the default look', () => {
    // One representation for "unthemed", so `isDefaultTheme` on the wire and a
    // `{}` in the column can never disagree.
    expect(resolveThemeInput({ preset: 'plain' }, THEME_PRESETS.terminal.theme)).toEqual({});
    expect(resolveThemeInput({ ...DEFAULT_RADAR_THEME })).toEqual({});
  });

  it('cannot be made to store a value the registry does not know', () => {
    // Belt to zod's braces: the schema refuses these at the transport, and this
    // is the service refusing them again with no transport involved.
    const stored = resolveThemeInput(
      { surface: 'evil', pattern: 'url(x)' },
      THEME_PRESETS.press.theme,
    );
    expect(stored).toEqual(THEME_PRESETS.press.theme);
  });
});
