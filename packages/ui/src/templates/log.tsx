/**
 * The log — a decision log, and the first template to earn a layout of its own.
 *
 * Reading list and decision log both shipped on the `stream` layout, and the
 * claim at the time was that costing no view code was the point of the
 * abstraction. It was half right: a template *should* be able to cost nothing.
 * But a template that costs nothing also does nothing, and three radars drawn by
 * the same component with the same order and the same card read as the same
 * thing — which is exactly what they were.
 *
 * What a log is, that a list is not: a **ledger**. Entries are grouped under the
 * lane they are in rather than running together, because "what have we decided"
 * and "what did we decide against" are different questions and a flat list
 * answers neither. Terminal lanes — rejected, superseded — are drawn quieter and
 * come last, so the top of the page is the state of play. The server has already
 * ordered them that way (`chronicle`, see `orderFor`), so grouping here is
 * reading the order rather than imposing a second one.
 *
 * Pinned entries lead, in their own group. Without that they would break a lane
 * run in half and the same heading would appear twice with no explanation; with
 * it, the reason they are out of lane order is written on the page.
 *
 * ## Widths
 *
 * Below 1000px of pane the ledger is the page, as above. From there it is an index of the same
 * groups, the open decision (the one entry of the ledger that stays drawn) and, beside it at xl or
 * above it at lg, a panel of facts: index | decision | context. One markup; `.cols` in styles.css
 * decides which parts are on screen. The open decision is `?sel=<id>` and, like the discussion's
 * open thread, is held while the radar reorders itself under it.
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import type { BlipDto } from '@onmyradar/contract';
import { findStatus, statusesFor } from '@onmyradar/contract';
import { BlipCard } from '../components/blips';
import { Empty, Spinner } from '../components/primitives';
import { RelativeTime } from '../components/relative-time';
import { useSelectedItem } from '../components/radar-layout';
import { readingProps, type TemplateViewProps } from './index';
import { SidePanel, nameOf } from './item-panel';

interface LogGroup {
  key: string;
  label: string;
  terminal: boolean;
  items: BlipDto[];
}

export function LogView(props: TemplateViewProps) {
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
  const groups = useMemo(() => {
    const lanes = statusesFor(radar.template, radar.templateConfig);
    const out: LogGroup[] = [];
    for (const blip of blips) {
      // Pinned is the outermost sort key on the server too, so this group can
      // only ever be the first one — it is reading the order, not re-sorting.
      const lane = blip.pinned
        ? null
        : findStatus(radar.template, blip.status, radar.templateConfig);
      const key = blip.pinned ? '_pinned' : (lane?.id ?? '_unfiled');
      const last = out[out.length - 1];
      if (last && last.key === key) {
        last.items.push(blip);
        continue;
      }
      out.push({
        key,
        label: blip.pinned ? 'Pinned' : (lane?.label ?? 'Unfiled'),
        // An unfiled entry is not terminal: it is one this template has no lane
        // for, usually because the radar was switched templates. It sits last
        // anyway, by rank, but it should not be greyed out as though settled.
        terminal: !blip.pinned && lane?.terminal === true,
        items: [blip],
      });
    }
    // Nothing to head a log with when the template has lost its lanes entirely.
    return lanes.length === 0 ? [{ key: '_all', label: '', terminal: false, items: blips }] : out;
  }, [blips, radar.template, radar.templateConfig]);

  const { sel, select } = useSelectedItem();
  const [held, setHeld] = useState<string | null>(null);
  const first = blips[0];
  useEffect(() => {
    if (!held && first) setHeld(first.id);
  }, [held, first]);
  const open = blips.find((blip) => blip.id === (sel ?? held)) ?? first;

  if (loading && blips.length === 0) return <Spinner label="Reading the log" />;
  if (blips.length === 0) return <Empty title={emptyTitle} hint={emptyHint} />;

  const more = (className: string) =>
    hasMore ? (
      <div className={`flex justify-center py-4 ${className}`}>
        <button className="btn" onClick={onLoadMore}>
          Earlier entries
        </button>
      </div>
    ) : null;

  return (
    <div className="cols cols-lg3" data-view="ledger">
      <nav className="cols-index" aria-label="Decisions">
        {groups.map((group) => (
          <Fragment key={group.key}>
            {group.label ? (
              <div className={`log-lane ${group.terminal ? 'is-terminal' : ''}`}>
                <span className="instrument">{group.label}</span>
                <span className="instrument log-lane-count">{group.items.length}</span>
              </div>
            ) : null}
            {group.items.map((blip) => (
              <button
                key={blip.id}
                className={`disc-topic ${blip.id === open?.id ? 'is-selected' : ''} ${group.terminal ? 'is-settled' : ''}`}
                aria-current={blip.id === open?.id ? 'true' : undefined}
                onClick={() => select(blip.id)}
              >
                <span className="disc-topic-title">{nameOf(blip)}</span>
                <span className="instrument">
                  <RelativeTime iso={blip.lastActivityAt} />
                </span>
              </button>
            ))}
          </Fragment>
        ))}
        {more('')}
      </nav>
      {open ? (
        <SidePanel
          blip={open}
          radar={radar}
          loaded={new Set(blips.map((blip) => blip.id))}
          onSelect={select}
        />
      ) : null}
      <div className="cols-main">
        <div className="log">
          {groups.map((group) => (
            <Fragment key={group.key}>
              {group.label ? (
                <div className={`log-lane ${group.terminal ? 'is-terminal' : ''}`}>
                  <span className="instrument">{group.label}</span>
                  <span className="instrument log-lane-count">{group.items.length}</span>
                </div>
              ) : null}
              {group.items.map((blip) => (
                <div
                  key={blip.id}
                  className={`log-entry ${group.terminal ? 'is-terminal' : ''}`}
                  data-open={blip.id === open?.id ? '' : undefined}
                  // Grouping already says which lane this is, so the card is spared
                  // repeating it — the same "says it twice" rule the board card
                  // follows inside its column.
                >
                  <BlipCard
                    {...readingProps(props)}
                    blip={blip}
                    readOnly={readOnly}
                    isNew={blip.id === newestId}
                    onChanged={onChanged}
                    template={radar}
                    commentsEnabled={radar.commentsEnabled}
                    reactionsEnabled={radar.reactionsEnabled}
                    /*
                  No swipe here, and it is the one list template without it.
                  This template's lanes are Proposed / Accepted / Rejected /
                  Superseded, so the gesture that means "done" everywhere else
                  would mean **accepting a decision** — and "later" has no lane
                  to land in at all. Accepting a decision with a thumb is
                  precisely the kind of act that should cost a deliberate
                  control, which is also why the template sets
                  `showTriage: false` in the first place.
                */
                  />
                </div>
              ))}
            </Fragment>
          ))}

          {more('log-more')}
          {loadingMore ? <Spinner label="More" /> : null}
        </div>
      </div>
    </div>
  );
}
