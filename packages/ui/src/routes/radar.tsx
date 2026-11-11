import { LinkedBlip } from '../components/linked-blip';
import { QueryError } from '../components/query-error';
/** A single radar: its bearing strip, the capture box, and whatever its template makes of the blips. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearch, useNavigate, useRouter } from '@tanstack/react-router';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Settings2, Target } from 'lucide-react';
import { archiveSearchFor, archivesFor, templateFor } from '@onmyradar/contract';
import { api } from '../lib/api';
import { accentStyle } from '../lib/theme';
import { queryKeys } from '../lib/session';
import { PHONE_QUERY, useMediaQuery } from '../lib/viewport';
import { FilterBar, type StreamFilters } from '../components/blips';
import { Composer } from '../components/composer';
import { BearingStrip, RadarGlyph, Spinner, Empty } from '../components/primitives';
import { TemplateView, paneFor } from '../templates';
import { RadarLayout } from '../components/radar-layout';
import { RadarSurface } from '../components/radar-surface';
import { useDocumentTitle } from '../lib/title';
import { useLivePoll } from '../lib/polling';
import { useRadarHeaderHeight } from '../lib/header-height';
import { BlipRouteContext, type BlipRoute } from '../lib/blip-route';

export function RadarRoute() {
  const { radarId } = useParams({ from: '/_app/radar/$radarId' });
  // `/blip/$blipId` is a child route; `?blip=` is where a notification points.
  const { blipId } = useParams({ strict: false });
  const { blip } = useSearch({ from: '/_app/radar/$radarId' });
  const openId = blipId ?? blip ?? null;
  const navigate = useNavigate({ from: '/radar/$radarId' });
  const router = useRouter();
  // The card whose modal a card on the page draws itself; the rest are cold loads and notification pings.
  const [owned, setOwned] = useState<string | null>(null);
  const pushed = useRef(false);
  useEffect(() => {
    if (openId) return;
    setOwned(null);
    pushed.current = false;
  }, [openId]);
  const route = useMemo<BlipRoute>(
    () => ({
      openId,
      open: (id) => {
        if (id === openId) return false;
        setOwned(id);
        pushed.current = true;
        void navigate({ to: '/radar/$radarId/blip/$blipId', params: { radarId, blipId: id } });
        return true;
      },
      close: () =>
        pushed.current
          ? router.history.back()
          : void navigate({
              to: '/radar/$radarId',
              params: { radarId },
              search: {},
              replace: true,
            }),
    }),
    [openId, navigate, router, radarId],
  );
  return (
    <BlipRouteContext.Provider value={route}>
      <RadarContent />
      {openId && owned !== openId ? (
        <LinkedBlip key={openId} id={openId} originRadarId={radarId} onClose={route.close} />
      ) : null}
    </BlipRouteContext.Provider>
  );
}
function RadarContent() {
  const { radarId } = useParams({ from: '/_app/radar/$radarId' });
  const client = useQueryClient();
  const [filters, setFilters] = useState<StreamFilters>({ q: '' });
  const [newestId, setNewestId] = useState<string | null>(null);
  const phone = useMediaQuery(PHONE_QUERY);
  const headerRef = useRadarHeaderHeight();

  const radarQuery = useQuery({
    queryKey: queryKeys.radar(radarId),
    queryFn: () => api.radars.get(radarId),
  });
  useDocumentTitle(radarQuery.data?.radar.name);

  const livePoll = useLivePoll();
  const facetsQuery = useQuery({
    queryKey: queryKeys.facets(radarId),
    queryFn: () => api.radars.facets(radarId),
    ...livePoll,
  });

  const template = templateFor(radarQuery.data?.radar.template);

  /**
   * How much of this radar has aged out, across every lane.
   *
   * Summed from the same object the board reads per lane, so the radar-level
   * line and the lane headers cannot disagree about how much is in the archive.
   */
  const archivedTotal = Object.values(facetsQuery.data?.archivedStatuses ?? {}).reduce(
    (total, count) => total + count,
    0,
  );

  const blipsQuery = useInfiniteQuery({
    queryKey: queryKeys.blips(radarId, filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.radars.blips(radarId, {
        q: filters.q || undefined,
        state: filters.state,
        // The lane rail. Sent for every template that has one — the server
        // already accepted `status` on this route; nothing was ever passing it,
        // so the lanes a reading list and a decision log declare were reachable
        // only through a dropdown on each card.
        status: filters.status,
        tag: filters.tag,
        cursor: pageParam,
        // A board needs every lane at once, so it asks for a bigger page rather
        // than paging a column at a time and showing a half-empty column.
        ...(template.layout === 'board' ? { limit: 200 } : {}),
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    ...livePoll,
  });

  const blips = useMemo(
    () => blipsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [blipsQuery.data],
  );

  const refetchAll = useCallback(async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['blips', radarId] }),
      client.invalidateQueries({ queryKey: queryKeys.facets(radarId) }),
      client.invalidateQueries({ queryKey: queryKeys.radar(radarId) }),
      client.invalidateQueries({ queryKey: queryKeys.radars }),
      // A capture may change what a smart radar resolves to, and it certainly
      // changes the tag index.
      client.invalidateQueries({ queryKey: queryKeys.allTags }),
    ]);
  }, [client, radarId]);

  if (radarQuery.isLoading) return <Spinner label="Opening radar" />;

  if (radarQuery.error && !radarQuery.data)
    return (
      <QueryError error={radarQuery.error} resource="Radar" retry={() => radarQuery.refetch()} />
    );

  const radar = radarQuery.data?.radar;
  if (!radar) {
    return (
      <Empty
        title="That radar is not here"
        hint="It may have been deleted, or the link you followed is no longer shared with you."
      />
    );
  }

  const isSmart = radar.kind === 'smart';
  // Each layout declares its own width (`PANES`): a board wants the whole of it, prose a measure, and
  // the header follows the body so the title is never off-centre above a wide one.
  const { measure, contained, rail } = paneFor(template.layout);
  // A smart radar has nowhere to put a blip: it is a saved search over other
  // radars, so the composer would be a box that throws away what you typed.
  const canCapture = radar.access.canWrite && !isSmart;
  // The header's second line, and the whole of it as one string for `title` when the line is cut short.
  const summary = isSmart
    ? `smart · ${radar.filter?.tags.map((t) => `#${t}`).join(radar.filter.match === 'all' ? ' + ' : ' / ') ?? ''}`
    : (radar.tagline ?? `${radar.blipCount} ${radar.blipCount === 1 ? 'blip' : 'blips'}`);
  const tail = [
    template.id !== 'stream' ? ` · ${template.label.toLowerCase()}` : '',
    radar.visibility === 'public' ? ' · public' : '',
    radar.access.role !== 'owner' ? ` · shared with you (${radar.access.role})` : '',
  ].join('');
  const wholeLine = `${radar.topic ? `${radar.topic.name} · ` : ''}${summary}${tail}`;

  return (
    <div style={accentStyle(radar.accent)} data-radar-column>
      {/* The theme wraps the header and the posts and stops before the dialogs
          below — a settings dialog that repainted itself while you chose the
          paper would be unreadable at the moment you needed to read it. */}
      <RadarSurface radar={radar}>
        {/* Opaque: it was 88% with a blur, and the page showed through it (and, below it, through the
            gap above the sticky tab bar). Its height is measured into `--radar-header-h`, which is
            what everything that sticks beneath it is placed by. */}
        <header
          ref={headerRef}
          className="radar-header sticky top-0 z-20"
          style={{ background: 'var(--ink-900)' }}
        >
          <div className={`mx-auto flex ${measure} items-start gap-3 px-4 pt-5 pb-3 sm:px-6`}>
            <span className="mt-0.5 text-[color:var(--accent-from)]">
              {isSmart ? (
                <Target className="h-5 w-5" />
              ) : (
                <RadarGlyph glyph={radar.glyph} className="h-5 w-5" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-[19px] leading-tight font-semibold tracking-tight">
                <span className="theme-headline">{radar.name}</span>
              </h1>
              {/* One line everywhere, with the whole of it in `title`. A tagline that wrapped made the
                  header 118px, and the tab bar under it had been placed for 100. It is the only line
                  that says what the radar is for, so what the line cuts off is still one hover (or a
                  long press) away. */}
              <p className="instrument mt-1 truncate" title={wholeLine}>
                {/*
                  Which array this radar is in, said on the radar itself.

                  It was said nowhere: the only surface that knew was the
                  settings dialog's `TopicPicker`, two clicks away and behind a
                  control you open to change something rather than to find out.
                  A grouping you cannot see from inside the thing grouped is a
                  grouping only the sidebar knows about — and on a phone there is
                  no sidebar at all.

                  Inline in this line rather than a chip of its own so the
                  one-line truncation keeps working; a flex row here would
                  break it.
                */}
                {radar.topic ? (
                  <>
                    <Link
                      to="/array/$topicId"
                      params={{ topicId: radar.topic.id }}
                      className="text-[color:var(--accent-from)] hover:underline"
                      title={`In the array ${radar.topic.name}`}
                    >
                      {radar.topic.name}
                    </Link>
                    {' · '}
                  </>
                ) : null}
                {summary}
                {tail}
              </p>
            </div>
            <div className="flex items-center gap-1">
              {/*
                One labelled way in, where there were three unlabelled 20px icons
                — webhooks (a broadcast glyph, which reads as "publish", and
                means the opposite direction), share, and settings. All three
                configured the same radar, all three opened a modal, and none of
                them said so. They are now four sections of one page, and
                "Settings" is a word rather than a guess.
              */}
              {radar.access.canManage ? (
                <Link
                  to="/radar/$radarId/settings"
                  params={{ radarId: radar.id }}
                  className="btn shrink-0"
                  aria-label="Radar settings"
                >
                  <Settings2 className="h-4 w-4" />
                  <span className="hidden sm:inline">Settings</span>
                </Link>
              ) : null}
            </div>
          </div>
          <BearingStrip timestamps={blips.map((blip) => blip.createdAt)} />
        </header>

        <RadarLayout
          measure={measure}
          contained={contained}
          rail={rail}
          // An Architecture radar proposes through its own bar: a box above the map costs the screen.
          composer={
            canCapture && template.layout !== 'architecture' ? (
              <Composer
                radarId={radar.id}
                placeholder={template.capturePlaceholder}
                linkFirst={template.capture.linkFirst === true}
                onCaptured={(blip) => {
                  // The id the server just returned. This used to refetch the first
                  // hundred rows and pick the latest `createdAt` among them, which on
                  // a queue-ordered radar past a hundred blips is the oldest hundred:
                  // the ping landed on the wrong card, or none, and every capture
                  // paid an extra round trip for it.
                  setNewestId(blip.id);
                  void refetchAll();
                }}
              />
            ) : null
          }
          filters={
            <FilterBar
              filters={filters}
              onChange={setFilters}
              states={facetsQuery.data?.states ?? {}}
              statuses={facetsQuery.data?.statuses ?? {}}
              tags={facetsQuery.data?.tags ?? []}
              template={radar}
              showTriage={template.showTriage}
            />
          }
          note={
            <>
              {isSmart && radar.access.canWrite ? (
                <p className="note">
                  This is a saved search. Capture into a real radar and tag it, and it appears here.
                </p>
              ) : null}
              {/*
            The radar-level seam, on every archiving template including the board.

            It was originally board-excluded, on the reasoning that a board says
            it per lane in its own header. A screenshot said otherwise: the lane
            budget rails Done and Blocked by default at every width below 1920,
            and those two lanes hold the entire archive — so on the default board
            the count was drawn inside a 44px rail that does not render a header
            at all, and the seam was invisible exactly where the feature exists.

            So this line is the guarantee and the lane header is the detail.
            Neither is redundant: this one is the radar, that one is the column.
          */}
              {archivesFor(radar.template) && archivedTotal > 0 ? (
                <p className="note">
                  {/* Short on purpose. The first draft carried the whole
                  reassurance — "nothing was deleted, and commenting on one
                  brings it back" — and at 390px it wrapped to three lines of
                  chrome above a board that had already been measured as having
                  270px too much. The reassurance moved into the link's own
                  title and the settings hint, where somebody who wants it will
                  be. */}
                  {archivedTotal} finished {archivedTotal === 1 ? 'blip has' : 'blips have'} aged
                  out.{' '}
                  <Link
                    to="/search"
                    search={{ q: archiveSearchFor(radar.id) }}
                    // Underlined, not just coloured: at 12.5px the accent against
                    // the light paper is nowhere near AA, so colour alone must not
                    // be what says this is the way back.
                    className="text-[color:var(--accent-from)] underline underline-offset-2"
                    title="Nothing was deleted. Commenting on an archived blip, or editing it, brings it back to the radar."
                  >
                    Open the archive &rarr;
                  </Link>
                </p>
              ) : null}
            </>
          }
        >
          {blipsQuery.error ? (
            <QueryError
              error={blipsQuery.error}
              resource="Blips"
              retry={() => blipsQuery.refetch()}
            />
          ) : null}
          {!blipsQuery.error || blips.length > 0 ? (
            <TemplateView
              layout={template.layout}
              radar={radar}
              archivedCounts={facetsQuery.data?.archivedStatuses ?? {}}
              blips={blips}
              readOnly={!radar.access.canWrite}
              loading={blipsQuery.isFetching}
              loadingMore={blipsQuery.isFetchingNextPage}
              hasMore={blipsQuery.hasNextPage}
              onLoadMore={() => void blipsQuery.fetchNextPage()}
              onChanged={() => void refetchAll()}
              newestId={newestId}
              emptyTitle={
                filters.q || filters.tag || filters.state || filters.status
                  ? 'Nothing matches'
                  : isSmart
                    ? 'Nothing carries these tags yet'
                    : radar.isDropBox
                      ? 'Drop box is empty'
                      : 'Nothing on this radar yet'
              }
              emptyHint={
                filters.q || filters.tag || filters.state || filters.status
                  ? 'Try a broader search, or clear the filters above.'
                  : isSmart
                    ? `Tag a blip ${radar.filter?.tags.map((t) => `#${t}`).join(' or ') ?? ''} in any radar and it will appear here.`
                    : radar.isDropBox
                      ? 'Drop anything here — an appointment, a reminder, a half-thought. Then ask an agent to sort it.'
                      : canCapture
                        ? // A touch device has no Cmd key. This is the same defect the product owner
                          // photographed in the composer, in prose rather than in a
                          // hint — and prose is where it survived the first fix,
                          // because it reads as copy rather than as an affordance.
                          phone
                          ? 'Tap the box above and start typing. Anything counts — a sentence, a link, a photo.'
                          : 'Type in the box above and hit cmd + enter. Anything counts — a sentence, a link, a photo.'
                        : 'The owner has not put anything here yet.'
              }
            />
          ) : null}
        </RadarLayout>
      </RadarSurface>
    </div>
  );
}
