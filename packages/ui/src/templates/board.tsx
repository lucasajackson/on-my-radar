/**
 * The board.
 *
 * Columns come from the template's declared lanes, so this file knows nothing
 * about Kanban specifically — any template with `layout: 'board'` renders here,
 * with whatever lanes it declares.
 *
 * Moving a card writes `status` and nothing else: the server derives the blip's
 * triage state from the lane it landed in. Two controls that could disagree
 * would be worse than one, and the server is the one that has to be right.
 *
 * Dragging uses the HTML drag-and-drop API rather than a library, for the same
 * reason the dashboard grid does — it is a few dozen lines, and it keeps the
 * bundle honest. A keyboard user gets the lane select on each card instead, so
 * the board is never the only way to move something.
 *
 * ## Fitting on a screen — why the board budgets its lanes
 *
 * Two complaints arrived about this board and they pull in opposite directions:
 * the board must not scroll sideways, and the cards must not be so narrow that
 * the controls on them disappear. Sharing the width between five equal lanes
 * satisfies the first by breaking the second, and no lane floor satisfies both.
 * That is arithmetic, not taste — measured on 2026-08-27:
 *
 *   - a 1366px laptop leaves the board **1054px** (the shell costs 264px beside
 *     the viewport with the sidebar expanded; 60px with it railed)
 *   - a board card's meta row — icon, time, lane select, edit, pin, delete —
 *     had a min-content width of **283px**, so the edit control was only fully
 *     inside the card once the lane reached about **317px**
 *   - five lanes at 317px is 1585px. It is 531px more than exists.
 *
 * Half of that gap is closed in `components/blips.tsx`, which lifts a compact
 * card's action cluster out of the meta row entirely — the controls no longer
 * compete for the row's width, so no lane width can push them out again. That
 * fixes "I don't see the button to edit" on its own. It does not fix the cards
 * being too narrow to read, which is the other half of the same report.
 *
 * So the number of lanes drawn *full width* has to fall out of the width that is
 * actually there, and the rest have to be somewhere else without being gone.
 * They already had somewhere: the furled rail, which this file has drawn since
 * the first fix and which is still a drop target.
 *
 * The board therefore keeps a **budget**. It measures itself, works out how many
 * lanes clear `--lane-floor` once the others are railed, and opens exactly that
 * many. Nothing scrolls sideways because nothing can: the open lanes are sized
 * from a width that was measured before they were laid out.
 *
 * Which lanes are open is an ordering, not a rule (`lib/board-lanes.ts`): a
 * lane you opened from its rail first, then lanes holding cards, working before
 * finished, then empty ones — template order breaking ties. Clicking a rail brings that lane to
 * the front and pushes the least-wanted one out; furling a lane explicitly puts
 * it in `furled`, where the budget cannot bring it back. One click either way,
 * and the whole board stays on screen throughout.
 *
 * What this buys, measured at each viewport, with five Kanban lanes:
 *
 *   1366 → 3 open at 309px + 2 rails      1366 railed → 4 open at 294px + 1 rail
 *   1440 → 3 open at 334px + 2 rails      1440 railed → 4 open at 312px + 1 rail
 *   1920 → 5 open at 303px
 *
 * Furling the sidebar still buys a whole lane, which is what it was asked for.
 *
 * **On a phone it is one lane at a time.** Five 60px columns is not a board, it
 * is a bar chart. Below the breakpoint the lanes become a pager: one full width
 * column, with the lane strip above it to move between them. The budget does not
 * run there — the pager already answers the same question.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight, Columns3 } from 'lucide-react';
import {
  archiveSearchFor,
  statusesFor,
  templateFor,
  type BlipDto,
  type BlipStatusDef,
} from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { BlipCard, cardLabel } from '../components/blips';
import { Empty, Modal, Spinner, notify } from '../components/primitives';
import { DESKTOP_QUERY, useMediaQuery } from '../lib/viewport';
import { readingProps, type TemplateViewProps } from './index';
import {
  AFTER_REFETCH,
  afterLaneMove,
  cardSelector,
  focusWhenPresent,
  neighbourCard,
} from '../lib/focus';
import { openLanes } from '../lib/board-lanes';
import { useBlipRoute } from '../lib/blip-route';

/**
 * How many lanes can be drawn open, given the width there actually is.
 *
 * The three numbers are read off the board's own computed style rather than
 * repeated here, so `--lane-floor`, `--lane-rail` and the flex gap cannot drift
 * between the stylesheet that lays the lanes out and the arithmetic that decides
 * how many of them there are. A budget computed from a stale copy of the floor
 * is exactly the bug this replaces.
 *
 * Measured with `useLayoutEffect` so the first paint is already correct — a
 * board that renders five lanes and then snaps to three is a flash of the very
 * layout we are here to stop.
 */
