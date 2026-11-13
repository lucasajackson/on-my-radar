import { QueryError } from '../components/query-error';
/** A published radar, read-only, with no application chrome around it. */
import { useMemo } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { templateFor } from '@onmyradar/contract';
import { api } from '../lib/api';
import { accentStyle } from '../lib/theme';
import { queryKeys } from '../lib/session';
import { TemplateView, paneFor } from '../templates';
import { RadarSurface } from '../components/radar-surface';
import { BearingStrip, Empty, Mark, RadarGlyph, Spinner } from '../components/primitives';
import { useDocumentTitle } from '../lib/title';

export function PublicRadarRoute() {
  const { slug } = useParams({ from: '/r/$slug' });

  const radarQuery = useQuery({
    queryKey: queryKeys.publicRadar(slug),
    queryFn: () => api.publicRadars.get(slug),
    retry: false,
  });
  useDocumentTitle(radarQuery.data?.radar.name);

  const blipsQuery = useInfiniteQuery({
    queryKey: queryKeys.publicBlips(slug),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.publicRadars.blips(slug, { cursor: pageParam }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: radarQuery.isSuccess,
  });

  const blips = useMemo(
    () => blipsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [blipsQuery.data],
  );

  if (radarQuery.isLoading) return <Spinner label="Opening radar" />;

  if (radarQuery.error && !radarQuery.data)
    return (
      <QueryError error={radarQuery.error} resource="Radar" retry={() => radarQuery.refetch()} />
    );

  const radar = radarQuery.data?.radar;
  if (!radar) {
    return (
      <div className="mx-auto max-w-[760px]">
        <Empty
          title="This radar is not public"
          hint="The link may have been withdrawn, or a new one issued in its place."
          action={
            <Link to="/" className="btn">
              Go to On My Radar
            </Link>
          }
        />
      </div>
    );
  }

  // The same width the signed-in page gives this layout (`PANES`), for the header, the posts and the
  // footer alike, and the same container where the layout is `contained`: the stream's card grid,
  // the microblog's days | feed | photos and the index beside an open thread or decision all answer
  // to the `radar` container, not the viewport. Without it a wide public page drew every one of them
  // as a single column with 1800px lines. Not `rail`: a public page has no filters.
  const { measure, contained } = paneFor(templateFor(radar.template).layout);

  return (
    // `public-radar` is the hook for the board's public sizing in styles.css.
    <div className="public-radar" style={accentStyle(radar.accent)}>
      {/*
        The whole page, themed — header, posts and footer alike.

        It is deliberately not "the posts get the theme and the chrome stays
        ours", which is the cautious version and looks half-designed. It can be
        the whole page because the vocabulary has no way to attack it: `surface`
        ships its ink with its ground so text can never be the colour of its own
        background, and nothing in the nine axes can position, size or hide an
        element. The byline below is therefore always legible whatever the theme
        does — which is the property, not the hope. See theme.ts and the
        contrast assertions in theme.test.ts.
      */}
      <RadarSurface radar={radar} page>
        <header className="border-b border-[color:var(--line-soft)]">
          <div
            className={`mx-auto flex ${measure} items-center justify-between gap-4 px-4 pt-5 pb-4 sm:px-6`}
          >
            <div className="flex min-w-0 items-start gap-3">
              <span className="mt-0.5 text-[color:var(--accent-from)]">
                <RadarGlyph glyph={radar.glyph} className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <h1 className="truncate text-[19px] leading-tight font-semibold tracking-tight">
                  <span className="theme-headline">{radar.name}</span>
                </h1>
                {/* `.attribution` keeps the product's own palette whatever the
                    paper is. Belt to the braces above: with a paired surface and
                    no positioning in the vocabulary there is already no way to
                    hide this, but the byline is the exact thing Wave got wrong
                    and it is worth being unable to get wrong twice. */}
                <p className="instrument attribution mt-1 truncate">
                  {radar.tagline ?? 'A public radar'}
                  {radar.owner?.name ? ` · by ${radar.owner.name}` : ''}
                </p>
              </div>
            </div>
            <Link
              to="/"
              className="flex shrink-0 items-center gap-2 text-[color:var(--accent-from)]"
              title="On My Radar"
            >
              <Mark size={22} sweeping={false} />
            </Link>
          </div>
          <BearingStrip timestamps={blips.map((blip) => blip.createdAt)} />
        </header>

        <div className={`mx-auto ${measure} px-4 py-4 sm:px-6 ${contained ? 'radar-pane' : ''}`}>
          {/*
          The radar's own template, not the stream.

          This page used to render `BlipStream` whatever the radar was, which
          made a published microblog come out as a stream with kind badges on
          every post — the exact "it looks so blah" complaint. The server was
          already handing the blips back in the template's own order (see the
          fifth argument to `listBlips` in routes/public.ts); the SPA was
          throwing the template away the moment they arrived. A public radar is
          the same radar, read by somebody without an account, and a public page
          that silently re-shapes itself is a different radar wearing the same
          name.
        */}
          {blipsQuery.error ? (
            <QueryError
              error={blipsQuery.error}
              resource="Blips"
              retry={() => blipsQuery.refetch()}
            />
          ) : null}
          {!blipsQuery.error || blips.length > 0 ? (
            <TemplateView
              layout={templateFor(radar.template).layout}
              radar={radar}
              blips={blips}
              readOnly
              // The tag pages are behind sign-in, so a link there would send a
              // stranger to a login screen from a page that is meant to be readable.
              linkTags={false}
              // The thread is readable here and nothing can be added to it: a
              // public link is read-only, always. `publicSlug` is what routes the
              // fetch through the public identity, since the private comment route
              // requires membership.
              publicSlug={slug}
              loading={blipsQuery.isFetching}
              loadingMore={blipsQuery.isFetchingNextPage}
              hasMore={blipsQuery.hasNextPage}
              onLoadMore={() => void blipsQuery.fetchNextPage()}
              onChanged={() => undefined}
              emptyTitle="Nothing here yet"
              emptyHint="This radar has been published, but nothing has landed on it so far."
            />
          ) : null}
        </div>

        <footer className={`mx-auto ${measure} px-4 py-10 text-center sm:px-6`}>
          <Link to="/" className="instrument attribution hover:text-[color:var(--paper)]">
            Published with On My Radar
          </Link>
        </footer>
      </RadarSurface>
    </div>
  );
}
