import { Select } from './select';
/**
 * Choosing how a radar looks.
 *
 * Nine axes is a lot of controls, and the settings dialog was already the
 * longest screen in the product before any of them existed. So the same shape as
 * `AppearancePicker`: closed at rest, one panel when open, and the panel leads
 * with the answer most people want.
 *
 * - **Presets first.** Nobody wants to compose a look out of nine dropdowns.
 *   Eight named starting points cover both directions the product owner asked for — clean
 *   and modern, and fun and retro — and picking one writes all nine axes.
 * - **Fine tuning second, and folded.** The axes are there for anybody who wants
 *   them and out of the way of everybody who does not.
 * - **A live preview, always.** You cannot pick a paper from the word
 *   "parchment". The preview is a real `.radar-theme` container with a real
 *   post-shaped fragment inside it, so what it shows is what the page does —
 *   the same CSS, not an approximation of it.
 *
 * The preset shown is **derived** (`presetOf`), never stored: nudge one axis
 * after picking Geocities and the row stops claiming you are on Geocities,
 * because you are not.
 */
import { useState } from 'react';
import { ChevronDown, RotateCcw } from 'lucide-react';
import {
  DEFAULT_RADAR_THEME,
  RADAR_SURFACES,
  THEME_AXES,
  THEME_PRESETS,
  THEME_PRESET_KEYS,
  isDefaultTheme,
  presetOf,
  themeFor,
  type RadarTheme,
  type ThemePreset,
} from '@onmyradar/contract';
import { accentStyle, themeAttrs, themeStyle } from '../lib/theme';
import { entry } from '../lib/registry';

export function ThemePicker({
  theme,
  accent,
  radarName,
  onChange,
  label = 'Style',
  bounded = true,
}: {
  theme: RadarTheme;
  /** The preview shows the radar's real accent, since the theme sits under it. */
  accent: string;
  radarName: string;
  onChange: (theme: RadarTheme) => void;
  /** `null` where a section heading already says it. See `AppearancePicker`. */
  label?: string | null;
  /** See `AppearancePicker` — false on the settings page, which is the scroller. */
  bounded?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [tuning, setTuning] = useState(false);

  const preset = presetOf(theme);
  const surface = entry(RADAR_SURFACES, theme.surface);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        {label ? <span className="instrument">{label}</span> : <span />}
        {!isDefaultTheme(theme) ? (
          <button
            type="button"
            className="instrument flex items-center gap-1 hover:text-[color:var(--paper)]"
            onClick={() => onChange({ ...DEFAULT_RADAR_THEME })}
          >
            <RotateCcw className="h-3 w-3" />
            Reset
          </button>
        ) : null}
      </div>

      <ThemePreview theme={theme} accent={accent} radarName={radarName} />

      <button
        type="button"
        className="picker-toggle self-start"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {preset ? THEME_PRESETS[preset].label : (surface?.label ?? 'Custom')}
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open ? (
        <div className={`picker-panel ${bounded ? '' : 'is-unbounded'}`}>
          <div className="theme-preset-grid">
            {THEME_PRESET_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={preset === key}
                className={`template-card ${preset === key ? 'is-active' : ''}`}
                onClick={() => onChange({ ...THEME_PRESETS[key].theme })}
              >
                <span className="template-card-name">{THEME_PRESETS[key].label}</span>
                <span className="template-card-blurb">{THEME_PRESETS[key].blurb}</span>
                <ThemeChips preset={key} />
              </button>
            ))}
          </div>

          <button
            type="button"
            className="picker-toggle self-start"
            aria-expanded={tuning}
            onClick={() => setTuning((v) => !v)}
          >
            Fine tune
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${tuning ? 'rotate-180' : ''}`}
            />
          </button>

          {tuning ? (
            <div className="picker-groups">
              {THEME_AXES.map((axis) => (
                <label key={axis.key} className="flex flex-col gap-1">
                  <span className="instrument picker-group-label">{axis.label}</span>
                  <Select
                    className="field field-sm"
                    value={theme[axis.key]}
                    onValueChange={(value) =>
                      // Through `themeFor` rather than trusted: the select can
                      // only offer registry values, but the one function that
                      // decides what a valid theme is should be the only one
                      // that ever produces one.
                      onChange(themeFor({ ...theme, [axis.key]: value }))
                    }
                    options={axis.options.map((option) => ({
                      value: option,
                      label: axis.labelFor(option),
                    }))}
                  />
                  <span className="theme-axis-hint">{axis.hint}</span>
                </label>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Three swatches off a preset's paper, so nine cards are not nine identical
 * boxes with different words in them.
 *
 * Ground, rule, ink — not ground, panel, ink. A surface's panel is a shade off
 * its ground by design, so drawing both put two near-identical squares next to
 * each other and wasted a third of the only colour signal the card has.
 */
function ThemeChips({ preset }: { preset: ThemePreset }) {
  const surface = RADAR_SURFACES[THEME_PRESETS[preset].theme.surface];
  return (
    <span className="theme-chips" aria-hidden="true">
      {[
        surface.bg || 'var(--ink-900)',
        surface.line || 'var(--line)',
        surface.ink || 'var(--paper)',
      ].map((colour, at) => (
        <span key={at} className="theme-chip" style={{ background: colour }} />
      ))}
    </span>
  );
}

/**
 * A real themed container with a post-shaped fragment inside it.
 *
 * Deliberately the same classes the page uses — `.radar-theme`, `.instrument`,
 * `.blip-body`, `.theme-headline` — so this is the CSS the reader will get
 * rather than a drawing of it. A preview built from bespoke markup is a preview
 * that can be right about a theme the page renders wrongly.
 */
function ThemePreview({
  theme,
  accent,
  radarName,
}: {
  theme: RadarTheme;
  accent: string;
  radarName: string;
}) {
  return (
    <div
      className="radar-theme theme-preview"
      // The accent inline, because the preview is not inside the radar's own
      // accent container the way the real page is.
      style={{ ...accentStyle(accent), ...themeStyle(theme) }}
      {...themeAttrs(theme)}
    >
      <div className="theme-preview-head">
        <span className="theme-headline text-[15px] font-semibold">
          {radarName || 'Your radar'}
        </span>
        <span className="instrument attribution">a public radar · by you</span>
      </div>
      {/* Two posts, because the rule between them is one of the nine axes and a
          single post cannot show it. Both one line long, because a preview whose
          last line is sliced in half by its own height cap reads as a bug rather
          than as a sample. */}
      <div className="theme-preview-post">
        <span className="instrument">2h · note</span>
        <p className="blip-body">Ink on an instrument panel.</p>
      </div>
      <div className="theme-preview-post">
        <span className="instrument">yesterday · note</span>
        <p className="blip-body">Capture has to be cheaper than the thought.</p>
      </div>
    </div>
  );
}
