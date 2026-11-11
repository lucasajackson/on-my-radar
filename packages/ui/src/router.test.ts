/**
 * The shape of the route tree.
 *
 * These assertions exist because of one change and its one hazard. Moving the
 * authenticated routes under a pathless layout route (`_app`) is what stops the
 * whole app frame being rebuilt on every navigation — but a pathless parent is
 * part of its children's *ids* while contributing nothing to their *paths*, and
 * those two facts are what make the change quiet when it goes wrong.
 *
 * A route id that nothing checks is a `useParams({ from })` that throws at
 * runtime on one screen. A path that changed by accident is a bookmark that
 * stopped working. Both are asserted here, so neither can be discovered by a
 * person instead of by CI.
 */
import { isRedirect } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import { router } from './router';
import { entry } from './lib/registry';

/** Every id in the tree, minus the root and the pathless layout itself. */
const ids = Object.keys(router.routesById).sort();

/** Paths that must stay outside the account guard. */
const PUBLIC_PATHS = [
  '/login',
  '/invite/$token',
  '/waiting',
  '/r/$slug',
  '/connect',
  '/connect/error',
];

/**
 * Paths that must sit inside it. `/` is included deliberately: home is the one
 * authenticated route whose path gives no hint that it is one.
 */
const AUTHENTICATED_PATHS = [
  '/',
  '/radars',
  '/radar/$radarId',
  '/radar/$radarId/settings',
  '/radar/$radarId/blip/$blipId',
  '/search',
  '/arrays',
  '/array/$topicId',
  '/repo',
  '/repo/new',
  '/repo/$agentId',
  '/repo/$agentId/tools',
  '/repo/$agentId/memory',
  '/repo/$agentId/activity',
  '/repo/$agentId/settings',
  '/notifications',
  '/t/$tag',
  '/settings',
  '/admin',
  '/admin/people',
  '/admin/models',
];

describe('the route tree', () => {
  it('puts every authenticated route under the pathless frame', () => {
    for (const path of AUTHENTICATED_PATHS) {
      const id = path === '/' ? '/_app/' : `/_app${path}`;
      expect(ids, `${path} should be addressed as ${id}`).toContain(id);
    }
  });

  it('leaves the public routes outside it', () => {
    for (const path of PUBLIC_PATHS) {
      expect(ids, `${path} must not be behind the account guard`).toContain(path);
    }
  });

  /**
   * The property that makes the whole change safe to ship: a pathless parent
   * renames ids and must not touch URLs. If this fails, somebody's bookmark
   * broke.
   */
  it('changes no URL', () => {
    for (const path of AUTHENTICATED_PATHS) {
      const id = path === '/' ? '/_app/' : `/_app${path}`;
      expect(entry(router.routesById, id)?.fullPath).toBe(path);
    }
  });

  /**
   * Every id named by a `useParams({ from })` or `useSearch({ from })` in the
   * SPA. Typed route ids are checked by `tsc`, but only against the router's
   * registered type — this asserts the same ids against the tree that is
   * actually built, which is what a route moved to the wrong parent breaks.
   */
  it('answers to the ids the screens name', () => {
    for (const id of [
      '/_app/radar/$radarId',
      '/_app/radar/$radarId/settings',
      '/_app/repo/$agentId',
      '/_app/search',
      '/_app/t/$tag',
      '/_app/array/$topicId',
      '/r/$slug',
    ]) {
      expect(ids).toContain(id);
    }
  });

  /**
   * The admin dashboard is a frame with sections under it: `/admin` keeps its
   * URL (the Settings and sidebar links, and the phone suite, point at it) and
   * lands on the Overview, and each section sits inside the frame, so the admin
   * gate in `AdminRoute` covers every one of them.
   */
  it('nests the admin sections under the admin frame', () => {
    expect(ids).toContain('/_app/admin/');
    expect(entry(router.routesById, '/_app/admin/')?.fullPath).toBe('/admin/');
    for (const id of ['/_app/admin/', '/_app/admin/people', '/_app/admin/models']) {
      const route = entry(router.routesById, id) as { parentRoute?: { id: string } } | undefined;
      expect(route?.parentRoute?.id).toBe('/_app/admin');
    }
  });

  /**
   * The frame is mounted once. Stated as a count rather than a reference so it
   * reads as the invariant it is: one guard, one shell, for the whole
   * authenticated section.
   */
  /*
    `/repo/new` is a literal segment beside `/repo/$agentId`; the router must
    rank it above the param, or "new" is fetched as an agent id.
  */
  it('opens the new-agent page at /repo/new rather than an agent called "new"', () => {
    const match = router.matchRoutes('/repo/new', {});
    expect(match.at(-1)?.routeId).toBe('/_app/repo/new');
    const tab = router.matchRoutes('/repo/abc/memory', {});
    expect(tab.map((m) => m.routeId)).toContain('/_app/repo/$agentId');
    expect(tab.at(-1)?.routeId).toBe('/_app/repo/$agentId/memory');
  });

  /**
   * A card's link opens the radar with that card on top: the blip is a child of
   * the radar, so the radar stays mounted, and `?blip=` keeps working beside it.
   */
  it('addresses a card as a child of its radar', () => {
    const match = router.matchRoutes('/radar/r1/blip/b1', {});
    expect(match.map((m) => m.routeId)).toEqual([
      '__root__',
      '/_app',
      '/_app/radar/$radarId',
      '/_app/radar/$radarId/blip/$blipId',
    ]);
    expect(match.at(-1)?.params).toEqual({ radarId: 'r1', blipId: 'b1' });
    expect(router.matchRoutes('/radar/r1', { blip: 'b1' }).at(-1)?.routeId).toBe(
      '/_app/radar/$radarId',
    );
  });

  /**
   * Emails, notifications and bookmarks hold the old vocabulary, so `/topics` and
   * `/topic/<id>` redirect to the array routes for good.
   */
  it('redirects the old topic URLs to the array URLs', () => {
    const thrownBy = (id: string, params: Record<string, string>): unknown => {
      const route = entry(router.routesById, id) as {
        options: { beforeLoad: (ctx: { params: Record<string, string> }) => void };
      };
      try {
        route.options.beforeLoad({ params });
      } catch (err) {
        return err;
      }
      return undefined;
    };
    const topic = thrownBy('/topic/$topicId', { topicId: 't1' });
    expect(isRedirect(topic) && topic.options).toMatchObject({
      to: '/array/$topicId',
      params: { topicId: 't1' },
      replace: true,
    });
    const topics = thrownBy('/topics', {});
    expect(isRedirect(topics) && topics.options).toMatchObject({ to: '/arrays', replace: true });
    expect(router.matchRoutes('/topic/t1', {}).at(-1)?.routeId).toBe('/topic/$topicId');
    expect(router.matchRoutes('/array/t1', {}).at(-1)?.routeId).toBe('/_app/array/$topicId');
  });

  it('mounts one frame, not one per route', () => {
    expect(ids.filter((id) => id === '/_app' || id === '_app')).toHaveLength(1);
  });
});
