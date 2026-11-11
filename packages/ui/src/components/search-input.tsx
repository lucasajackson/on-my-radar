/** Shared query input, completion and explanations for search and live dashboard widgets. */
import { useCallback, useEffect, useMemo, useState, useId, type KeyboardEventHandler } from 'react';
import { Search as SearchIcon, TriangleAlert, X } from 'lucide-react';
import {
  pendingClosedFilter,
  pendingSearchFilter,
  SEARCH_HELP,
  SEARCH_COMBINATION_RULES,
  type SearchFilterDto,
  type SearchProblem,
} from '@onmyradar/contract';

export function SearchBox({
  value,
  onChange,
  inputRef,
  radars,
  people,
  topics = [],
  label = 'Search everything',
  id,
  placeholder = 'Search everything… try in:, from:, tag:',
  autoFocus = true,
  onKeyDown,
  onFocus,
  onBlur,
  onSuggestionsChange,
  controls,
  expanded,
  activeDescendant,
}: {
  value: string;
  id?: string;
  placeholder?: string;
  autoFocus?: boolean;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  onFocus?: () => void;
  onBlur?: () => void;
  onSuggestionsChange?: (visible: boolean) => void;
  controls?: string | undefined;
  expanded?: boolean;
  activeDescendant?: string | undefined;
  label?: string;
  onChange: (next: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  radars: Array<{ id: string; name: string; slug: string }>;
  people: Array<{ id: string; name: string | null; email: string }>;
  topics?: Array<{ id: string; name: string; slug: string }>;
}) {
  const suggestionId = useId();
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  /*
    Whether the person has moved into the suggestions with the arrow keys.
    Enter completes only then. Otherwise Enter is "search", even with the list
    showing: taking it to complete `is:in` into `is:inbox` left the dropdown
    open and the caret wherever the completion put it, when what was asked for
    was the results. Tab always completes.
  */
  const [navigated, setNavigated] = useState(false);

  const named = useMemo(() => pendingSearchFilter(value, caret), [value, caret]);
  /*
    `has:` / `is:` / `kind:` complete too. Their values are a closed list the
    contract owns, so a half-typed `has:` is offered what it takes rather than
    left to be reported as a fault once the search runs.
  */
  const closed = useMemo(
    () => (named ? null : pendingClosedFilter(value, caret)),
    [named, value, caret],
  );
  const pending = named ?? closed;

  const options = useMemo(() => {
    if (closed) {
      // Not the value already typed in full: offering it would take Enter away
      // from running the search, to complete a word that is already complete.
      return closed.options
        .filter((option) => option !== closed.typed.toLowerCase())
        .map((option) => ({ key: option, label: option, hint: `${closed.field}:` }));
    }
    if (!named) return [];
    const needle = named.typed.replace(/^"/, '').toLowerCase();
    const source =
      named.field !== 'from'
        ? (named.field === 'topic' ? topics : radars).map((radar) => ({
            key: radar.id,
            label: radar.name,
            hint: `#${radar.slug}`,
          }))
        : people.map((person) => ({
            key: person.id,
            label: person.name ?? person.email,
            hint: person.email,
          }));
    /*
      Prefix matches first, then anything containing the needle.

      Substring matching is what the server resolves with, so the box has to
      offer the same set or it would hide a candidate that `in:` would then
      happily match. But *ordering* is the box's own business, and a plain
      substring order is bad at short needles: typing `in:On` put "Decisions"
      above "On My Radar", because "decisi-ON-s" contains it. The phone suite
      caught that by asserting on the first completion and getting a name with
      no space in it.
    */
    const scored = source
      .map((option) => {
        const label = option.label.toLowerCase();
        const hint = option.hint.toLowerCase();
        if (label.startsWith(needle) || hint.startsWith(needle)) return { option, rank: 0 };
        if (label.includes(needle) || hint.includes(needle)) return { option, rank: 1 };
        return null;
      })
      .filter((row): row is { option: (typeof source)[number]; rank: number } => row !== null);

    return scored
      .sort((a, b) => a.rank - b.rank || a.option.label.localeCompare(b.option.label))
      .map((row) => row.option)
      .slice(0, 6);
  }, [closed, named, radars, people, topics]);

  const showSuggestions = focused && options.length > 0;
  useEffect(() => onSuggestionsChange?.(showSuggestions), [showSuggestions, onSuggestionsChange]);

  useEffect(() => {
    setHighlight(0);
    setNavigated(false);
  }, [pending?.typed, pending?.field]);

  const complete = useCallback(
    (label: string) => {
      if (!pending) return;
      // Quoted whenever it contains a space, because an unquoted value stops at
      // the first one and would silently become a filter plus a stray word.
      const value_ = /[\s|:]/.test(label) ? `"${label}"` : label;
      const next = `${value.slice(0, pending.replacementStart)}${value_} ${value.slice(caret)}`;
      onChange(next.replace(/\s+$/, ' '));
      requestAnimationFrame(() => {
        const at = pending.replacementStart + value_.length + 1;
        inputRef.current?.setSelectionRange(at, at);
        inputRef.current?.focus();
      });
    },
    [pending, value, caret, onChange, inputRef],
  );

  const track = (event: { currentTarget: HTMLInputElement }) =>
    setCaret(event.currentTarget.selectionStart ?? 0);

  return (
    <div className="relative">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-[color:var(--paper-faint)]" />
        <input
          ref={inputRef}
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showSuggestions || !!expanded}
          aria-controls={showSuggestions ? suggestionId : controls}
          aria-activedescendant={
            showSuggestions
              ? navigated
                ? `${suggestionId}-${highlight}`
                : undefined
              : activeDescendant
          }
          onFocus={() => {
            setFocused(true);
            onFocus?.();
          }}
          onBlur={() => {
            setFocused(false);
            onBlur?.();
          }}
          className="field pl-9 text-[15px]"
          value={value}
          autoFocus={autoFocus}
          spellCheck={false}
          autoComplete="off"
          placeholder={placeholder}
          aria-label={label}
          onChange={(event) => {
            setFocused(true);
            onChange(event.target.value);
            setCaret(event.target.selectionStart ?? 0);
          }}
          onKeyUp={track}
          onClick={track}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (!showSuggestions) {
              onKeyDown?.(event);
              return;
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              // The first press lands on the first suggestion, not the second.
              setHighlight((h) => (navigated ? (h + 1) % options.length : h));
              setNavigated(true);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setHighlight((h) => (h - 1 + options.length) % options.length);
              setNavigated(true);
            } else if (event.key === 'Enter' && !navigated) {
              setFocused(false);
              onKeyDown?.(event);
            } else if (event.key === 'Tab' || event.key === 'Enter') {
              const picked = options[highlight];
              if (!picked) return;
              event.preventDefault();
              complete(picked.label.includes('"') ? picked.key : picked.label);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setFocused(false);
              onKeyDown?.(event);
            } else {
              onKeyDown?.(event);
            }
          }}
        />
        {value ? (
          <button
            className="absolute top-1/2 right-2 -translate-y-1/2 p-1 text-[color:var(--paper-faint)] hover:text-[color:var(--paper)]"
            aria-label="Clear search"
            onClick={() => onChange('')}
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      {showSuggestions ? (
        <ul
          id={suggestionId}
          className="search-completions"
          role="listbox"
          aria-label="Filter suggestions"
        >
          {options.map((option, index) => (
            <li key={option.key} role="presentation">
              <button
                id={`${suggestionId}-${index}`}
                className={`search-completion ${navigated && index === highlight ? 'is-active' : ''}`}
                role="option"
                aria-selected={navigated && index === highlight}
                onMouseDown={(event) => {
                  // mousedown, not click: a click fires after blur, and by then
                  // the caret position the completion is computed from is gone.
                  event.preventDefault();
                  complete(option.label.includes('"') ? option.key : option.label);
                }}
              >
                <span>{option.label}</span>
                <span className="instrument">{option.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/* ---------------------------- what it understood --------------------------- */

/** The filters as the server read them, and anything it could not honour. */
const DATE_FIELDS = new Set(['before', 'after', 'touched', 'stale']);

/**
 * What a filter chip says. A date bound arrives as the UTC instant the server
 * resolved it to, and a raw `2026-09-19T00:00:00.000Z` is nobody's idea of a
 * date. A bound at UTC midnight is a calendar date somebody typed, so it keeps
 * that date — converting it would show the day before anywhere west of UTC.
 * Anything else (a span back from now) is an instant, shown in local time.
 */
export function chipLabel(filter: SearchFilterDto): string {
  const typed = filter.raw.split(':').slice(1).join(':');
  const label = filter.label ?? typed;
  if (!DATE_FIELDS.has(filter.field) || !filter.resolved) return label;
  const instant = new Date(label);
  if (Number.isNaN(instant.getTime())) return label;
  const midnight =
    instant.getUTCHours() === 0 && instant.getUTCMinutes() === 0 && instant.getUTCSeconds() === 0;
  const shown = midnight
    ? instant.toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' })
    : instant.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return /^\d{4}-\d{2}-\d{2}$/.test(typed) ? shown : `${shown} (${typed})`;
}

/**
 * A query with one filter token swapped for a suggested value: `has:lnk` →
 * `has:link`, keeping any `-` or `not:` in front of the field.
 */
export function withSuggestion(query: string, raw: string, value: string): string {
  const replacement = raw.replace(/:[^:]*$/, `:${value}`);
  const at = query.indexOf(raw);
  if (at < 0) return `${query} ${replacement}`.trim();
  return `${query.slice(0, at)}${replacement}${query.slice(at + raw.length)}`;
}

export function Interpretation({
  result,
  onSuggest,
}: {
  result: {
    filters: SearchFilterDto[];
    problems: readonly SearchProblem[];
    combinationRules?: readonly string[];
  };
  /** Put one of a problem's suggested values into the query in its place. */
  onSuggest?: (raw: string, value: string) => void;
}) {
  if (result.filters.length === 0 && result.problems.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {result.filters.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {result.filters.map((filter, index) => (
            <span
              key={`${filter.raw}-${index}`}
              className={`search-token ${filter.resolved ? '' : 'is-unresolved'}`}
              title={filter.raw}
            >
              <span className="instrument">{filter.field}:</span>
              {chipLabel(filter)}
            </span>
          ))}
        </div>
      ) : null}

      {result.combinationRules?.length ? (
        <details className="text-[12px] text-[color:var(--paper-dim)]">
          <summary className="cursor-pointer">How these filters combine</summary>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {result.combinationRules.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {result.problems.map((problem, index) => (
        <div key={`${problem.raw}-${index}`} className="flex flex-col gap-1.5">
          <p className="search-problem">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{problem.message}</span>
          </p>
          {onSuggest && problem.suggestions?.length ? (
            <div
              className="flex flex-wrap gap-1.5"
              role="group"
              aria-label={`Values for ${problem.raw}`}
            >
              {problem.suggestions.map((value) => (
                <button
                  key={value}
                  type="button"
                  className="search-example instrument"
                  onClick={() => onSuggest(problem.raw, value)}
                >
                  {problem.raw.replace(/:[^:]*$/, ':')}
                  {value}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------- the grammar ------------------------------- */

/** Shown on the empty screen. Read off the shared registry, never re-typed here. */
export function Grammar({ onPick }: { onPick: (example: string) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="instrument">filters</p>
      <ul className="flex flex-col gap-1">
        {SEARCH_HELP.map((row) => (
          <li key={row.field} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <button className="search-example instrument" onClick={() => onPick(row.example)}>
              {row.example}
            </button>
            <span className="text-[13px] text-[color:var(--paper-dim)]">{row.says}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[13px] leading-relaxed text-[color:var(--paper-dim)]">
        Words search the title, tags, link and body of every blip you can read, weighted in that
        order. A &ldquo;quoted phrase&rdquo; matches exactly. Use tag:bug|techdebt for either tag;
        -tag:bug or not:tag:bug excludes a filter. Negation excludes the whole alternative group.
      </p>
      <details className="text-[12px] text-[color:var(--paper-dim)]">
        <summary className="cursor-pointer">Repeated filters and activity dates</summary>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          {SEARCH_COMBINATION_RULES.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
        <p className="mt-2">
          Dates use UTC. Activity means blip edits and new comments, not reactions or edits to
          existing comments.
        </p>
      </details>
    </div>
  );
}
