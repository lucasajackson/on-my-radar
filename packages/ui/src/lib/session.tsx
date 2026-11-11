/** Who is signed in, and the app-wide radar list both the shell and routes read. */
import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import {
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { RadarDto, TopicDto, UserDto } from '@onmyradar/contract';
import { useNavigate } from '@tanstack/react-router';
import { ApiError, api } from './api';
import { CHARTER_DRAFTS, forgetDrafts } from './drafts';
import { notify } from '../components/primitives';

export const queryKeys = {
  session: ['session'] as const,
  authConfig: ['auth-config'] as const,
  radars: ['radars'] as const,
  radar: (id: string) => ['radar', id] as const,
  topics: ['topics'] as const,
  topic: (id: string) => ['topic', id] as const,
  topicMembers: (id: string) => ['topic-members', id] as const,
  facets: (id: string) => ['facets', id] as const,
  blips: (id: string, filters: unknown) => ['blips', id, filters] as const,
  dashboards: ['dashboards'] as const,
  tokens: ['tokens'] as const,
  grants: ['oauth-grants'] as const,
  /** Client-portal credentials and the helpdesks each reaches (HELPDESK §3.4). */
  integrations: ['integrations'] as const,
  repoAgents: ['repo-agents'] as const,
  repoAgent: (id: string) => ['repo-agent', id] as const,
  /*
    Everything else about one agent is keyed under `repo-agent-part` then its
    id, so a change invalidates the lot with one prefix and never touches a
    different agent's cache.
  */
  repoAgentParts: (id: string) => ['repo-agent-part', id] as const,
  repoAgentPart: (id: string, part: string, ...rest: unknown[]) =>
    ['repo-agent-part', id, part, ...rest] as const,
  models: (harness: string) => ['models', harness] as const,
  adminUsers: (state?: string) => ['admin-users', state ?? 'all'] as const,
  adminOverview: ['admin-overview'] as const,
  /** The whole catalog, hidden and deprecated included — the admin's view of it. */
  adminModels: ['admin-models'] as const,
  adminAgents: ['admin-agents'] as const,
  adminTokens: ['admin-tokens'] as const,
  subscriptions: (id: string) => ['subscriptions', id] as const,
  subscriptionDeliveries: (radarId: string, id: string) =>
    ['subscription-deliveries', radarId, id] as const,
  webhooks: (id: string) => ['webhooks', id] as const,
  tagBlips: (tag: string) => ['tag-blips', tag] as const,
  /** Keyed on the whole query string: the grammar is the input, so it is the key. */
  search: (q: string) => ['search', q] as const,
  /** Radar names and people the box may complete to. One call, cached. */
  searchSuggest: ['search-suggest'] as const,
  allTags: ['all-tags'] as const,
  dropBox: ['drop-box'] as const,
  comments: (blipId: string) => ['comments', blipId] as const,
  decisions: (blipId: string) => ['decisions', blipId] as const,
  /** Who can be addressed on a radar. Shared by every composer on its page. */
  members: (radarId: string) => ['members', radarId] as const,
  /** Root key, so invalidating it catches every notification list at once. */
  notificationsRoot: ['notifications'] as const,
  notifications: (filters: unknown) => ['notifications', filters] as const,
  notificationCounts: ['notification-counts'] as const,
  notificationSettings: ['notification-settings'] as const,
  /** What this browser holds for push. Local, but shared by every reader of it. */
  pushState: ['push-state'] as const,
  publicRadar: (slug: string) => ['public-radar', slug] as const,
  publicBlips: (slug: string) => ['public-blips', slug] as const,
};

interface SessionValue {
  user: UserDto | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionValue>({
  user: null,
  loading: true,
  error: null,
  refresh: () => Promise.resolve(),
});

export function SessionProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.session,
    queryFn: () => api.auth.session(),
    // The session is the root of every authorization decision in the UI; a
    // stale one shows the wrong thing, so it is never served from cache silently.
    staleTime: 30_000,
    retry: false,
  });
  // What this browser kept for one person (unsaved charter text) is not for the next: when the
  // signed-in account goes (signed out, expired) or becomes another, it goes with it.
  const seen = useRef<string | null | undefined>(undefined);
  const me = query.data ? (query.data.user?.id ?? null) : undefined;
  useEffect(() => {
    if (me === undefined) return;
    if (seen.current !== undefined && seen.current !== null && seen.current !== me)
      forgetDrafts(CHARTER_DRAFTS);
    seen.current = me;
  }, [me]);

  return (
    <SessionContext.Provider
      value={{
        user: query.data?.user ?? null,
        loading: query.isLoading,
        error: query.error,
        refresh: async () => {
          await client.invalidateQueries({ queryKey: queryKeys.session });
        },
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}

/**
 * Every cached list a blip can appear in, by root key.
 *
 * Four places kept their own copy of this list and none of them had the tag
 * page on it, so a due date, a state or a pin changed from anywhere stayed stale
 * on `/t/$tag` until something else refetched it. A new surface that lists
 * blips belongs here, once.
 */
const BLIP_LIST_ROOTS = [
  queryKeys.radars,
  ['blips'],
  ['search'],
  ['tag-blips'],
  ['widget-results'],
  ['widget-blips'],
] as const;

/** Refetch everything that could be showing a blip that just changed. */
export function invalidateBlipLists(client: QueryClient, deletedId?: string): Promise<void> {
  return Promise.all(
    BLIP_LIST_ROOTS.map((queryKey) =>
      client.invalidateQueries({
        queryKey,
        predicate: (query) =>
          !deletedId ||
          !(
            query.queryKey.length === 3 &&
            query.queryKey[0] === 'blips' &&
            query.queryKey[1] === 'detail' &&
            query.queryKey[2] === deletedId
          ),
      }),
    ),
  ).then(() => undefined);
}

export function useSession(): SessionValue {
  return useContext(SessionContext);
}

/**
 * Sign out, the one way.
 *
 * It was written three times — the sidebar, Settings and the waiting room — and
 * they disagreed. The waiting room did not clear the cache, so `/login` still
 * saw the pending user and bounced straight back to `/waiting` with a full
 * reload before settling. None of them caught a failed logout, which left an
 * unhandled rejection and a button that did nothing. The cache is cleared only
 * once the server has actually ended the session; until then the person is
 * still signed in and the screen should keep saying so.
 */
export function useSignOut(): () => Promise<void> {
  const client = useQueryClient();
  const navigate = useNavigate();
  return async () => {
    try {
      await api.auth.logout();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not sign out. Try again.', 'error');
      return;
    }
    forgetDrafts(CHARTER_DRAFTS);
    client.clear();
    notify('Signed out');
    void navigate({ to: '/login' });
  };
}

/** True on a single-user instance, where there is nobody to sign out as and nowhere to sign in. */
export function useSingleUser(): boolean {
  const { data } = useQuery({ queryKey: queryKeys.authConfig, queryFn: () => api.auth.config() });
  return data?.singleUser === true;
}

export function useRadars(enabled = true): UseQueryResult<{ radars: RadarDto[] }> {
  return useQuery({
    queryKey: queryKeys.radars,
    queryFn: () => api.radars.list(),
    enabled,
  });
}

/**
 * Every topic the caller owns or holds a grant on.
 *
 * Read by the sidebar and the `/radars` screen to group radars, so it is fetched
 * once at the shell level like the radar list rather than per surface.
 */
export function useTopics(enabled = true): UseQueryResult<{ topics: TopicDto[] }> {
  return useQuery({
    queryKey: queryKeys.topics,
    queryFn: () => api.topics.list(),
    enabled,
    // Read by the shell on every route; renames and moves invalidate it themselves.
    staleTime: 60_000,
  });
}

/**
 * Radars grouped by topic, with the ungrouped ones last.
 *
 * Shared by the sidebar and the `/radars` screen so the two cannot drift on what
 * "grouped" means. Three rules it enforces, all of them things that have to stay
 * true once the list becomes topic-organised:
 *
 * - **The drop box is never grouped.** It cannot be in a topic at all, and it is
 *   handled separately by both callers — it is passed through here only so a
 *   caller can filter it out in one place.
 * - **Smart radars are never grouped.** They cannot be in a topic either, so
 *   they keep their own section.
 * - **A topic with nothing visible in it does not appear.** A member who has
 *   been given the grouping but no radars should not see an empty heading; the
 *   topic itself is still reachable from its own screen.
 */
export function groupByTopic(radars: RadarDto[]): {
  groups: Array<{ topic: NonNullable<RadarDto['topic']>; radars: RadarDto[] }>;
  ungrouped: RadarDto[];
} {
  const groups = new Map<string, { topic: NonNullable<RadarDto['topic']>; radars: RadarDto[] }>();
  const ungrouped: RadarDto[] = [];

  for (const radar of radars) {
    if (!radar.topic) {
      ungrouped.push(radar);
      continue;
    }
    const existing = groups.get(radar.topic.id);
    if (existing) existing.radars.push(radar);
    else groups.set(radar.topic.id, { topic: radar.topic, radars: [radar] });
  }

  return {
    groups: [...groups.values()].sort((a, b) => a.topic.name.localeCompare(b.topic.name)),
    ungrouped,
  };
}

/**
 * The account's drop box, brought into existence on the first page load.
 *
 * This is the hook that was missing. `GET /api/radars/drop-box` is a GET that
 * may write — deliberately, so that asking for the drop box is the same act as
 * having one — but nothing in the SPA ever asked. `list_radars` only returns
 * radars that already exist, so for anyone who had not captured into the drop box over MCP
 * the drop box simply was not there: no sidebar entry, nowhere to drop, and
 * `read_drop_box` handing an agent an empty radar the person had never seen.
 *
 * Calling it here fixes that for **every** account rather than only new ones,
 * which is the reason the drop box is created on demand instead of at signup
 * (docs/DESIGN.md §6) — every account that already exists needs one too.
 *
 * Idempotent and race-safe on the server: a partial unique index decides, not
 * this call. `staleTime: Infinity` because a radar that exists cannot stop
 * existing by being asked for again; the sidebar's own list is what tracks its
 * name and count afterwards.
 */
export function useDropBox(enabled = true): UseQueryResult<{ radar: RadarDto }> {
  return useQuery({
    queryKey: queryKeys.dropBox,
    queryFn: () => api.radars.dropBox(),
    enabled,
    staleTime: Infinity,
    // A drop box that failed to appear must not retry in a loop behind a shell
    // the person is already using — the sidebar simply carries on without it.
    retry: 1,
  });
}
