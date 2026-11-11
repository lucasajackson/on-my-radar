/**
 * The discussion — a forum, where a blip is a thread and its comments are the
 * replies.
 *
 * On every other template the conversation is an aside folded under the thought.
 * Here it *is* the content, so the thread is open with its reply box in it, and
 * the page is an index of threads with one of them open beside it.
 *
 * ## Why an index and not a column of threads
 *
 * Wave's failure was positional: newest words buried in the middle of a long wave
 * with nothing on screen saying where. The radar is ordered by last reply
 * (`order: 'discussion'`), so the index puts the thread somebody just answered
 * first, and each row states its reply count and when it last moved — a scan down
 * the left edge answers "what has moved" without opening anything. A thread long
 * enough to have a trough still gets a visible jump to its newest reply, in
 * `Conversation`. Replies stay one level deep.
 *
 * ## Widths
 *
 * The columns answer to the *pane* (`RadarLayout` makes it a container), not the
 * viewport, because the sidebar takes 264px of it:
 *
 * - **xl, 1500px and up:** index | open thread | side panel (status, participants,
 *   tags, linked cards).
 * - **lg, 1000-1499px:** index | open thread; the panel folds into a strip above
 *   the thread's head.
 * - **below 1000px:** the index alone, then a full-screen thread behind a Back
 *   button. The open thread is `?sel=<id>` in the address, so it is a link.
 *
 * It is one set of markup; the columns are CSS (`.cols` in styles.css, shared with the log and the microblog), so there
 * is no second component and no breakpoint to keep in step.
 */
import { useEffect, useState } from 'react';
import { skipToken, useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';

import { conversationFor, findStatus } from '@onmyradar/contract';
import { BlipCard } from '../components/blips';
import { Empty, Spinner } from '../components/primitives';
import { api } from '../lib/api';
import { useLivePoll } from '../lib/polling';
import { useSelectedItem } from '../components/radar-layout';
import { readingProps, type TemplateViewProps } from './index';
import { SidePanel, ThreadMeta, nameOf } from './item-panel';

export function DiscussionView(props: TemplateViewProps) {
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
  const shape = conversationFor(radar.template);
  const { sel, select, back } = useSelectedItem();

  // The thread `?sel=` names, even from beyond the loaded page: fetched alone, never swapped for
  // another. With no `?sel=` the newest is opened, and then *held*: the radar reorders itself as
  // replies land, and an open thread (with a draft in it) must not change under the reader.
  const [held, setHeld] = useState<string | null>(null);
  const livePoll = useLivePoll();
  const listed = blips.find((blip) => blip.id === sel);
  const alone = useQuery({
    queryKey: ['blips', 'detail', sel],
    queryFn: sel && !listed && !props.publicSlug ? () => api.blips.get(sel) : skipToken,
    ...livePoll,
    retry: 1,
  });
  const fetched = alone.data?.blip.radarId === radar.id ? alone.data.blip : undefined;
  const named = listed ?? fetched;
  const newest = blips[0];
  useEffect(() => {
    if (!sel && !held && newest) setHeld(newest.id);
  }, [sel, held, newest]);
  const open = sel ? named : (blips.find((blip) => blip.id === held) ?? newest);

  if (loading && blips.length === 0) return <Spinner label="Reading the discussion" />;
  if (blips.length === 0 && !sel) return <Empty title={emptyTitle} hint={emptyHint} />;
  const lane = open ? findStatus(radar.template, open.status, radar.templateConfig) : null;

  return (
    <div className="cols" data-view={named ? 'item' : 'index'}>
      <nav className="cols-index" aria-label="Threads">
        {blips.map((blip) => {
          const settled = findStatus(radar.template, blip.status, radar.templateConfig)?.terminal;
          return (
            <button
              key={blip.id}
              className={`disc-topic ${blip.id === open?.id ? 'is-selected' : ''} ${settled ? 'is-settled' : ''}`}
              aria-current={blip.id === open?.id ? 'true' : undefined}
              onClick={() => select(blip.id)}
            >
              <span className="disc-topic-title">{nameOf(blip)}</span>
              <ThreadMeta
                blip={blip}
                replyNoun={shape.replyNoun}
                className="thread-meta disc-meta"
              />
            </button>
          );
        })}
        {hasMore ? (
          <button className="btn" onClick={onLoadMore}>
            Quieter threads
          </button>
        ) : null}
        {loadingMore ? <Spinner label="More" /> : null}
      </nav>

      <button className="btn cols-back" onClick={back}>
        <ArrowLeft className="h-4 w-4" /> Threads
      </button>

      {open ? (
        <>
          <SidePanel
            blip={open}
            radar={radar}
            loaded={new Set(blips.map((blip) => blip.id))}
            onSelect={select}
          />

          <section
            key={open.id}
            className={`thread cols-main ${lane?.terminal ? 'is-settled' : ''}`}
            aria-label={nameOf(open)}
          >
            {/* The lane is on the thread, not only in the card's control: "is this still open" is the
            first thing you want to know and the last thing you want to hunt for. */}
            <div className="thread-top">
              {lane ? (
                <div className={`thread-lane ${lane.terminal ? 'is-terminal' : ''}`}>
                  <span className="instrument">{lane.label}</span>
                </div>
              ) : null}
              <ThreadMeta blip={open} replyNoun={shape.replyNoun} />
            </div>
            <BlipCard
              {...readingProps(props)}
              blip={open}
              readOnly={readOnly}
              isNew={open.id === newestId}
              onChanged={() => {
                onChanged();
                if (fetched) void alone.refetch();
              }}
              template={radar}
              commentsEnabled={radar.commentsEnabled}
              reactionsEnabled={radar.reactionsEnabled}
            />
          </section>
        </>
      ) : (
        <p className="note cols-main">
          {alone.isPending && sel && !props.publicSlug
            ? 'Opening the thread…'
            : 'That thread is not available.'}
        </p>
      )}
    </div>
  );
}
