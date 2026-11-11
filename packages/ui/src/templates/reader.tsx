/**
 * The reader — a list of stories that opens each one full-screen, with mail's read state.
 *
 * Unread stories are bold with a dot, read ones are muted; opening a story files it as read (the
 * template's `readState` lanes, so the lane axis is the only record of it) and "Mark unread" (or
 * `u`) puts it back. The open story is `?sel=<id>`, so it is a link and the back gesture closes it;
 * an id beyond the loaded page is fetched alone and never swapped for another. The filter is the
 * radar's Unread / All toggle (`FilterBar`); a story read while "Unread" is on stays in the
 * sequence for the reader's next/previous until it closes.
 *
 * The overlay is portalled to the body: the radar pane is size-contained, which would otherwise
 * make it the containing block of a full-screen layer.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { skipToken, useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, ArrowUpRight, ChevronLeft } from 'lucide-react';
import {
  bodyWithoutLeadUrl,
  bodyWithoutTitleHeading,
  readStateFor,
  type BlipDto,
} from '@onmyradar/contract';
import { api, ApiError } from '../lib/api';
import { fullTime, hostOf } from '../lib/format';
import { plainText, renderMarkdown } from '../lib/markdown';
import { accentStyle } from '../lib/theme';
import { useLivePoll } from '../lib/polling';
import { BlipAttachments } from '../components/attachments';
import { cardLabel } from '../components/blips';
import { DueChip } from '../components/due-chip';
import { EmailContent } from '../components/email-content';
import { useSelectedItem } from '../components/radar-layout';
import { Empty, Spinner, notify } from '../components/primitives';
import { RelativeTime } from '../components/relative-time';
import type { TemplateViewProps } from './index';

const sourceOf = (blip: BlipDto) => blip.preview?.siteName ?? (blip.url ? hostOf(blip.url) : null);
const textOf = (blip: BlipDto) =>
  bodyWithoutLeadUrl(bodyWithoutTitleHeading(blip.body, blip.title), blip.url);

export function ReaderView(props: TemplateViewProps) {
  const { radar, blips, readOnly, loading, loadingMore, hasMore, onLoadMore, onChanged } = props;
  const { sel, select, back } = useSelectedItem();
  const readState = readStateFor(radar.template, radar.templateConfig);
  const canMark = Boolean(readState) && !readOnly && !props.publicSlug;
  const unread = (blip: BlipDto) => Boolean(readState) && blip.status === readState?.unread;

  // The story `?sel=` names, fetched alone when it is beyond the loaded page.
  const livePoll = useLivePoll();
  const listed = blips.find((blip) => blip.id === sel);
  const alone = useQuery({
    queryKey: ['blips', 'detail', sel],
    queryFn: sel && !listed && !props.publicSlug ? () => api.blips.get(sel) : skipToken,
    ...livePoll,
    retry: 1,
  });
  const fetched = alone.data?.blip.radarId === radar.id ? alone.data.blip : undefined;
  const open = listed ?? fetched;

  // Where the open story sits in the list. A story read under "Unread" leaves the list on the next
  // refetch; its place is remembered so next/previous still step from where the reader was.
  const at = useRef<{ id: string; index: number } | null>(null);
  const found = blips.findIndex((blip) => blip.id === sel);
  if (sel && found >= 0) at.current = { id: sel, index: found };
  // Gone from the list, the story that followed it now sits at its old index.
  const remembered = found < 0 && at.current?.id === sel ? at.current.index : -1;
  const before = blips[(found >= 0 ? found : remembered) - 1];
  const after = found >= 0 ? blips[found + 1] : remembered >= 0 ? blips[remembered] : undefined;

  const mark = async (blip: BlipDto, to: 'read' | 'unread') => {
    if (!canMark || !readState) return;
    try {
      await api.blips.update(blip.id, {
        status: to === 'read' ? readState.read : readState.unread,
      });
      onChanged();
      if (fetched?.id === blip.id) void alone.refetch();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not update that story', 'error');
    }
  };

  // Opening a story reads it, once per opening: "Mark unread" inside the reader stays unread.
  const autoRead = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      if (!sel) autoRead.current = null;
      return;
    }
    if (autoRead.current === open.id) return;
    autoRead.current = open.id;
    if (unread(open)) void mark(open, 'read');
  });

  const [hovered, setHovered] = useState<string | null>(null);
  const layer = useRef<HTMLDivElement>(null);
  const story = useRef<HTMLElement>(null);
  const go = (blip: BlipDto | undefined) => {
    if (blip) select(blip.id, true);
    else if (hasMore) onLoadMore();
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey
      )
        return;
      if (
        event.target instanceof Element &&
        event.target.closest('input, textarea, select, [contenteditable]')
      )
        return;
      // Another dialog (a photo, a confirmation) is on top: the keys are its.
      if ([...document.querySelectorAll('[aria-modal="true"]')].some((el) => el !== layer.current))
        return;
      const target = open ?? blips.find((blip) => blip.id === hovered);
      if (sel && event.key === 'Escape') back();
      else if (sel && (event.key === 'ArrowLeft' || event.key === 'k')) go(before);
      else if (sel && (event.key === 'ArrowRight' || event.key === 'j')) go(after);
      else if (event.key === 'u' && target && !unread(target)) void mark(target, 'unread');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  // Focus moves into the reader when it opens and back to the story's row when it closes.
  const returnTo = useRef<string | null>(null);
  useEffect(() => {
    if (sel) {
      if (returnTo.current === null) layer.current?.focus();
      returnTo.current = sel;
    } else if (returnTo.current !== null) {
      document
        .querySelector<HTMLElement>(`[data-blip-id="${returnTo.current}"] .read-row-main`)
        ?.focus();
      returnTo.current = null;
    }
  }, [sel]);
  // Tab cycles inside the reader: the page behind is inert, not merely covered.
  const trapTab = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const stops = [
      ...(layer.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') ?? []),
    ];
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!first || !last) return;
    const here = document.activeElement;
    if (event.shiftKey && (here === first || here === layer.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && here === last) {
      event.preventDefault();
      first.focus();
    }
  };
  // Each story starts at its top.
  useEffect(() => {
    if (story.current) story.current.scrollTop = 0;
  }, [open?.id]);

  if (loading && blips.length === 0 && !sel) return <Spinner label="Opening your reading list" />;
  if (blips.length === 0 && !sel) return <Empty title={props.emptyTitle} hint={props.emptyHint} />;

  return (
    <>
      <div inert={sel ? true : undefined}>
        <ul className="read-list" aria-label="Stories">
          {blips.map((blip) => {
            const isUnread = unread(blip);
            const snippet = blip.email
              ? ''
              : (blip.preview?.description ?? plainText(textOf(blip), 160));
            return (
              <li
                key={blip.id}
                className="read-row"
                data-unread={isUnread || undefined}
                data-blip-id={blip.id}
                onMouseEnter={() => setHovered(blip.id)}
                onMouseLeave={() => setHovered(null)}
              >
                <button className="read-row-main" onClick={() => select(blip.id)}>
                  <span className="read-dot" aria-hidden="true" />
                  <span className="read-row-title">
                    {isUnread ? <span className="sr-only">Unread: </span> : null}
                    {cardLabel(blip)}
                  </span>
                  <span className="instrument read-row-meta">
                    {sourceOf(blip)} · <RelativeTime iso={blip.createdAt} />
                  </span>
                  {snippet ? <span className="read-row-snippet">{snippet}</span> : null}
                  {blip.dueAt ? (
                    <span className="read-row-due">
                      <DueChip blip={blip} personal={!props.publicSlug} />
                    </span>
                  ) : null}
                </button>
                {canMark && !isUnread ? (
                  <button
                    className="btn btn-ghost read-row-act"
                    onClick={() => void mark(blip, 'unread')}
                  >
                    Mark unread
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
        {hasMore ? (
          <button className="btn" onClick={onLoadMore}>
            More stories
          </button>
        ) : null}
        {loadingMore ? <Spinner label="More" /> : null}
      </div>

      {sel
        ? createPortal(
            <div
              ref={layer}
              tabIndex={-1}
              onKeyDown={trapTab}
              className="reader"
              role="dialog"
              aria-modal="true"
              aria-label={open ? cardLabel(open) : 'Story'}
              style={accentStyle(radar.accent)}
            >
              <div className="reader-bar">
                <button className="btn btn-ghost" onClick={back} aria-label="Close story">
                  <ChevronLeft className="h-4 w-4" /> <span>Back</span>
                </button>
                <span className="reader-bar-gap" />
                {open && canMark && !unread(open) ? (
                  <button className="btn btn-ghost" onClick={() => void mark(open, 'unread')}>
                    Mark unread
                  </button>
                ) : null}
                <button
                  className="btn btn-ghost"
                  onClick={() => go(before)}
                  disabled={!before}
                  aria-label="Previous story"
                  title="Previous (← or k)"
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => go(after)}
                  disabled={!after && !hasMore}
                  aria-label="Next story"
                  title="Next (→ or j)"
                >
                  <ArrowRight className="h-4 w-4" />
                </button>
              </div>
              <article ref={story} className="reader-story">
                {open ? (
                  <StoryBody blip={open} publicSlug={props.publicSlug} />
                ) : (
                  <p className="note" role="status">
                    {alone.isPending && !props.publicSlug
                      ? 'Opening the story…'
                      : 'That story is not available.'}
                  </p>
                )}
              </article>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function StoryBody({ blip, publicSlug }: { blip: BlipDto; publicSlug: string | undefined }) {
  const html = renderMarkdown(blip.email ? '' : textOf(blip), {
    tagLinks: false,
    mentions: blip.mentions ?? [],
  });
  const pictured = blip.attachments.some((a) => a.contentType.startsWith('image/'));
  return (
    <>
      <h1 className="reader-title">{cardLabel(blip)}</h1>
      <p className="instrument reader-meta">
        {sourceOf(blip)} · <time dateTime={blip.createdAt}>{fullTime(blip.createdAt)}</time>
        {blip.url ? (
          <>
            {' · '}
            <a href={blip.url} target="_blank" rel="noreferrer noopener" className="source-link">
              Open original
              <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
            </a>
          </>
        ) : null}
      </p>
      {blip.dueAt ? (
        <p className="reader-meta">
          <DueChip blip={blip} personal={!publicSlug} />
        </p>
      ) : null}
      {!pictured && blip.preview?.imageUrl ? (
        <img className="reader-hero" src={blip.preview.imageUrl} alt="" />
      ) : null}
      <BlipAttachments attachments={blip.attachments} treatment="feature" />
      {blip.email ? (
        // A captured email keeps its full-message viewer (it fetches the message itself).
        <div className="reader-body">
          <EmailContent blip={blip} {...(publicSlug ? { publicSlug } : {})} />
          {blip.email.notes ? (
            <p className="note mt-3 whitespace-pre-wrap">{blip.email.notes}</p>
          ) : null}
        </div>
      ) : (
        <div className="blip-body reader-body" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </>
  );
}
