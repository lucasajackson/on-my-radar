import { QueryError } from './query-error';
/**
 * The notification surfaces: the shared hooks, the line, the dashboard widget.
 *
 * Design-wise these are pure instrument panel. A notification is chrome — it is
 * *about* the ink rather than being ink itself — so the sentence is set in the
 * shell's sans, the metadata in `.instrument`, and the only colour is the
 * originating radar's own accent as a hairline rule down the left edge. That
 * rule is the same device the board uses on a card: it tells you which radar
 * something came from before you have read a word.
 *
 * The excerpt is the one place a person's own words appear, so it gets the
 * reading serif — the same tension the rest of the application is built on,
 * at the scale of a single line.
 */
import { useCallback, useEffect, useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AtSign,
  CalendarClock,
  Mail,
  Bell,
  Check,
  CircleCheck,
  CircleHelp,
  Flag,
  MessageSquare,
  Radio,
  Share2,
  Sparkles,
  ShieldCheck,
  Webhook,
  type LucideIcon,
} from 'lucide-react';
import type {
  NotificationBox,
  NotificationCountsDto,
  NotificationDto,
  NotificationKind,
} from '@onmyradar/contract';
import { NOTIFICATIONS } from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { notify } from './primitives';
import { accentStyle } from '../lib/theme';
import { RelativeTime } from './relative-time';
import { queryKeys } from '../lib/session';
import { useLivePoll } from '../lib/polling';
import { entry } from '../lib/registry';

/* -------------------------------------------------------------------------- */
/* Hooks                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The badge numbers, polled. The shell badges pass `box: 'needs_you'`: only what waits on the person
 * counts there, not agents reporting.
 *
 * Polling rather than a websocket or SSE, deliberately: the app runs one replica
 * with no sticky sessions and a rolling deploy drops long-lived connections
 * (docs/DESIGN.md, known limitations), so a stream would reconnect-storm on
 * every deploy for a payload that is three integers. Sixty seconds is slow
 * enough to be free and fast enough that a badge is never stale enough to
 * mislead; anything the person did themselves invalidates it immediately.
 */
export function useNotificationCounts(enabled = true, box?: NotificationBox) {
  const livePoll = useLivePoll();
  return useQuery<NotificationCountsDto>({
    queryKey: [...queryKeys.notificationCounts, box ?? 'all'],
    queryFn: () => api.notifications.counts(box),
    enabled,
    ...livePoll,
    // A failing badge must never retry in a loop behind a shell somebody is
    // already using. The rest of the app carries on without it.
    retry: 1,
  });
}

export function useNotifications(options: { unreadOnly?: boolean; limit?: number } = {}) {
  return useQuery({
    queryKey: queryKeys.notifications(options),
    queryFn: () => api.notifications.list(options),
    staleTime: 15_000,
  });
}

/** What "Clear all" can clear: the total less proposals, which only accept or reject removes. */
export const clearableTotal = (counts?: NotificationCountsDto) =>
  (counts?.total ?? 0) - (counts?.proposals ?? 0);

/** Refetch the list and the badges on entry: a proposal is decided on another page. */
export function useRefreshOnEnter() {
  const client = useQueryClient();
  useEffect(() => {
    void client.invalidateQueries({ queryKey: queryKeys.notificationsRoot });
    void client.invalidateQueries({ queryKey: queryKeys.notificationCounts });
  }, [client]);
}

/** Mark read / unread, refreshing both the list and the badges. */
export function useMarkRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { ids?: string[]; radarId?: string; all?: true; read?: boolean }) =>
      api.notifications.markRead(input),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.notificationsRoot }),
        client.invalidateQueries({ queryKey: queryKeys.notificationCounts }),
      ]);
    },
    // "Mark all read" that fails used to do nothing at all, visibly.
    onError: (err) => {
      notify(err instanceof ApiError ? err.message : 'Could not mark that read', 'error');
    },
  });
}

/* -------------------------------------------------------------------------- */
/* One line                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Total over the kinds, like the glyph map: a kind added to the contract without
 * a mark here is a type error. It was `Partial`, and `mention` and
 * `subscription_failed` had quietly fallen through to the generic bell.
 */
const KIND_ICON: Record<NotificationKind, LucideIcon> = {
  mention: AtSign,
  subscription_failed: Webhook,
  due: CalendarClock,
  email_received: Mail,
  // Waiting on you to release it: the review mark, not the comment one.
  reply_pending: ShieldCheck,
  // An amendment that has lost its place in the charter: a flag, like the orphan badge it points at.
  charter_orphaned: Flag,
  // A question waiting on you, and its answer coming back to whoever asked.
  decision: CircleHelp,
  decision_answered: CircleCheck,
  comment: MessageSquare,
  reaction: Sparkles,
  share: Share2,
  blip: Radio,
  // Both topic kinds are access changes rather than activity, so they share the
  // sharing mark: what happened is that somebody's reach changed.
  topic_share: Share2,
  topic_cascade: Share2,
};

