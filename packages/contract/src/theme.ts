/**
 * Radar themes — "have some fun with it, like Myspace back in the day."
 *
 * This file is the whole vocabulary. It is imported by the server, by the
 * browser bundle and by the MCP tool schema, and it is deliberately the only
 * place a theme is described.
 *
 * ## The one rule everything else follows from
 *
 * **No user-authored string ever reaches CSS.** A theme is nine enum keys. Each
 * key is validated against a registry here, and the SPA turns it into a `data-`
 * attribute whose matching rule is a static declaration in `styles.css`, written
 * by us and shipped in the bundle. There is no code path anywhere that
 * concatenates a stored value into a stylesheet, a `style` attribute or a
 * `url()`. A corrupted row does not produce broken CSS; it produces an attribute
 * that matches no rule, which is the default look.
 *
 * That is a stronger position than sanitising CSS, and it was chosen because the
 * CSP on a public radar **cannot** be the defence. Blips carry open-graph
 * thumbnails from arbitrary hosts, so `img-src` has to allow `https:`, and
 * `img-src https:` is exactly the channel a CSS exfiltration uses — attribute
 * selectors matching on a value and firing a `background-image` request per
 * match. As long as link previews exist, raw user CSS on a public page is
 * unsafe no matter what the header says. The vocabulary is not a nicety; it is
 * the only version of this feature that can be shipped.
 *
 * ## What the vocabulary refuses, and why each one
 *
 * - **No free text, anywhere.** Not a colour, not a font name, not a length.
 * - **No `url()`, no `@import`, no webfont from any origin.** Those are the
 *   exfiltration and the tracking vectors, and a public page fetching a font
 *   from a third party tells that third party who read it. Every face below is a
 *   system stack, so a themed page makes no request it would not otherwise make.
 * - **No positioning, sizing, z-index, opacity or overflow.** These are what a
 *   theme would need to cover the viewport, hide a byline, or float fake chrome
 *   over real chrome. None of them is expressible.
 * - **No independent choice of background and foreground.** This is the one that
 *   does the most work, and it is worth stating as a design rule rather than as
 *   a restriction: **a person picks a paper, not two colours.** `surface` ships
 *   `bg`, `panel`, `ink`, `inkDim` and `line` as a set that was authored
 *   together and is contrast-checked in `theme.test.ts`. A theme therefore
 *   cannot make text the colour of its own background — which is the only way,
 *   in a vocabulary with no positioning, to hide an author's name. Wave's worst
 *   failure was letting content masquerade as somebody else's words; a theme
 *   that could hide a byline is the same bug wearing a nicer hat, and this is
 *   the property that makes it impossible rather than merely discouraged.
 * - **No ambient motion.** There is no twinkle, no marquee, no blink. The design
 *   thesis names the radar sweep as the one piece of ambient motion in the
 *   product (docs/DESIGN.md §12) and a theme that could add a second one would
 *   be overriding a decision rather than decorating within it. This is the
 *   refusal most likely to be argued with, so: it is a *product* call, not a
 *   safety one, and it is a one-line addition if the product owner disagrees.
 *
 * ## Presets are not stored
 *
 * A preset sets all nine axes at once and is then forgotten. The nine values are
 * the only state. That way a preset can be retired, renamed or re-tuned without
 * orphaning a radar that was styled with it, and "which preset is this?" never
 * becomes a second source of truth that can disagree with the first.
 */

import { isOwnKey, ownValue } from './own.js';

/* -------------------------------------------------------------------------- */
/* Surfaces                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A paper: the ground and the ink that goes on it, authored as one set.
 *
 * `ink` is body text, `inkDim` is the instrument voice and the metadata, `line`
 * is every rule and border, `panel` is anything raised off the ground. All five
 * are ours. See the contrast assertions in `theme.test.ts` — they are what makes
 * the "a theme cannot hide a byline" claim true rather than merely intended.
 */
export interface RadarSurfaceDef {
  readonly label: string;
  readonly bg: string;
  readonly panel: string;
  readonly ink: string;
  readonly inkDim: string;
  readonly line: string;
  /** Whether the page's own colour scheme reads light or dark, for form controls. */
  readonly scheme: 'light' | 'dark';
}

