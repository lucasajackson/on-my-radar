/**
 * How a radar looks: its accent and its glyph, chosen without a wall of swatches.
 *
 * ## The problem this exists to solve
 *
 * The settings dialog used to draw every accent and every glyph as two flat
 * wraps. At ten colours and sixteen glyphs that was fine — twenty-six small
 * targets you take in at a glance. At twenty-six and forty-eight it is seventy-
 * four, which on a 390px phone is roughly eleven rows of undifferentiated dots
 * sitting between the template grid and the delete button. The dialog stops
 * being a form and becomes a scroll.
 *
 * So the set grows and the *surface* does not:
 *
 * - **Closed by default.** What you see at rest is one line: the glyph, drawn in
 *   the accent, and the two names. That is the answer to "what does this radar
 *   look like", which is the question the dialog is actually asking — and it is
 *   one row instead of eleven.
 * - **One panel at a time.** Colour and Glyph are separate disclosures and
 *   opening one closes the other, so the dialog never grows by more than a
 *   single panel however many tokens are added later.
 * - **Grouped, with the family named.** Six short labelled rows beat one long
 *   wrap: you can find the warm ones without reading the cold ones.
 * - **Searchable.** Forty-eight glyphs is past the size where scanning is
 *   faster than typing. The match rule lives in the contract (`matchesGlyphQuery`)
 *   rather than here, so "science" finds the flask for an agent as well as for a
 *   person.
 *
 * The whole thing is one component in its own file rather than two blocks inside
 * `radar-dialogs.tsx`, because the create dialog wants exactly the same control
 * and had its own copy of the flat version.
 */
import { useMemo, useState } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import {
  ACCENT_FAMILIES,
  DEFAULT_RADAR_GLYPH,
  ACCENT_FAMILY_KEYS,
  GLYPH_GROUPS,
  GLYPH_GROUP_KEYS,
  accentFor,
  accentsInFamily,
  glyphFor,
  glyphsInGroup,
  matchesAccentQuery,
  matchesGlyphQuery,
  type RadarAccent,
  type RadarGlyph as GlyphName,
} from '@onmyradar/contract';
import { accentStyle } from '../lib/theme';
import { AccentSwatch, RadarGlyph } from './primitives';

type Panel = 'accent' | 'glyph' | null;

export function AppearancePicker({
  accent,
  glyph = DEFAULT_RADAR_GLYPH,
  onAccent,
  onGlyph,
  label = 'Appearance',
  bounded = true,
}: {
  accent: string;
  glyph?: string;
  onAccent: (accent: RadarAccent) => void;
  /**
   * Omitted where the glyph is not the caller's to set — the new-topic dialog
   * offers a colour and nothing else. The Glyph disclosure disappears with it
   * rather than opening onto a control that changes nothing, and the preview
   * still draws a mark so the row reads as a look rather than as a swatch.
   */
  onGlyph?: (glyph: GlyphName) => void;
  /**
   * The create dialog and the settings page word it slightly differently, and
   * `null` drops it entirely — on the settings page the section heading above
   * already says Mark, and two labels for one control is the kind of small
   * doubling that makes a screen read as assembled rather than designed.
   */
  label?: string | null;
  /**
   * Whether the open panel caps its own height and scrolls.
   *
   * True inside a dialog, where an uncapped panel pushes the dialog's Save off
   * the bottom of a phone. **False on `/radar/$radarId/settings`**, where there
   * is no dialog Save to protect and the cap was one of three nested scroll
   * regions stacked vertically — the mechanism behind the settings surface
   * feeling like a mess. A scrollbar inside a scrollbar is not a bound, it is a
   * second thing for a swipe to hit.
   */
  bounded?: boolean;
}) {
  const [panel, setPanel] = useState<Panel>(null);
  const [query, setQuery] = useState('');

  const open = (next: Exclude<Panel, null>) => {
    // Opening one closes the other, and re-opening always starts from an empty
    // search — a stale filter left over from the last visit reads as a set that
    // has lost half its members.
    setQuery('');
    setPanel((current) => (current === next ? null : next));
  };

  const accentDef = accentFor(accent);
  const glyphDef = glyphFor(glyph);

  return (
    <div className="flex flex-col gap-2">
      {label ? <span className="instrument">{label}</span> : null}

      <div className="picker-summary" style={accentStyle(accent)}>
        <span className="picker-preview" aria-hidden="true">
          <RadarGlyph glyph={glyph} className="h-5 w-5" />
        </span>
        <span className="picker-summary-names">
          {onGlyph ? `${accentDef.label} · ${glyphDef.label}` : accentDef.label}
        </span>
        <div className="picker-summary-actions">
          <PanelButton open={panel === 'accent'} onClick={() => open('accent')}>
            Colour
          </PanelButton>
          {onGlyph ? (
            <PanelButton open={panel === 'glyph'} onClick={() => open('glyph')}>
              Glyph
            </PanelButton>
          ) : null}
        </div>
      </div>

      {panel ? (
        <div className={`picker-panel ${bounded ? '' : 'is-unbounded'}`}>
          <PickerSearch
            value={query}
            onChange={setQuery}
            placeholder={panel === 'accent' ? 'Find a colour…' : 'Find a glyph…'}
          />
          {panel === 'accent' || !onGlyph ? (
            <AccentGroups query={query} accent={accent} onAccent={onAccent} />
          ) : (
            <GlyphGroups query={query} glyph={glyph} accent={accent} onGlyph={onGlyph} />
          )}
        </div>
      ) : null}
    </div>
  );
}

