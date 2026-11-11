/**
 * What else goes when a radar is deleted.
 *
 * The confirmation said "removes N blips and everything attached to them" and
 * stopped. A radar also carries things wired to the world outside it — a
 * receiver somebody set up to get its events, an inbound hook a script posts
 * to, a feed, an email address, the people it is shared with — and every one
 * of them is deleted with it (each references the radar ON DELETE CASCADE).
 * Somebody deleting a radar should read that list before, not discover it
 * from a broken integration after.
 */
import { useQueries } from '@tanstack/react-query';
import type { RadarDto } from '@onmyradar/contract';
import { api } from '../lib/api';

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function RadarAttachments({ radar }: { radar: Pick<RadarDto, 'id' | 'visibility'> }) {
  const [subscriptions, webhooks, feeds, members, email] = useQueries({
    queries: [
      {
        queryKey: ['delete-check', radar.id, 'subscriptions'],
        queryFn: () => api.subscriptions.list(radar.id),
      },
      {
        queryKey: ['delete-check', radar.id, 'webhooks'],
        queryFn: () => api.radars.webhooks(radar.id),
      },
      {
        queryKey: ['delete-check', radar.id, 'feeds'],
        queryFn: () => api.feeds.list(radar.id),
      },
      {
        queryKey: ['delete-check', radar.id, 'members'],
        queryFn: () => api.radars.members(radar.id),
      },
      {
        queryKey: ['delete-check', radar.id, 'email'],
        queryFn: () => api.emailCapture.radar(radar.id),
      },
    ],
  });
  const all = [subscriptions, webhooks, feeds, members, email];
  if (all.some((query) => query.isPending)) {
    return <p className="note">Checking what else is attached…</p>;
  }
  // A read that failed says so rather than implying there is nothing.
  if (all.some((query) => query.error)) {
    return (
      <p className="note">
        Could not check what else is attached. Webhooks, feeds, email capture and sharing on this
        radar are deleted with it.
      </p>
    );
  }
  const others = (members.data?.members ?? []).filter((member) => member.via !== 'owner');
  const items = [
    subscriptions.data?.subscriptions.length
      ? `${plural(subscriptions.data.subscriptions.length, 'outbound webhook', 'outbound webhooks')} — receivers stop getting events`
      : null,
    webhooks.data?.webhooks.length
      ? `${plural(webhooks.data.webhooks.length, 'inbound webhook', 'inbound webhooks')} — anything posting to them starts failing`
      : null,
    feeds.data?.feeds.length ? plural(feeds.data.feeds.length, 'RSS feed', 'RSS feeds') : null,
    email.data?.enabled && email.data.address ? `its email address, ${email.data.address}` : null,
    others.length
      ? `access for ${plural(others.length, 'person', 'people')} it is shared with`
      : null,
    radar.visibility === 'public' ? 'its public link' : null,
  ].filter((item): item is string => item !== null);
  if (items.length === 0) return null;
  return (
    <div className="mt-3">
      <p>Also deleted with it:</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
