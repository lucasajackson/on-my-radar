import { DueChip } from './due-chip';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { BlipDto } from '@onmyradar/contract';
import { ArrowUpRight, Search } from 'lucide-react';
import { api } from '../lib/api';
import { snippetFor } from '../lib/snippet';
import { plainText } from '../lib/markdown';
import { queryKeys, useRadars } from '../lib/session';
import { SearchBox } from './search-input';
import { searchThemeStyle } from '../lib/theme';

/** One search entry point; previews never alter the radar underneath. */
export function UniversalSearch() {
  const navigate = useNavigate();
  const location = useRouterState({ select: (state) => state.location });
  const routeRadar = /^\/radar\/([^/]+)$/.exec(location.pathname)?.[1];
  const onResults = location.pathname === '/search';
  const url = location.search as { q?: string; radarId?: string; preferRadarId?: string };
  const currentRadar = routeRadar ?? (onResults ? url.preferRadarId : undefined);
  const legacyScope = onResults ? url.radarId : undefined;
  const [draft, setDraft] = useState(onResults ? (url.q ?? '') : '');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [completing, setCompleting] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const { data: radarData } = useRadars();
  const radars = radarData?.radars ?? [];
  const activeRadar = radars.find((radar) => radar.id === routeRadar);
  const theme = searchThemeStyle(activeRadar);
  const suggestions = useQuery({
    queryKey: queryKeys.searchSuggest,
    queryFn: () => api.search.suggest(),
    staleTime: 60_000,
  });

  useEffect(() => {
    setDraft(onResults ? (url.q ?? '') : '');
    setOpen(false);
    setHighlight(-1);
  }, [location.pathname, url.q, currentRadar, legacyScope, onResults]);
  useEffect(() => {
    setHighlight(-1);
    const timer = setTimeout(() => setDebounced(draft.trim()), 220);
    return () => clearTimeout(timer);
  }, [draft, currentRadar, legacyScope]);

  const preview = useQuery({
    queryKey: ['search', 'preview', debounced, currentRadar ?? null, legacyScope ?? null],
    queryFn: ({ signal }) =>
      api.search.run(debounced, undefined, {
        limit: 5,
        radarId: legacyScope,
        preferRadarId: currentRadar,
        signal,
      }),
    enabled: open && debounced.length > 0 && !completing,
    staleTime: 15_000,
  });
  const waiting = draft.trim() !== debounced || preview.isPending;
  const items = waiting ? [] : (preview.data?.items ?? []);
  const preferredIds = new Set(preview.data?.preferredBlipIds ?? []);
  const groups = preview.data?.preferredRadar
    ? [
        {
          key: 'current',
          label: `In ${preview.data.preferredRadar.name}`,
          items: items.filter((blip) => preferredIds.has(blip.id)),
        },
        {
          key: 'other',
          label: 'Other radars',
          items: items.filter((blip) => !preferredIds.has(blip.id)),
        },
      ]
    : [{ key: 'all', label: 'Matching blips', items }];
  const visible = open && !!draft.trim() && !completing;
  const resultsId = 'global-search-results';
  useEffect(() => {
    if (highlight >= 0)
      document.getElementById(`${resultsId}-${highlight}`)?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);
  const submit = (blip?: BlipDto) => {
    setOpen(false);
    input.current?.blur();
    void navigate({
      to: '/search',
      search: {
        ...(draft.trim() ? { q: draft.trim() } : {}),
        ...(legacyScope ? { radarId: legacyScope } : {}),
        ...(currentRadar ? { preferRadarId: currentRadar } : {}),
        ...(blip ? { blip: blip.id } : {}),
      },
    });
  };
  return (
    <header
      className="app-search-header"
      style={theme}
      data-search-themed={theme ? 'true' : undefined}
    >
      <div
        className="universal-search"
        role="search"
        aria-label="Find blips"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
        }}
      >
        <div className="universal-search-field">
          <SearchBox
            id="global-search"
            label="Search"
            value={draft}
            onChange={(next) => {
              setDraft(next);
              setOpen(true);
            }}
            inputRef={input}
            autoFocus={false}
            placeholder={legacyScope ? 'Search this saved scope…' : 'Search all radars…'}
            radars={suggestions.data?.radars ?? []}
            people={suggestions.data?.people ?? []}
            topics={suggestions.data?.topics ?? []}
            onSuggestionsChange={setCompleting}
            onFocus={() => setOpen(true)}
            controls={visible ? resultsId : undefined}
            expanded={visible}
            activeDescendant={visible && highlight >= 0 ? `${resultsId}-${highlight}` : undefined}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Escape') {
                event.preventDefault();
                setOpen(false);
                setHighlight(-1);
              } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setOpen(true);
                if (items.length)
                  setHighlight((at) =>
                    event.key === 'ArrowDown'
                      ? (at + 1) % items.length
                      : at <= 0
                        ? items.length - 1
                        : at - 1,
                  );
              } else if (event.key === 'Enter') {
                event.preventDefault();
                submit(highlight >= 0 ? items[highlight] : undefined);
              }
            }}
          />
          {visible ? (
            <div
              className="universal-search-dropdown"
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                input.current?.focus();
                setOpen(false);
                setHighlight(-1);
              }}
            >
              <div className="universal-search-summary">
                {legacyScope ? 'Saved scoped search' : 'All radars'}
                {preview.data?.total !== undefined && !preview.data.unresolved
                  ? ` · ${preview.data.total.toLocaleString()} ${preview.data.total === 1 ? 'match' : 'matches'}`
                  : ''}
                {preview.data?.preferredRadar ? ' · current radar first' : ''}
              </div>
              {waiting ? (
                <p className="universal-search-message" role="status">
                  Searching…
                </p>
              ) : preview.error ? (
                <div className="universal-search-message" role="alert">
                  Search could not load.{' '}
                  <button
                    type="button"
                    className="search-retry"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => void preview.refetch()}
                  >
                    Try again
                  </button>
                </div>
              ) : preview.data.unresolved || preview.data.problems.length ? (
                <p className="universal-search-message" role="status">
                  Check your search filters. Press Enter for details.
                </p>
              ) : items.length === 0 ? (
                <p className="universal-search-message" role="status">
                  No matching blips. Try another search.
                </p>
              ) : null}
              {!waiting && !preview.error && items.length > 0 ? (
                <span className="sr-only" role="status">
                  {items.length} matching blips. Use arrow keys to choose, or Enter for all results.
                </span>
              ) : null}
              <div id={resultsId} role="listbox" aria-label="Search results">
                {groups
                  .filter((group) => group.items.length > 0)
                  .map((group) => (
                    <div
                      key={group.key}
                      role="group"
                      aria-label={group.label}
                      data-search-group={group.key}
                    >
                      <div className="search-group-heading">{group.label}</div>
                      {group.items.map((blip) => {
                        const index = items.indexOf(blip);
                        const title =
                          blip.email?.subject ||
                          blip.title ||
                          plainText(blip.body, 100) ||
                          'Untitled blip';
                        const snippet = snippetFor(
                          blip.email?.preview || blip.body,
                          preview.data?.text ?? '',
                          title,
                        );
                        return (
                          <div
                            key={blip.id}
                            id={`${resultsId}-${index}`}
                            role="option"
                            aria-selected={highlight === index}
                            data-search-result={blip.id}
                            className={`universal-search-result ${highlight === index ? 'is-highlighted' : ''}`}
                            onMouseDown={(event) => event.preventDefault()}
                            onMouseEnter={() => setHighlight(index)}
                            onClick={() => submit(blip)}
                          >
                            <span className="universal-search-result-title">{title}</span>
                            {snippet.segments.length > 0 ? (
                              <span className="universal-search-result-preview">
                                {snippet.clippedStart ? '…' : ''}
                                {/* Elements, as on /search: the words that matched are
                                    what a preview is for, and they were being joined
                                    back into plain text. */}
                                {snippet.segments.map((segment, at) =>
                                  segment.match ? (
                                    <mark key={at}>{segment.text}</mark>
                                  ) : (
                                    <span key={at}>{segment.text}</span>
                                  ),
                                )}
                                {snippet.clippedEnd ? '…' : ''}
                              </span>
                            ) : null}
                            <DueChip blip={blip} personal />
                            <span className="universal-search-result-radar">
                              {radars.find((radar) => radar.id === blip.radarId)?.name ?? 'Radar'}
                              {blip.archivedAt ? ' · Archived' : ''}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  ))}
              </div>
              <button
                type="button"
                className="universal-search-all"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => submit()}
              >
                <Search size={14} aria-hidden="true" /> View all results{' '}
                <ArrowUpRight size={14} aria-hidden="true" />
                <span>Enter</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