function useLaneBudget(node: HTMLDivElement | null, laneCount: number): number {
  const [budget, setBudget] = useState(laneCount);

  useLayoutEffect(() => {
    if (!node || laneCount === 0) return;

    const measure = () => {
      const style = window.getComputedStyle(node);
      const floor = Number.parseFloat(style.getPropertyValue('--lane-floor')) || 288;
      const rail = Number.parseFloat(style.getPropertyValue('--lane-rail')) || 44;
      const gap = Number.parseFloat(style.columnGap) || 0;
      const width = node.clientWidth;
      // A board that has not been laid out yet measures zero. Leaving the
      // previous budget alone is right: the next observation will correct it,
      // and clamping to one lane in the meantime would be a visible flicker.
      if (width <= 0) return;
      let open = laneCount;
      while (open > 1 && open * floor + (laneCount - open) * rail + (laneCount - 1) * gap > width) {
        open -= 1;
      }
      setBudget(open);
    };

    measure();
    // The board's width comes from its parent, never from its own children, so
    // observing it cannot feed back into itself.
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, laneCount]);

  return budget;
}

/**
 * The lanes in the order they should give up their width.
 *
 * Terminal lanes first — Done is the one you look at least while working — and
 * within that, declaration order, which on a board runs left to right along the
 * flow. Reversed, that is the order lanes stay open in.
 */
function initialOrder(lanes: readonly BlipStatusDef[]): string[] {
  return [...lanes]
    .map((lane, at) => ({ lane, at }))
    .sort((a, b) => Number(a.lane.terminal) - Number(b.lane.terminal) || a.at - b.at)
    .map((entry) => entry.lane.id);
}

