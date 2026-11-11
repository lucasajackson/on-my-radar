import { DueChip } from '../components/due-chip';
import { EmailContent } from '../components/email-content';
import { Interpretation, Grammar, withSuggestion } from '../components/search-input';
import { QueryError } from '../components/query-error';
/** Search results share the persistent header query and URL scope. */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { type BlipDto, type RadarDto } from '@onmyradar/contract';
import { api } from '../lib/api';
import { accentStyle } from '../lib/theme';
import { queryKeys, useRadars } from '../lib/session';
import { BlipCard } from '../components/blips';
import { snippetFor } from '../lib/snippet';
import { RelativeTime } from '../components/relative-time';
import { Empty, RadarGlyph, Spinner } from '../components/primitives';
import { useDocumentTitle } from '../lib/title';

export function SearchRoute() {
  const {
    q: urlQuery,
    radarId: scopeRadarId,
    preferRadarId,
    blip: selectedBlipId,
  } = useSearch({ from: '/_app/search' });
  const navigate = useNavigate();
  useDocumentTitle(urlQuery ? `Search: ${urlQuery}` : 'Search');

  const { data: radarData } = useRadars();
  const radars = useMemo(() => radarData?.radars ?? [], [radarData]);

  const suggestQuery = useQuery({
    queryKey: queryKeys.searchSuggest,
    queryFn: () => api.search.suggest(),
    staleTime: 60_000,
  });

  const active = (urlQuery ?? '').trim();

  const results = useInfiniteQuery({
    queryKey: [...queryKeys.search(active), scopeRadarId ?? null, preferRadarId ?? null],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.search.run(active, pageParam, { radarId: scopeRadarId, preferRadarId, signal }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: active.length > 0,
  });

  const first = results.data?.pages[0];
  const blips = useMemo(
    () => results.data?.pages.flatMap((page) => page.items) ?? [],
    [results.data],
  );

  const preferredIds = new Set(
    results.data?.pages.flatMap((page) => page.preferredBlipIds ?? []) ?? [],
  );
  const groups = first?.preferredRadar
    ? [
        {
          key: 'current',
          label: `In ${first.preferredRadar.name}`,
          items: blips.filter((blip) => preferredIds.has(blip.id)),
        },
        {
          key: 'other',
          label: 'Other radars',
          items: blips.filter((blip) => !preferredIds.has(blip.id)),
        },
      ]
    : [{ key: 'all', label: 'Matching blips', items: blips }];
  const corpus = suggestQuery.data?.corpus;

  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-4 px-4 py-5 sm:px-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-[19px] leading-tight font-semibold tracking-tight">Search</h1>
        <p className="instrument">
          {scopeRadarId
            ? `in ${radars.find((radar) => radar.id === scopeRadarId)?.name ?? 'this radar'}`
            : corpus
              ? `across ${corpus.radars} ${corpus.radars === 1 ? 'radar' : 'radars'} · ${corpus.blips} ${corpus.blips === 1 ? 'blip' : 'blips'}`
              : 'across everything you can read'}
          {/* The count of every page, not the ones loaded: sent with the first. */}
          {first?.total !== undefined && !first.unresolved
            ? ` · ${first.total.toLocaleString()} ${first.total === 1 ? 'match' : 'matches'}`
            : ''}
          {first ? ` · ${first.ranking === 'relevance' ? 'by best match' : 'by most recent'}` : ''}
        </p>
      </header>

      {first ? (
        <Interpretation
          result={first}
          onSuggest={(raw, value) =>
            void navigate({
              to: '/search',
              search: {
                q: withSuggestion(urlQuery ?? '', raw, value),
                ...(scopeRadarId ? { radarId: scopeRadarId } : {}),
                ...(preferRadarId ? { preferRadarId } : {}),
              },
            })
          }
        />
      ) : null}

      {active.length === 0 ? (
        <Grammar
          onPick={(example) =>
            void navigate({
              to: '/search',
              search: {
                q: `${urlQuery ?? ''} ${example}`.trim(),
                ...(scopeRadarId ? { radarId: scopeRadarId } : {}),
                ...(preferRadarId ? { preferRadarId } : {}),
              },
            })
          }
        />
      ) : results.isLoading ? (
        <Spinner label="Looking" />
      ) : results.error ? (
        <QueryError
          error={results.error}
          resource="Search results"
          retry={() => results.refetch()}
        />
      ) : first?.unresolved ? (
        // Not an "empty" state. Nothing matched because a filter did not
        // resolve, and saying "nothing matches" here would be a lie about which
        // half of the query was wrong.
        <Empty
          title="That filter matched nothing"
          hint="The result is empty because of the filter above, not because of your words. Fix or drop it and the search will run."
        />
      ) : blips.length === 0 ? (
        <Empty
          title="Nothing matches"
          hint="Try fewer words, or drop a filter. Quoted phrases match exactly and a leading minus excludes."
        />
      ) : (
        <div className="divide-y divide-[color:var(--line-soft)]">
          {groups
            .filter((group) => group.items.length > 0)
            .map((group) => (
              <section key={group.key} aria-label={group.label} data-search-group={group.key}>
                <h2 className="search-page-group-heading">{group.label}</h2>
                {group.items.map((blip) => (
                  <Result
                    key={blip.id}
                    blip={blip}
                    selected={blip.id === selectedBlipId}
                    radar={radars.find((r) => r.id === blip.radarId)}
                    freeText={first?.text ?? ''}
                    onChanged={() => void results.refetch()}
                  />
                ))}
              </section>
            ))}
          {results.hasNextPage ? (
            <div className="flex justify-center py-4">
              <button className="btn" onClick={() => void results.fetchNextPage()}>
                More results
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/* -------------------------------- one result ------------------------------ */

/**
 * A result is an excerpt, not a blip.
 *
 * `/search?q=radar` returned 52 hits and rendered each as a full `BlipCard`, so
 * the first result — a ~700-word essay — filled the viewport and kept going and
 * you could not see the second without scrolling past all of the first. That is
 * not a list.
 *
 * So: two or three clamped lines taken from around the match, the query marked
 * inside them, and the whole blip one click away. Expanding renders the real
 * `BlipCard` rather than a fuller excerpt, because everything a blip can do —
 * its attachments, its lane control, its conversation — belongs to that
 * component and a second rendering of a blip would drift from it.
 */
function Result({
  blip,
  radar,
  freeText,
  onChanged,
  selected = false,
}: {
  selected?: boolean;
  blip: BlipDto;
  radar: RadarDto | undefined;
  /** The query with its `field:value` tokens already lifted out by the server. */
  freeText: string;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(selected);
  useEffect(() => {
    if (!selected) return;
    setExpanded(true);
    const frame = requestAnimationFrame(() => {
      const result = document.querySelector<HTMLElement>(`[data-search-result="${blip.id}"]`);
      result?.focus({ preventScroll: true });
      result?.scrollIntoView({ block: 'start' });
    });
    return () => cancelAnimationFrame(frame);
  }, [selected, blip.id]);
  const snippet = snippetFor(blip.body, freeText, blip.title);

  return (
    // Each result wears its own radar's accent, so a list gathered from nine
    // radars still reads as coming from somewhere — the same rule the tag page
    // follows.
    // `data-search-result` rather than the `data-blip-id` the card carries: a
    // result is only *sometimes* a rendered blip now, and a suite counting cards
    // to count results would report zero the moment none is expanded — which is
    // exactly what happened the first time this shipped.
    <div
      style={accentStyle(radar?.accent)}
      className="py-3"
      tabIndex={selected ? -1 : undefined}
      data-search-result={blip.id}
    >
      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        {radar ? (
          <Link
            className="instrument flex items-center gap-1.5 hover:underline"
            to="/radar/$radarId"
            params={{ radarId: radar.id }}
          >
            <span className="text-[color:var(--accent-from)]">
              <RadarGlyph glyph={radar.glyph} className="h-3.5 w-3.5" />
            </span>
            {radar.name}
          </Link>
        ) : null}
        <span className="instrument">
          <RelativeTime iso={blip.createdAt} />
        </span>
        {/* How many times the query occurs in the whole body, not in the
            excerpt — which is the number that says whether expanding is worth
            it. Suppressed at one, where it says nothing. */}
        {snippet.matches > 1 ? <span className="instrument">{snippet.matches} matches</span> : null}
        {/* The universal search spans the archive by default, which is what
            makes the archive findable at all — so a result that is no longer on
            its radar has to say so here. Without this the search is the one
            surface where archiving *is* silent: the row looks exactly like a
            live one, and clicking through to the radar would not show it. */}
        {blip.archivedAt ? (
          <span
            className="instrument text-[color:var(--paper-dim)]"
            title="This blip has aged out of its radar. It is still here, and commenting on it brings it back."
          >
            archived
          </span>
        ) : null}
      </div>

      {expanded ? (
        <BlipCard
          blip={blip}
          readOnly={!(radar?.access.canWrite ?? false)}
          onChanged={onChanged}
          {...(radar ? { template: radar } : {})}
          commentsEnabled={radar?.commentsEnabled ?? true}
          reactionsEnabled={radar?.reactionsEnabled ?? true}
        />
      ) : blip.email ? (
        <EmailContent
          blip={blip}
          compact
          previewText={snippet.segments.map((segment) => segment.text).join('')}
        />
      ) : (
        <>
          {blip.title ? (
            <h3 className="text-[15px] leading-snug font-semibold tracking-tight">{blip.title}</h3>
          ) : null}
          <p className="search-snippet">
            {snippet.clippedStart ? '…' : ''}
            {/*
              Rendered as elements, never as a string of markup. A search query
              is user input and a blip body is user content; building a
              highlighted string would mean escaping both and then injecting
              tags, which is exactly the ordering `lib/markdown.ts` exists to get
              right. There is nothing to escape if nothing is ever parsed.
            */}
            {snippet.segments.map((segment, at) =>
              segment.match ? (
                <mark key={at}>{segment.text}</mark>
              ) : (
                <span key={at}>{segment.text}</span>
              ),
            )}
            {snippet.clippedEnd ? '…' : ''}
          </p>
        </>
      )}

      {!expanded ? <DueChip blip={blip} personal /> : null}
      <button
        className="search-expand"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
        {expanded ? 'Show less' : blip.email ? 'Show notes and actions' : 'Show the whole blip'}
      </button>
    </div>
  );
}