export const RADAR_SURFACES = {
  default: {
    label: 'On My Radar',
    bg: '',
    panel: '',
    ink: '',
    inkDim: '',
    line: '',
    scheme: 'dark',
  },
  paper: {
    label: 'Paper',
    bg: '#fbfaf7',
    panel: '#ffffff',
    ink: '#1c1a17',
    inkDim: '#5d5850',
    line: '#e2ded6',
    scheme: 'light',
  },
  parchment: {
    label: 'Parchment',
    bg: '#f2e8d5',
    panel: '#f8f1e3',
    ink: '#2b2318',
    inkDim: '#6b5c45',
    line: '#d9c9ab',
    scheme: 'light',
  },
  noir: {
    label: 'Noir',
    bg: '#0b0b0c',
    panel: '#141416',
    ink: '#ece9e4',
    inkDim: '#9b968e',
    line: '#2a2a2d',
    scheme: 'dark',
  },
  fog: {
    label: 'Fog',
    bg: '#eef1f4',
    panel: '#ffffff',
    ink: '#1b2430',
    inkDim: '#586474',
    line: '#d3dae1',
    scheme: 'light',
  },
  terminal: {
    label: 'Terminal',
    bg: '#04120a',
    panel: '#07200f',
    ink: '#7dffa8',
    inkDim: '#3fbd6d',
    line: '#12492a',
    scheme: 'dark',
  },
  blueprint: {
    label: 'Blueprint',
    bg: '#0b2545',
    panel: '#123059',
    ink: '#d8ecff',
    inkDim: '#8fb8dd',
    line: '#1e4879',
    scheme: 'dark',
  },
  bubblegum: {
    label: 'Bubblegum',
    bg: '#fdeef6',
    panel: '#ffffff',
    ink: '#3d1030',
    inkDim: '#8a4a72',
    line: '#f3cfe2',
    scheme: 'light',
  },
  mint: {
    label: 'Mint',
    bg: '#eaf7f1',
    panel: '#ffffff',
    ink: '#12312a',
    inkDim: '#4c7a6c',
    line: '#c7e5d8',
    scheme: 'light',
  },
  dusk: {
    label: 'Dusk',
    bg: '#1a1030',
    panel: '#241645',
    ink: '#f0e6ff',
    inkDim: '#a894cc',
    line: '#3a2666',
    scheme: 'dark',
  },
} as const satisfies Record<string, RadarSurfaceDef>;

export type RadarSurface = keyof typeof RADAR_SURFACES;
export const RADAR_SURFACE_KEYS = Object.keys(RADAR_SURFACES) as RadarSurface[];

/* -------------------------------------------------------------------------- */
/* The other eight axes                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Background texture. Every one of these is drawn with CSS gradients in
 * `styles.css` — there is no image, no data URI and no request. That is not a
 * performance choice: a pattern that could name a file is a pattern that could
 * name a host.
 */
export const THEME_PATTERNS = {
  none: 'None',
  grid: 'Graph paper',
  dots: 'Dots',
  stripes: 'Stripes',
  checks: 'Checks',
  stars: 'Stars',
  scanlines: 'Scanlines',
  weave: 'Weave',
} as const;
export type ThemePattern = keyof typeof THEME_PATTERNS;
export const THEME_PATTERN_KEYS = Object.keys(THEME_PATTERNS) as ThemePattern[];

/**
 * The reading face. System stacks only, for the reason in the file header: a
 * webfont is a request to somebody else's server, made by a page a stranger
 * loaded, and `font-src 'self'` on the public route is what keeps that true even
 * if somebody later adds an axis without thinking about it.
 */
export const THEME_BODY_FONTS = {
  serif: 'Serif',
  sans: 'Sans',
  mono: 'Monospace',
  marker: 'Marker',
  poster: 'Poster',
} as const;
export type ThemeBodyFont = keyof typeof THEME_BODY_FONTS;
export const THEME_BODY_FONT_KEYS = Object.keys(THEME_BODY_FONTS) as ThemeBodyFont[];

/**
 * The instrument voice — labels, timestamps, tag rows, counts.
 *
 * Kept as its own axis rather than folded into `bodyFont` because the tension
 * between the two faces *is* the product's identity (docs/DESIGN.md §12), and a
 * theme should be able to lean into it or step away from it deliberately rather
 * than by accident.
 */