export function NotificationLine({
  notification,
  onRead,
}: {
  notification: NotificationDto;
  onRead?: (id: string) => void;
}) {
  // An unknown stored kind renders as a neutral mark rather than breaking the
  // list — the same degradation rule as an unknown lane or reaction.
  const Icon = entry(KIND_ICON, notification.kind) ?? Bell;
  const radar = notification.radar;

  const body = (
    <>
      <span className="notification-mark" aria-hidden>
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="notification-title">{notification.title}</span>
        {notification.excerpt ? (
          <span className="notification-excerpt">{notification.excerpt}</span>
        ) : null}
        <span className="notification-meta instrument">
          {radar ? <span className="notification-radar">{radar.name}</span> : null}
          <span>
            <RelativeTime iso={notification.createdAt} />
          </span>
        </span>
      </span>
    </>
  );

  return (
    <li
      className={`notification ${notification.read ? 'is-read' : ''}`}
      style={radar ? accentStyle(radar.accent) : undefined}
    >
      {/*
        A notification that has lost its blip — deleted since — keeps its
        sentence but stops being a link. Pointing somewhere that 404s is worse
        than not pointing anywhere.
      */}
      {radar ? (
        <Link
          to="/radar/$radarId"
          params={{ radarId: radar.id }}
          search={notification.blipId ? { blip: notification.blipId } : {}}
          className="notification-body"
          onClick={() => {
            if (!notification.read) onRead?.(notification.id);
          }}
        >
          {body}
        </Link>
      ) : (
        <span className="notification-body">{body}</span>
      )}

      {notification.read ? null : (
        <button
          className="btn btn-ghost shrink-0 p-1.5"
          title="Mark as read"
          aria-label={`Mark as read: ${notification.title}`}
          onClick={() => onRead?.(notification.id)}
        >
          <Check className="h-3.5 w-3.5" />
        </button>
      )}
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* The dashboard widget                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Activity, on every dashboard, and it cannot be removed.
 *
 * "It can't be removed" is honoured by construction rather than by hiding a
 * control: this widget has **no row in `dashboard_widgets`**. It is not part of
 * the draggable grid at all, so there is nothing to delete, nothing to drag off
 * the edge, and no stored state in which a dashboard could come back without it.
 * Making it a real grid item and then special-casing the remove button would
 * have left exactly that state reachable — an older dashboard row, a failed
 * migration, a hand-edited layout — and "cannot be removed" would have quietly
 * become "usually present".
 *
 * The cost is that it cannot be moved or resized either. That is the right trade
 * for the one panel whose job is to be found without looking.
 *
 * **With nothing outstanding it renders nothing at all.** It used to collapse to
 * a single quiet line — "Nothing new — you are all caught up" — which is still a
 * full-width band, ~60px at the very top of the landing screen, spent to report
 * the absence of information. That is not a collapse, it is a smaller version of
 * the same cost.
 *
 * This contradicts what DESIGN §8 said, and the paragraph has been rewritten
 * rather than left standing. The argument it made was that the panel's position
 * has to be learnable, and that is still right — but "learnable" is about where
 * it appears when there IS something, and the entry point survives regardless:
 * Activity is a row on `/radars`, an item in the sidebar, and a tab on a phone,
 * all three of them badged. Nothing is lost by the empty case being silent.
 *
 * It still cannot be removed. That was the literal ask and it is still true by
 * construction — there is no row in `dashboard_widgets` to delete.
 */
export function NotificationWidget() {
  const { data: counts } = useNotificationCounts();
  const { data, error, refetch } = useNotifications({
    unreadOnly: true,
    limit: NOTIFICATIONS.widgetItems,
  });
  const markRead = useMarkRead();
  const client = useQueryClient();

  const items = useMemo(() => data?.items ?? [], [data]);
  const total = clearableTotal(counts);

  // Displaying the list is what "seen" means. It stops the ping without
  // claiming anything has been dealt with, so the badge keeps its count.
  const seen = counts?.unseen ?? 0;
  useEffect(() => {
    if (seen > 0 && items.length > 0) {
      void api.notifications
        .markSeen()
        .then(() => client.invalidateQueries({ queryKey: queryKeys.notificationCounts }))
        .catch(() => undefined);
    }
  }, [seen, items.length, client]);

  const readOne = useCallback((id: string) => markRead.mutate({ ids: [id] }), [markRead]);

  /*
    Nothing to say, so nothing said.

    Both conditions, not just `total`: `total` is the unread count and `items` is
    what this panel actually draws, and they can disagree for a moment while the
    list is refetching. Rendering an empty panel in that window would be a band
    of chrome that flickers in and out, which is worse than either state.
  */
  if (error) return <QueryError error={error} resource="Activity" retry={() => refetch()} />;
  if (total === 0 && items.length === 0) return null;

  return (
    <section className="panel notification-widget" aria-label="Activity">
      <header className="notification-widget-head">
        <span className="notification-widget-title">
          <Bell className="h-4 w-4 opacity-70" />
          <span className="instrument">Activity</span>
          {total > 0 ? (
            <span className="notification-badge">{total > 99 ? '99+' : total}</span>
          ) : null}
        </span>

        <span className="ml-auto flex items-center gap-1">
          {total > 0 ? (
            <button
              className="btn btn-ghost px-2 py-1 text-[12px]"
              onClick={() => markRead.mutate({ all: true })}
            >
              <Check className="h-3.5 w-3.5" />
              Clear all
            </button>
          ) : null}
          <Link to="/notifications" className="btn btn-ghost px-2 py-1 text-[12px]">
            All activity
          </Link>
        </span>
      </header>

      {items.length === 0 ? null : (
        <ul className="notification-list">
          {items.map((notification) => (
            <NotificationLine key={notification.id} notification={notification} onRead={readOne} />
          ))}
        </ul>
      )}
    </section>
  );
}
