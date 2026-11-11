import { QueryError } from '../components/query-error';
/**
 * Everything that has happened, in one place.
 *
 * The dashboard widget is the glance; this is the page you come to when the
 * glance is not enough — the full history, read and unread, with the controls
 * that clear it. Same line component in both, so a notification reads
 * identically wherever it is shown.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Check, Settings } from 'lucide-react';
import type { NotificationBox } from '@onmyradar/contract';
import { api } from '../lib/api';
import { queryKeys } from '../lib/session';
import { Empty, Spinner } from '../components/primitives';
import {
  NotificationLine,
  useMarkRead,
  useNotificationCounts,
  useRefreshOnEnter,
} from '../components/notifications';
import { Segmented } from '../components/repo-common';
import { useDocumentTitle } from '../lib/title';

export function NotificationsRoute() {
  useDocumentTitle('Activity');
  useRefreshOnEnter();
  const [unreadOnly, setUnreadOnly] = useState(false);
  /*
    Two boxes: what waits on you (questions agents asked, mentions by people), and what agents
    and the system report. Your real asks used to be lost among progress pings.
  */
  const [box, setBox] = useState<NotificationBox>('needs_you');
  const { data: needsCounts } = useNotificationCounts(true, 'needs_you');
  const { data: reportedCounts } = useNotificationCounts(true, 'agents_reported');
  const markRead = useMarkRead();

  const query = useInfiniteQuery({
    queryKey: queryKeys.notifications({ page: true, unreadOnly, box }),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.notifications.list({
        unreadOnly: unreadOnly || undefined,
        box,
        cursor: pageParam,
        limit: 30,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const proposals = query.data?.pages[0]?.pendingProposals ?? [];
  const total = (box === 'needs_you' ? needsCounts : reportedCounts)?.total ?? 0;
  const unreadIds = items.filter((n) => !n.read).map((n) => n.id);

  return (
    <div className="mx-auto flex max-w-[820px] flex-col gap-4 px-4 py-5 sm:px-6">
      <header className="flex flex-wrap items-center gap-3">
        {/*
          `basis-full` below `sm`, so the controls wrap onto their own line
          rather than squeezing the title. With `flex-1` alone the heading
          shrank until "5 outstanding" broke over two lines and ran underneath
          the buttons — this page had never been seen at a phone width.
        */}
        <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
          <h1 className="text-[21px] font-semibold tracking-tight">Activity</h1>
          {/* Silent at zero. The empty state below is the one place this
              product says "nothing outstanding", and it said it here as well —
              the same fact, twice, 200px apart. */}
          {total > 0 ? <p className="instrument mt-1">{total} outstanding</p> : null}
        </div>

        <div className="flex items-center gap-1.5">
          {/*
            A filter rather than two tabs: "unread" is a narrowing of the same
            list, and tabs would imply two different things to read.
          */}
          <button
            className="btn"
            aria-pressed={unreadOnly}
            // On reads as on: tinted like your own reaction, not only an
            // outline colour that is easy to take for hover.
            style={{
              borderColor: unreadOnly ? 'var(--accent-from)' : 'var(--line)',
              color: unreadOnly ? 'var(--accent-from)' : undefined,
              background: unreadOnly
                ? 'color-mix(in srgb, var(--accent-from) 14%, var(--ink-800))'
                : undefined,
            }}
            onClick={() => setUnreadOnly((v) => !v)}
          >
            Unread only
          </button>

          {/* Never "all": that would also clear the questions waiting on you. */}
          {box === 'agents_reported' && unreadIds.length > 0 ? (
            <button
              className="btn"
              onClick={() => markRead.mutate({ ids: unreadIds.slice(0, 200) })}
            >
              <Check className="h-4 w-4" />
              Mark these read
            </button>
          ) : null}

          <Link
            to="/settings/notifications"
            className="btn btn-ghost p-2"
            title="Notification settings"
            aria-label="Notification settings"
          >
            <Settings className="h-4 w-4" />
          </Link>
        </div>
      </header>

      <Segmented
        label="Activity box"
        value={box}
        onChange={setBox}
        options={[
          {
            value: 'needs_you',
            label: `Needs you${needsCounts?.total ? ` · ${needsCounts.total}` : ''}`,
          },
          {
            value: 'agents_reported',
            label: `Agents reported${reportedCounts?.total ? ` · ${reportedCounts.total}` : ''}`,
          },
        ]}
      />

      {proposals.length > 0 ? (
        <ul
          className="notification-list panel overflow-hidden"
          aria-label="Prompt changes to review"
        >
          {proposals.map((p) => (
            <li key={p.id} className="px-4 py-3 text-[14px]">
              <Link to="/repo/$agentId" params={{ agentId: p.agentId }} className="accent-text">
                {p.editorName ?? p.agentName} proposed a change to {p.agentName}’s prompt
              </Link>
              {p.note ? <p className="instrument mt-1">{p.note}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {query.isLoading ? (
        <Spinner label="Loading activity" />
      ) : query.error ? (
        <QueryError error={query.error} resource="Activity" retry={() => query.refetch()} />
      ) : items.length === 0 && proposals.length === 0 ? (
        <Empty
          title={
            unreadOnly
              ? 'Nothing outstanding'
              : box === 'needs_you'
                ? 'Nothing needs you'
                : 'No activity yet'
          }
          hint={
            box === 'needs_you'
              ? 'Questions an agent asks you, and mentions by people, wait here.'
              : unreadOnly
                ? 'Everything has been dealt with.'
                : 'When somebody comments on a blip of yours, reacts to one, or shares a radar with you, it lands here.'
          }
        />
      ) : (
        <ul className="notification-list panel overflow-hidden">
          {items.map((notification) => (
            <NotificationLine
              key={notification.id}
              notification={notification}
              onRead={(id) => markRead.mutate({ ids: [id] })}
            />
          ))}
        </ul>
      )}

      {query.hasNextPage ? (
        <div className="flex justify-center">
          <button
            className="btn"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