export function BoardView(props: TemplateViewProps) {
  const {
    radar,
    blips,
    readOnly,
    loading,
    hasMore,
    onLoadMore,
    onChanged,
    newestId,
    emptyTitle,
    emptyHint,
    archivedCounts,
  } = props;
  const lanes = statusesFor(radar.template, radar.templateConfig);
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState<{ id: string; editing: boolean } | null>(null);
  const closedDetail = useRef<string | null>(null);
  const pointer = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const dragged = useRef(false);
  const boardDetails = templateFor(radar.template).layout === 'board';
  const selectedBlip = detail ? blips.find((blip) => blip.id === detail.id) : undefined;
  const blipRoute = useBlipRoute();
  const routed = Boolean(blipRoute);
  const routeOpen = blipRoute?.openId ?? null;
  useEffect(() => {
    setDetail(null);
  }, [radar.id]);
  // Back, or a link to the radar, closes the card whose address went away.
  useEffect(() => {
    if (routed && !routeOpen) setDetail(null);
  }, [routed, routeOpen]);
  useEffect(() => {
    const id = closedDetail.current;
    if (detail || !id) return;
    closedDetail.current = null;
    // The modal has released its focus trap and restored its old anchor. Closing
    // explicitly returns to the current card, even when that old anchor moved.
    focusWhenPresent(
      [`.board-card ${cardSelector(id)} [data-open-blip]`, '.board-pager button', 'main h1'],
      { frames: AFTER_REFETCH.frames },
    );
  }, [detail]);

  /*
   * The board element as *state*, not a ref. A ref would be null on the render
   * that returns the spinner above, and an effect keyed on it would never see it
   * arrive — the budget would then be stuck at "every lane open" until something
   * else forced a resize, which is what happened the first time this was written
   * and measured. A callback ref re-runs the measurement the moment the node
   * exists.
   */
  const [boardEl, setBoardEl] = useState<HTMLDivElement | null>(null);
  const budget = useLaneBudget(boardEl, lanes.length);

  // Furling is per-viewer and per-visit rather than stored on the radar: it is
  // how *you* want to look at the board right now, not a property of the board
  // everyone else has to share. The radar's own `collapseDone` decides where
  // that starts.
  //
  // `furled` is only ever what the person furled *on purpose*. The budget furls
  // more when there is not the width, but it does that by ordering, never by
  // writing in here — otherwise widening the window would leave lanes shut that
  // nobody ever asked to shut.
  const [furled, setFurled] = useState<Set<string>>(
    () =>
      new Set(
        radar.templateConfig.collapseDone
          ? lanes.filter((lane) => lane.terminal).map((lane) => lane.id)
          : [],
      ),
  );
  const [order, setOrder] = useState<string[]>(() => initialOrder(lanes));
  // Lanes the person opened from a rail, most recent first. These outrank
  // everything the budget would otherwise decide.
  const [wanted, setWanted] = useState<string[]>([]);

  // A radar switched to a template with different lanes must not leave the pager
  // pointing past the end of the new set.
  useEffect(() => setPage((current) => Math.min(current, Math.max(lanes.length - 1, 0))), [lanes]);

  // …nor leave the ordering describing lanes that no longer exist. Lanes the
  // person has already expressed a preference about keep their place; anything
  // new joins in its template's own order.
  useEffect(() => {
    setOrder((current) => {
      const ids = new Set(lanes.map((lane) => lane.id));
      const kept = current.filter((id) => ids.has(id));
      const added = initialOrder(lanes).filter((id) => !kept.includes(id));
      const next = [...kept, ...added];
      const same = next.length === current.length && next.every((id, at) => id === current[at]);
      return same ? current : next;
    });
  }, [lanes]);

  if (loading && blips.length === 0) return <Spinner label="Reading the board" />;
  if (lanes.length === 0) return <Empty title={emptyTitle} hint={emptyHint} />;

  // A blip whose stored lane is not one of this template's lands in the first
  // column rather than vanishing — which is what happens to everything on a
  // radar that was switched to a board after the fact.
  const laneIds = new Set(lanes.map((l) => l.id));
  const columnFor = (blip: BlipDto) =>
    blip.status && laneIds.has(blip.status) ? blip.status : (lanes[0]?.id ?? '');

  const countIn = (laneId: string) => blips.filter((blip) => columnFor(blip) === laneId).length;

  /*
    A move says where the card went and how to take it back, and focus follows
    the card to its new lane. It used to change silently: no word of where it
    landed, no undo, and focus left on a card that had just been unmounted.
  */
  const move = async (blip: BlipDto, status: string, undoing = false) => {
    const from = blip.status;
    const neighbour = neighbourCard(blip.id);
    try {
      await api.blips.update(blip.id, { status });
      onChanged();
      focusWhenPresent(afterLaneMove(blip.id, neighbour), AFTER_REFETCH);
      if (undoing || !from) return;
      const label = lanes.find((lane) => lane.id === status)?.label ?? 'another lane';
      notify(`Moved to ${label}`, 'ok', {
        label: 'Undo',
        run: () => void move({ ...blip, status }, from, true),
      });
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not move that card', 'error');
    }
  };

  /*
   * Which lanes are drawn open, and which are rails.
   *
   * Explicit furls come out first — those are a decision, and the budget is not
   * allowed to overturn a decision. What is left competes for the budget in
   * `order`, most-wanted first. At least one lane is always open: a board of
   * nothing but rails would be a board you cannot read at any width.
   */
  const open = openLanes({ lanes, order, furled, wanted, counts: countIn, budget });
  const isRail = (laneId: string) => desktop && !open.has(laneId);

  /** Open a lane, at the cost of whichever open lane was wanted least. */
  const unfurl = (laneId: string) => {
    setFurled((current) => {
      if (!current.has(laneId)) return current;
      const next = new Set(current);
      next.delete(laneId);
      return next;
    });
    setOrder((current) => [laneId, ...current.filter((id) => id !== laneId)]);
    setWanted((current) => [laneId, ...current.filter((id) => id !== laneId)]);
  };

  /** Rail a lane on purpose, and let the next lane in the queue take its place. */
  const furl = (laneId: string) => {
    setFurled((current) => new Set(current).add(laneId));
    setOrder((current) => [...current.filter((id) => id !== laneId), laneId]);
    setWanted((current) => current.filter((id) => id !== laneId));
  };

  const visible = desktop ? lanes : lanes.slice(page, page + 1);
  const openDetail = (blip: BlipDto, editing: boolean) => {
    // Card-body clicks need the same real focus-return anchor as keyboard opening.
    document
      .querySelector<HTMLElement>(`.board-card ${cardSelector(blip.id)} [data-open-blip]`)
      ?.focus({ preventScroll: true });
    setDetail({ id: blip.id, editing: editing && !readOnly });
    if (boardDetails) blipRoute?.open(blip.id);
  };
  const closeDetail = () => {
    closedDetail.current = detail?.id ?? null;
    setDetail(null);
    if (routeOpen === detail?.id) blipRoute?.close();
    // A move can place the card on another phone page or in a railed lane.
    if (selectedBlip) {
      const laneId = columnFor(selectedBlip);
      const at = lanes.findIndex((lane) => lane.id === laneId);
      if (!desktop && at >= 0) setPage(at);
      else if (desktop && isRail(laneId)) unfurl(laneId);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {/* The lane strip: a legend on desktop, the pager on a phone. Either way it
          is the one place the whole board's shape is visible at a glance. */}
      {!desktop ? (
        <div className="board-pager">
          <button
            className="btn btn-ghost p-1.5"
            aria-label="Previous lane"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="scroll-area board-pager-lanes">
            {lanes.map((lane, at) => (
              <button
                key={lane.id}
                className={`board-pager-lane instrument ${at === page ? 'is-active' : ''}`}
                aria-current={at === page}
                onClick={() => setPage(at)}
              >
                {lane.label}
                <span className="!tracking-normal">{countIn(lane.id)}</span>
              </button>
            ))}
          </div>
          <button
            className="btn btn-ghost p-1.5"
            aria-label="Next lane"
            disabled={page >= lanes.length - 1}
            onClick={() => setPage((p) => Math.min(lanes.length - 1, p + 1))}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      {/* No `overflow-x` here and none in the stylesheet: the budget above sizes
          the open lanes from a width that has already been measured, so the row
          cannot be wider than the box it is in. Horizontal scrolling of the
          board is the thing being removed, not something to be styled. */}
      <div className="board" ref={setBoardEl}>
        {visible.map((lane) => {
          const cards = blips.filter((blip) => columnFor(blip) === lane.id);
          // Furling only applies where there is a row of lanes to reclaim space
          // in; on the pager there is exactly one lane and furling it would
          // leave the screen empty.
          const isFurled = isRail(lane.id);
          // The two ways a lane ends up as a rail read differently to the person
          // looking at it: one they did, the other the window did.
          const byBudget = isFurled && !furled.has(lane.id);

          return (
            <section
              key={lane.id}
              className={`board-column ${over === lane.id ? 'is-over' : ''} ${
                lane.terminal ? 'is-terminal' : ''
              } ${isFurled ? 'is-furled' : ''}`}
              onDragOver={(event) => {
                if (readOnly || !dragging) return;
                // Without preventDefault the drop never fires at all.
                event.preventDefault();
                setOver(lane.id);
              }}
              onDragLeave={() => setOver((current) => (current === lane.id ? null : current))}
              onDrop={(event) => {
                event.preventDefault();
                setOver(null);
                if (readOnly || !dragging) return;
                const blip = blips.find((b) => b.id === dragging);
                setDragging(null);
                // A furled lane is still a drop target: it is narrower, not gone.
                if (blip && columnFor(blip) !== lane.id) void move(blip, lane.id);
              }}
            >
              {/* On the pager the strip above already names the lane and its
                  count, in the accent, one line up. Printing it again directly
                  underneath is the same "says it twice" failure the title rule
                  exists to avoid. */}
              {isFurled ? (
                /* A rail is one control, not a header with a control in it. The
                   whole strip opens the lane, because a 44px column is too
                   narrow to ask anybody to hit a 12px target inside it. */
                <button
                  className="board-column-rail"
                  aria-expanded={false}
                  // The count is in the name: "Open Blocked, 0 cards" says why an
                  // empty working lane gave its width to the lanes with work in.
                  aria-label={`Open ${lane.label}, ${cards.length} ${cards.length === 1 ? 'card' : 'cards'}`}
                  title={[
                    byBudget
                      ? `${lane.label} — no room for it open at this width. Click to open it; the lane you have looked at least will rail.`
                      : `Open ${lane.label}`,
                    // A rail has no header to print the seam in, and Done and
                    // Blocked are the lanes the budget rails first — which is
                    // to say, the two that hold the archive. The line above
                    // the board is what actually guarantees this is visible;
                    // this is here so hovering the rail answers the same
                    // question in place.
                    archivedCounts?.[lane.id]
                      ? `${archivedCounts[lane.id]} more have aged out of this radar.`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => unfurl(lane.id)}
                >
                  <Columns3 className="h-3 w-3 shrink-0" aria-hidden="true" />
                  <span className="instrument board-column-label">{lane.label}</span>
                  <span className="instrument !tracking-normal">{cards.length}</span>
                </button>
              ) : (
                <header
                  className="board-column-head"
                  style={{ display: desktop ? undefined : 'none' }}
                >
                  <button
                    className="board-column-furl"
                    aria-expanded
                    aria-label={`Furl ${lane.label}`}
                    title={`Furl ${lane.label} to a rail`}
                    onClick={() => furl(lane.id)}
                    // Only offered where there is a row to reclaim space in.
                    style={{ display: desktop ? undefined : 'none' }}
                  >
                    <Columns3 className="h-3 w-3" aria-hidden="true" />
                  </button>
                  <span className="instrument board-column-label">{lane.label}</span>
                  <span className="instrument !tracking-normal">{cards.length}</span>
                  {/* The seam. Archiving is allowed to take cards out of a
                      column; it is not allowed to do it quietly, so the header
                      says how many went and the number is the way back to them.
                      Only when something actually left — a permanent `· 0
                      archived` on every lane is chrome, not information. */}
                  {archivedCounts?.[lane.id] ? (
                    <Link
                      to="/search"
                      search={{ q: archiveSearchFor(radar.id) }}
                      className="board-column-archived instrument"
                      title={`${archivedCounts[lane.id]} finished blips have aged out of this radar. Nothing was deleted — open the archive.`}
                    >
                      · {archivedCounts[lane.id]} archived
                    </Link>
                  ) : null}
                </header>
              )}

              {isFurled ? null : (
                <div className="board-column-body scroll-area">
                  {cards.map((blip) => (
                    <article
                      key={blip.id}
                      className={`board-card ${dragging === blip.id ? 'is-dragging' : ''}`}
                      draggable={!readOnly}
                      onPointerDown={(event) => {
                        pointer.current = { x: event.clientX, y: event.clientY, moved: false };
                        dragged.current = false;
                      }}
                      onPointerMove={(event) => {
                        const start = pointer.current;
                        if (
                          start &&
                          Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6
                        )
                          start.moved = true;
                      }}
                      onClick={(event) => {
                        if (
                          !boardDetails ||
                          event.defaultPrevented ||
                          dragged.current ||
                          pointer.current?.moved
                        )
                          return;
                        const target = event.target;
                        if (
                          !(target instanceof Element) ||
                          target.closest(
                            'a, button, input, textarea, select, label, summary, [role="button"], [role="menu"], [role="option"], [role="checkbox"], [role="combobox"], [role="switch"], [contenteditable="true"]',
                          )
                        )
                          return;
                        if (window.getSelection()?.toString()) return;
                        openDetail(blip, false);
                      }}
                      onDragStart={(event) => {
                        dragged.current = true;
                        setDragging(blip.id);
                        event.dataTransfer.effectAllowed = 'move';
                        // Firefox will not start a drag without payload on the event.
                        event.dataTransfer.setData('text/plain', blip.id);
                      }}
                      onDragEnd={() => {
                        setDragging(null);
                        setOver(null);
                      }}
                    >
                      <BlipCard
                        {...readingProps(props)}
                        blip={blip}
                        readOnly={readOnly}
                        isNew={blip.id === newestId}
                        onChanged={onChanged}
                        template={radar}
                        compact
                        /*
                          `inLane` is about a column narrower than the card wants
                          — it lifts the action cluster out of the meta row so no
                          lane width can push it outside the card. On the phone
                          pager there is one lane and it is the full width of the
                          screen, so the arithmetic it answers does not exist;
                          floating the cluster there only lays it on top of the
                          byline, which is what a screenshot showed the moment
                          the cluster became visible at rest on a touch device.
                        */
                        inLane={desktop}
                        conversation={false}
                        {...(boardDetails
                          ? {
                              onOpenDetail: (editing: boolean) => openDetail(blip, editing),
                              compactPreview: true,
                            }
                          : {})}
                      />
                    </article>
                  ))}

                  {cards.length === 0 ? (
                    <p className="board-column-empty instrument">No cards in this lane</p>
                  ) : null}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {detail && boardDetails ? (
        <Modal
          title={selectedBlip ? cardLabel(selectedBlip) : 'Blip unavailable'}
          onClose={closeDetail}
          size="kanban"
          fill
        >
          {selectedBlip ? (
            <BlipCard
              key={detail.id}
              {...readingProps(props)}
              blip={selectedBlip}
              readOnly={readOnly}
              onChanged={onChanged}
              template={radar}
              commentsEnabled={radar.commentsEnabled}
              reactionsEnabled={radar.reactionsEnabled}
              threadOpen={radar.commentsEnabled}
              decisions
              startEditing={detail.editing}
              keepConversationWhileEditing
              onDeleted={(id) => {
                if (closedDetail.current === id) closedDetail.current = null;
                setDetail((current) => (current?.id === id ? null : current));
                if (routeOpen === id) blipRoute?.close();
              }}
            />
          ) : (
            <p className="note">
              This blip is no longer available on this board. Close this popup to continue.
            </p>
          )}
        </Modal>
      ) : null}

      {hasMore ? (
        <div className="flex justify-center py-2">
          <button className="btn" onClick={onLoadMore}>
            Load more cards
          </button>
        </div>
      ) : null}
    </div>
  );
}
