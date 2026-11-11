import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RADAR_ACCENTS, RADAR_SURFACES, themeFor } from '@onmyradar/contract';
import { accentStyle, themeStyle } from './theme';
import { must } from './must';

const rgb = (hex: string) =>
  [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
const luminance = (values: number[]) =>
  values
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
    .reduce((sum, value, index) => sum + value * must([0.2126, 0.7152, 0.0722][index]), 0);
const contrast = (first: number[], second: number[]) =>
  (Math.max(luminance(first), luminance(second)) + 0.05) /
  (Math.min(luminance(first), luminance(second)) + 0.05);
const mix = (first: number[], second: number[], portion: number) =>
  first.map((value, index) => value * portion + must(second[index]) * (1 - portion));
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const palette = (block: string): Record<string, string> => {
  const tokens: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6}|[0-9]+%);/g)) {
    if (name !== undefined && value !== undefined) tokens[name] = value;
  }
  return tokens;
};
const dark = palette(must(must(css.split(':root {')[1]).split('}')[0]));
const light = palette(must(must(css.split(":root[data-theme='light'] {")[1]).split('}')[0]));
const surfaces = [
  ...Object.values(RADAR_SURFACES)
    .filter((surface) => surface.bg)
    .map((surface) => ({ ...surface, strength: 0.35 })),
  ...[dark, light].map((tokens) => ({
    bg: must(tokens['ink-900']),
    panel: must(tokens['ink-700']),
    ink: must(tokens['paper']),
    strength: Number.parseFloat(must(tokens['accent-strength'])) / 100,
  })),
];

describe('UI accent contrast across every selectable surface', () => {
  it('keeps shell text readable on every neutral surface', () => {
    for (const tokens of [dark, light]) {
      for (const key of ['ink-900', 'ink-850', 'ink-800', 'ink-750', 'ink-700']) {
        const background = rgb(must(tokens[key], key));
        expect(background[0]).toBe(background[1]);
        expect(background[1]).toBe(background[2]);
        for (const ink of ['paper', 'paper-dim', 'paper-faint']) {
          expect(
            contrast(rgb(must(tokens[ink], ink)), background),
            `${ink} on ${key}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
  it('keeps accent text AA on the surface and its panel, independently of the accent fill', () => {
    expect(css).toContain(
      '--accent-from: color-mix(in srgb, var(--accent-raw-from) var(--accent-strength), var(--paper))',
    );
    expect(accentStyle('cobalt')).toHaveProperty(
      '--accent-from',
      'color-mix(in srgb, var(--accent-raw-from) var(--accent-strength), var(--paper))',
    );
    for (const accent of Object.values(RADAR_ACCENTS)) {
      for (const surface of surfaces) {
        const text = mix(rgb(accent.from), rgb(surface.ink), surface.strength);
        for (const background of [surface.bg, surface.panel])
          expect(
            contrast(text, rgb(background)),
            `${accent.label} text on ${background}`,
          ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps primary-button and selected-chip ink AA across every accent and hover', () => {
    for (const accent of Object.values(RADAR_ACCENTS)) {
      const ink = mix(rgb(accent.ink), [0, 0, 0], 0.85);
      for (const fill of [rgb(accent.from), mix(rgb(accent.from), [1, 1, 1], 0.88)])
        expect(contrast(ink, fill), accent.label).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps themed status messages readable without inheriting a conflicting system palette', () => {
    expect(themeStyle(themeFor({ surface: 'paper' }))).toHaveProperty(
      '--danger',
      'color-mix(in srgb, #ef4444 35%, var(--paper))',
    );
    for (const surface of surfaces)
      for (const status of ['#ef4444', '#d98a3a', '#22c55e']) {
        const text = mix(rgb(status), rgb(surface.ink), 0.35);
        for (const background of [surface.bg, surface.panel])
          expect(contrast(text, rgb(background))).toBeGreaterThanOrEqual(4.5);
      }
  });
});