export const THEME_CHROME_FONTS = {
  mono: 'Monospace',
  sans: 'Sans',
  serif: 'Serif',
} as const;
export type ThemeChromeFont = keyof typeof THEME_CHROME_FONTS;
export const THEME_CHROME_FONT_KEYS = Object.keys(THEME_CHROME_FONTS) as ThemeChromeFont[];

export const THEME_CORNERS = { sharp: 'Sharp', soft: 'Soft', round: 'Round' } as const;
export type ThemeCorners = keyof typeof THEME_CORNERS;
export const THEME_CORNER_KEYS = Object.keys(THEME_CORNERS) as ThemeCorners[];

/** What sits between one post and the next. */
export const THEME_RULES = {
  hairline: 'Hairline',
  none: 'Nothing',
  dashed: 'Dashed',
  double: 'Double',
  ornament: 'Ornament',
} as const;
export type ThemeRule = keyof typeof THEME_RULES;
export const THEME_RULE_KEYS = Object.keys(THEME_RULES) as ThemeRule[];

export const THEME_DENSITIES = { cosy: 'Cosy', roomy: 'Roomy' } as const;
export type ThemeDensity = keyof typeof THEME_DENSITIES;
export const THEME_DENSITY_KEYS = Object.keys(THEME_DENSITIES) as ThemeDensity[];

/**
 * The pointer.
 *
 * A fixed list of CSS keywords and nothing else — never `url()`, which is what
 * a custom cursor would need and which is both a request to another host and a
 * way to draw something that is not where the pointer is. The keywords are
 * harmless and the nod to 1998 is free.
 */
export const THEME_CURSORS = {
  default: 'Arrow',
  pointer: 'Hand',
  crosshair: 'Crosshair',
  help: 'Question mark',
  cell: 'Cell',
} as const;
export type ThemeCursor = keyof typeof THEME_CURSORS;
export const THEME_CURSOR_KEYS = Object.keys(THEME_CURSORS) as ThemeCursor[];

/** How the radar's own name is set at the top of the page. */
export const THEME_HEADLINES = {
  plain: 'Plain',
  underline: 'Underlined',
  blocked: 'Blocked',
  outline: 'Outlined',
  shadow: 'Drop shadow',
} as const;
export type ThemeHeadline = keyof typeof THEME_HEADLINES;
export const THEME_HEADLINE_KEYS = Object.keys(THEME_HEADLINES) as ThemeHeadline[];

/* -------------------------------------------------------------------------- */
/* The theme itself                                                           */
/* -------------------------------------------------------------------------- */

export interface RadarTheme {
  surface: RadarSurface;
  pattern: ThemePattern;
  bodyFont: ThemeBodyFont;
  chromeFont: ThemeChromeFont;
  corners: ThemeCorners;
  rule: ThemeRule;
  density: ThemeDensity;
  cursor: ThemeCursor;
  headline: ThemeHeadline;
}

/** The product's own look. A radar with no theme stored resolves to exactly this. */
export const DEFAULT_RADAR_THEME: RadarTheme = {
  surface: 'default',
  pattern: 'none',
  bodyFont: 'serif',
  chromeFont: 'mono',
  corners: 'soft',
  rule: 'hairline',
  density: 'cosy',
  cursor: 'default',
  headline: 'plain',
};

/**
 * Every axis, as data the picker and the MCP tool can both enumerate.
 *
 * One table rather than nine hand-written blocks in the SPA and nine more in the
 * tool schema: adding an axis is a line here and both surfaces grow it. The
 * `hint` is what a person reads under the control and what an agent reads in the
 * tool description, so it is written once and says the same thing to both.
 */
