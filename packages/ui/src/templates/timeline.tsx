/**
 * The timeline — a microblog, or a diary.
 *
 * The difference from the stream is what is *missing*: no kind badge, no triage
 * chrome, no filter chips. A post is a thing you wrote, not a thing to be
 * processed, and the interface should stop asking. What is left is the ink half
 * of the design at full strength — the serif body given room, with the
 * instrument voice reduced to a timestamp.
 *
 * `templateConfig.grouping: 'day'` adds a date rule between days, which is the
 * "journaled" reading of the same surface: the same posts, but you can see where
 * one day ended and the next began.
 *
 * From 1000px of pane the feed has a column either side: the days (a jump to each, with its post
 * count) and the photos from the posts loaded so far. Below that, and on a public page, it is the
 * feed alone. The feed's own markup is the same either way; `.cols` in styles.css does the rest.
 */
import { Fragment, useMemo, useRef, useState } from 'react';
import type { AttachmentDto, BlipDto } from '@onmyradar/contract';
import { BlipCard } from '../components/blips';
import { Lightbox } from '../components/lightbox';
import { scrollPaneTo } from '../lib/pane-scroll';
import { Empty, Spinner } from '../components/primitives';
import { readingProps, type TemplateViewProps } from './index';

/** Local calendar day, so "yesterday" means the reader's yesterday. */
function dayKey(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/**
 * Posts under their day's heading, pinned posts first under their own.
 *
 * Pinned is the server's outermost sort key, so a pinned post from Monday sat
 * above Wednesday and Tuesday and then Monday came round again: two groups
 * keyed "Monday", which React mis-reconciles, and a date heading printed twice
 * with nothing on the page saying why. The log already solved this the same way.
 */
export function timelineGroups(
  blips: BlipDto[],
  grouped: boolean,
): Array<{ key: string; day: string | null; items: BlipDto[] }> {
  if (!grouped) return [{ key: 'all', day: null, items: blips }];
  const out: Array<{ key: string; day: string | null; items: BlipDto[] }> = [];
  for (const blip of blips) {
    const day = blip.pinned ? 'Pinned' : dayKey(blip.createdAt);
    const last = out[out.length - 1];
    if (last && last.day === day) last.items.push(blip);
    // The index keeps keys unique even if an order ever revisits a day.
    else out.push({ key: `${out.length}:${day}`, day, items: [blip] });
  }
  return out;
}

/** Every picture in the posts, in feed order: what the photos column shows. */
export function timelinePhotos(blips: BlipDto[]): AttachmentDto[] {
  return blips.flatMap((blip) =>
    blip.attachments.filter((a) => a.contentType.startsWith('image/')),
  );
}

/** "Thu 29 Oct", for a column too narrow for the heading's full date. */
const shortDay = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

export function TimelineView(props: TemplateViewProps) {
  const {
    radar,
    blips,
    readOnly,
    loading,
    loadingMore,
    hasMore,
    onLoadMore,
    onChanged,
    newestId,
    emptyTitle,
    emptyHint,
  } = props;
  const grouped = radar.templateConfig.grouping === 'day';

  const groups = useMemo(() => timelineGroups(blips, grouped), [blips, grouped]);
  const days = useMemo(() => timelineGroups(blips, true), [blips]);
  const photos = useMemo(() => timelinePhotos(blips), [blips]);
  const [photoAt, setPhotoAt] = useState<number | null>(null);
  const columns = useRef<HTMLDivElement>(null);
  const jump = (id: string) => {
    const post = columns.current?.querySelector(`[data-post="${id}"]`);
    const heading = post?.previousElementSibling;
    const target = heading?.classList.contains('timeline-day') ? heading : post;
    if (target) scrollPaneTo(target);
  };

  if (loading && blips.length === 0) return <Spinner label="Reading the timeline" />;
  if (blips.length === 0) return <Empty title={emptyTitle} hint={emptyHint} />;

  return (
    <div className="cols cols-tri" data-view="ledger" ref={columns}>
      <nav className="cols-index" aria-label="Days">
        {days.map((day) => (
          <button key={day.key} className="day-row" onClick={() => jump(day.items[0]?.id ?? '')}>
            <span>{day.day === 'Pinned' ? day.day : shortDay(day.items[0]?.createdAt ?? '')}</span>
            <span className="instrument">{day.items.length}</span>
          </button>
        ))}
      </nav>
      <aside className="cols-panel" aria-label="Photos">
        {photos.length > 0 ? (
          <div className="photo-wall">
            {photos.map((photo, at) => (
              <button
                key={photo.id}
                aria-label={`Open ${photo.filename}`}
                onClick={() => setPhotoAt(at)}
              >
                <img src={photo.href} alt={photo.filename} loading="lazy" />
              </button>
            ))}
          </div>
        ) : (
          <p className="note">Photos from these posts collect here.</p>
        )}
      </aside>
      {photoAt !== null ? (
        <Lightbox images={photos} startAt={photoAt} onClose={() => setPhotoAt(null)} />
      ) : null}
      <div className="cols-main">
        <div className="timeline">
          {groups.map((group) => (
            <Fragment key={group.key}>
              {group.day ? (
                <div className="timeline-day">
                  <span className="instrument">{group.day}</span>
                </div>
              ) : null}
              {group.items.map((blip) => (
                <div key={blip.id} className="timeline-post" data-post={blip.id}>
                  <BlipCard
                    {...readingProps(props)}
                    blip={blip}
                    readOnly={readOnly}
                    isNew={blip.id === newestId}
                    onChanged={onChanged}
                    template={radar}
                    commentsEnabled={radar.commentsEnabled}
                    reactionsEnabled={radar.reactionsEnabled}
                    // A post is a thing you wrote, not a thing to be processed: the
                    // kind badge is exactly the chrome this surface is defined by
                    // not having.
                    compact
                    // No swipe: a post has no triage a timeline shows, so a gesture
                    // would change something nobody can see. The contract says so
                    // (`allowsTriageGesture`), for iOS as much as here.
                  />
                </div>
              ))}
            </Fragment>
          ))}

          {hasMore ? (
            <div className="flex justify-center py-4">
              <button className="btn" onClick={onLoadMore}>
                Older posts
              </button>
            </div>
          ) : null}
          {loadingMore ? <Spinner label="More" /> : null}
        </div>
      </div>
    </div>
  );
}