function PanelButton({
  open,
  onClick,
  children,
}: {
  open: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button type="button" className="picker-toggle" aria-expanded={open} onClick={onClick}>
      {children}
      <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
  );
}

function PickerSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-[color:var(--paper-faint)]" />
      <input
        className="field field-sm pl-8"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      {value ? (
        <button
          type="button"
          className="absolute top-1/2 right-2 -translate-y-1/2 p-1 text-[color:var(--paper-faint)] hover:text-[color:var(--paper)]"
          aria-label="Clear search"
          onClick={() => onChange('')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

function AccentGroups({
  query,
  accent,
  onAccent,
}: {
  query: string;
  accent: string;
  onAccent: (accent: RadarAccent) => void;
}) {
  // A family with nothing left in it after the search is not drawn at all: an
  // empty labelled row reads as a rendering fault rather than as no matches.
  const families = useMemo(
    () =>
      ACCENT_FAMILY_KEYS.map((family) => ({
        family,
        keys: accentsInFamily(family).filter((key) => matchesAccentQuery(key, query)),
      })).filter((group) => group.keys.length > 0),
    [query],
  );

  if (families.length === 0) return <NoMatches noun="colour" />;

  return (
    <div className="picker-groups">
      {families.map(({ family, keys }) => (
        <div key={family} className="picker-group">
          <span className="instrument picker-group-label">{ACCENT_FAMILIES[family]}</span>
          <div className="picker-row">
            {keys.map((key) => (
              <button
                key={key}
                type="button"
                className="picker-swatch"
                title={accentFor(key).label}
                aria-label={accentFor(key).label}
                aria-pressed={accent === key}
                onClick={() => onAccent(key)}
              >
                <AccentSwatch accent={key} active={accent === key} />
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function GlyphGroups({
  query,
  glyph,
  accent,
  onGlyph,
}: {
  query: string;
  glyph: string;
  accent: string;
  onGlyph: (glyph: GlyphName) => void;
}) {
  const groups = useMemo(
    () =>
      GLYPH_GROUP_KEYS.map((group) => ({
        group,
        keys: glyphsInGroup(group).filter((key) => matchesGlyphQuery(key, query)),
      })).filter((entry) => entry.keys.length > 0),
    [query],
  );

  if (groups.length === 0) return <NoMatches noun="glyph" />;

  return (
    <div className="picker-groups" style={accentStyle(accent)}>
      {groups.map(({ group, keys }) => (
        <div key={group} className="picker-group">
          <span className="instrument picker-group-label">{GLYPH_GROUPS[group]}</span>
          <div className="picker-row">
            {keys.map((key) => (
              <button
                key={key}
                type="button"
                className={`picker-glyph ${glyph === key ? 'is-active' : ''}`}
                title={glyphFor(key).label}
                aria-label={glyphFor(key).label}
                aria-pressed={glyph === key}
                onClick={() => onGlyph(key)}
              >
                <RadarGlyph glyph={key} className="h-4 w-4" />
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function NoMatches({ noun }: { noun: string }) {
  return (
    <p className="note py-2">No {noun} by that name. Try a shorter word, or clear the search.</p>
  );
}