export const THEME_AXES = [
  {
    key: 'surface',
    label: 'Paper',
    hint: 'The ground and the ink on it. Chosen as a pair, so text is always readable.',
    options: RADAR_SURFACE_KEYS,
    labelFor: (value: string) => ownValue(RADAR_SURFACES, value)?.label ?? value,
  },
  {
    key: 'pattern',
    label: 'Pattern',
    hint: 'A texture behind the posts. Drawn in CSS — never an image, never a request.',
    options: THEME_PATTERN_KEYS,
    labelFor: (value: string) => ownValue(THEME_PATTERNS, value) ?? value,
  },
  {
    key: 'bodyFont',
    label: 'Reading face',
    hint: 'What the posts are set in.',
    options: THEME_BODY_FONT_KEYS,
    labelFor: (value: string) => ownValue(THEME_BODY_FONTS, value) ?? value,
  },
  {
    key: 'chromeFont',
    label: 'Instrument face',
    hint: 'Labels, timestamps and tags — the quiet voice around the writing.',
    options: THEME_CHROME_FONT_KEYS,
    labelFor: (value: string) => ownValue(THEME_CHROME_FONTS, value) ?? value,
  },
  {
    key: 'corners',
    label: 'Corners',
    hint: 'How hard the edges are.',
    options: THEME_CORNER_KEYS,
    labelFor: (value: string) => ownValue(THEME_CORNERS, value) ?? value,
  },
  {
    key: 'rule',
    label: 'Between posts',
    hint: 'What separates one post from the next.',
    options: THEME_RULE_KEYS,
    labelFor: (value: string) => ownValue(THEME_RULES, value) ?? value,
  },
  {
    key: 'density',
    label: 'Spacing',
    hint: 'How much air the posts get.',
    options: THEME_DENSITY_KEYS,
    labelFor: (value: string) => ownValue(THEME_DENSITIES, value) ?? value,
  },
  {
    key: 'cursor',
    label: 'Pointer',
    hint: 'A CSS keyword. Custom cursor images are refused — they need a URL.',
    options: THEME_CURSOR_KEYS,
    labelFor: (value: string) => ownValue(THEME_CURSORS, value) ?? value,
  },
  {
    key: 'headline',
    label: 'Headline',
    hint: "How the radar's own name is set.",
    options: THEME_HEADLINE_KEYS,
    labelFor: (value: string) => ownValue(THEME_HEADLINES, value) ?? value,
  },
] as const satisfies ReadonlyArray<{
  key: keyof RadarTheme;
  label: string;
  hint: string;
  options: readonly string[];
  labelFor: (value: string) => string;
}>;

export const THEME_AXIS_KEYS = THEME_AXES.map((axis) => axis.key);

/**
 * Whatever is in the database, made into a whole theme.
 *
 * Never throws and never returns a partial: an unknown key, a missing key, a
 * number where a string should be, `null`, an array — all of it falls back for
 * that one axis while the rest of the theme survives. Same rule as
 * `templateFor`, and for the same reason: a radar must not become unreadable
 * because a value it was stored with is no longer in the registry.
 *
 * **This is the only function that turns a stored value into a rendered one**,
 * which is what makes "nothing a caller supplies reaches CSS" checkable in one
 * place rather than asserted about several.
 *
 * `base` is what an unrecognised axis falls back *to*. It defaults to the
 * product's own look, which is right when reading a row; a patch passes the
 * theme already stored, so a rejected value leaves what was there rather than
 * resetting it. Without that, sending one bad axis alongside eight good ones
 * would silently wipe a look somebody had chosen.
 */
export function themeFor(stored: unknown, base: RadarTheme = DEFAULT_RADAR_THEME): RadarTheme {
  const input = (stored ?? {}) as Record<string, unknown>;
  const out = { ...base };
  for (const axis of THEME_AXES) {
    const value = input[axis.key];
    if (typeof value === 'string' && (axis.options as readonly string[]).includes(value)) {
      // Safe: `value` has just been proved to be one of this axis's own options.
      (out as Record<string, string>)[axis.key] = value;
    }
  }
  return out;
}

/** Whether a radar is styled at all, for the "reset" affordance and the DTO. */
export function isDefaultTheme(theme: RadarTheme): boolean {
  return THEME_AXIS_KEYS.every((key) => theme[key] === DEFAULT_RADAR_THEME[key]);
}

/* -------------------------------------------------------------------------- */
/* Presets                                                                    */
/* -------------------------------------------------------------------------- */

export interface ThemePresetDef {
  readonly label: string;
  readonly blurb: string;
  readonly theme: RadarTheme;
}

/**
 * Starting points, spanning the two directions the product owner named — "super clean and
 * modern" and "fun and retro, a throwback to the old web" — because both are
 * legitimate and a blank canvas is neither.
 *
 * Not stored. Picking one writes the nine axes and the preset id is discarded.
 */
export const THEME_PRESETS = {
  plain: {
    label: 'Plain',
    blurb: "On My Radar's own look. Ink on an instrument panel.",
    theme: DEFAULT_RADAR_THEME,
  },
  paper: {
    label: 'Paper',
    blurb: 'Clean and modern. White ground, serif body, plenty of air.',
    theme: {
      surface: 'paper',
      pattern: 'none',
      bodyFont: 'serif',
      chromeFont: 'sans',
      corners: 'soft',
      rule: 'hairline',
      density: 'roomy',
      cursor: 'default',
      headline: 'plain',
    },
  },
  press: {
    label: 'Press',
    blurb: 'Editorial. Parchment, hard corners, a double rule between pieces.',
    theme: {
      surface: 'parchment',
      pattern: 'none',
      bodyFont: 'serif',
      chromeFont: 'mono',
      corners: 'sharp',
      rule: 'double',
      density: 'roomy',
      cursor: 'default',
      headline: 'underline',
    },
  },
  noir: {
    label: 'Noir',
    blurb: 'Near-black, quiet, and out of the way of the writing.',
    theme: {
      surface: 'noir',
      pattern: 'none',
      bodyFont: 'serif',
      chromeFont: 'mono',
      corners: 'sharp',
      rule: 'hairline',
      density: 'roomy',
      cursor: 'default',
      headline: 'plain',
    },
  },
  studio: {
    label: 'Studio',
    blurb: 'Cool grey, sans throughout, soft edges. Modern and unfussy.',
    theme: {
      surface: 'fog',
      pattern: 'none',
      bodyFont: 'sans',
      chromeFont: 'sans',
      corners: 'round',
      rule: 'hairline',
      density: 'roomy',
      cursor: 'default',
      headline: 'plain',
    },
  },
  terminal: {
    label: 'Terminal',
    blurb: 'Phosphor green on black, scanlines, everything monospaced.',
    theme: {
      surface: 'terminal',
      pattern: 'scanlines',
      bodyFont: 'mono',
      chromeFont: 'mono',
      corners: 'sharp',
      rule: 'dashed',
      density: 'cosy',
      cursor: 'cell',
      headline: 'blocked',
    },
  },
  blueprint: {
    label: 'Blueprint',
    blurb: 'Graph paper in draughtsman blue.',
    theme: {
      surface: 'blueprint',
      pattern: 'grid',
      bodyFont: 'mono',
      chromeFont: 'mono',
      corners: 'sharp',
      rule: 'hairline',
      density: 'cosy',
      cursor: 'crosshair',
      headline: 'outline',
    },
  },
  geocities: {
    label: 'Geocities',
    blurb: 'Stars, a marker pen and a hand cursor. 1998, and unapologetic.',
    theme: {
      surface: 'bubblegum',
      pattern: 'stars',
      bodyFont: 'marker',
      chromeFont: 'sans',
      corners: 'round',
      rule: 'ornament',
      density: 'cosy',
      cursor: 'help',
      headline: 'shadow',
    },
  },
  arcade: {
    label: 'Arcade',
    blurb: 'Deep dusk, checks, and a poster face for the name.',
    theme: {
      surface: 'dusk',
      pattern: 'checks',
      bodyFont: 'sans',
      chromeFont: 'mono',
      corners: 'round',
      rule: 'none',
      density: 'cosy',
      cursor: 'pointer',
      headline: 'blocked',
    },
  },
  garden: {
    label: 'Garden',
    blurb: 'Mint, a soft weave, and room to breathe.',
    theme: {
      surface: 'mint',
      pattern: 'weave',
      bodyFont: 'sans',
      chromeFont: 'sans',
      corners: 'round',
      rule: 'none',
      density: 'roomy',
      cursor: 'default',
      headline: 'plain',
    },
  },
} as const satisfies Record<string, ThemePresetDef>;

export type ThemePreset = keyof typeof THEME_PRESETS;
export const THEME_PRESET_KEYS = Object.keys(THEME_PRESETS) as ThemePreset[];

export function isThemePreset(value: unknown): value is ThemePreset {
  return isOwnKey(THEME_PRESETS, value);
}

/**
 * The preset a theme currently matches, if it matches one exactly.
 *
 * Derived rather than stored, which is the whole point: nudge one axis after
 * picking Geocities and the picker stops claiming you are on Geocities, because
 * you are not. A second stored field would have gone on saying you were.
 */
export function presetOf(theme: RadarTheme): ThemePreset | null {
  return (
    THEME_PRESET_KEYS.find((key) =>
      THEME_AXIS_KEYS.every((axis) => THEME_PRESETS[key].theme[axis] === theme[axis]),
    ) ?? null
  );
}
