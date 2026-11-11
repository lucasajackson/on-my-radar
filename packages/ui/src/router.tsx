/**
 * Routes.
 *
 * Code-based rather than file-based: the route table is small enough to read in
 * one screen, and keeping it explicit makes the public/authenticated split
 * obvious — `/r/$slug` and `/login` deliberately sit outside the shell.
 *
 * ## The frame is a route, not a wrapper
 *
 * Every authenticated route used to render its own `<RequireAccount>`, and the
 * shell inside it. A guard written that way is a *component* of each route, so
 * React unmounts it on every navigation and mounts a new one: the sidebar, the
 * tab bar and the whole frame were torn down and rebuilt to move between two
 * screens that both live inside them.
 *
 * `appRoute` is a **pathless layout route** — an `id` and no `path`, so it adds
 * nothing to any URL — which renders the guard and the shell once with an
 * `<Outlet/>` beneath. Navigating between its children now swaps only the panel.
 *
 * The cost is visible and worth naming: a pathless parent is part of its
 * children's route ids, so `/radar/$radarId` is addressed as
 * `/_app/radar/$radarId` by anything that names a route rather than a path —
 * `useParams({ from })` and `useSearch({ from })`. Paths are untouched, so every
 * `<Link to>`, every `navigate({ to })` and every URL a person has bookmarked
 * mean exactly what they meant before.
 */
import { useEffect, useRef } from 'react';
import {
  createRootRoute,
  lazyRouteComponent,
  Link,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router';
import { safeNextPath } from '@onmyradar/contract';
import { AppShell } from './components/shell';
import { QueryError } from './components/query-error';
import { Spinner, ToastHost } from './components/primitives';
import { useSession } from './lib/session';
import { useVisualViewport } from './lib/viewport';
const AdminRoute = lazyRouteComponent(() => import('./routes/admin'), 'AdminRoute');
const AdminOverviewRoute = lazyRouteComponent(
  () => import('./routes/admin-overview'),
  'AdminOverviewRoute',
);
const AdminPeopleRoute = lazyRouteComponent(
  () => import('./routes/admin-people'),
  'AdminPeopleRoute',
);
const AdminModelsRoute = lazyRouteComponent(
  () => import('./routes/admin-models'),
  'AdminModelsRoute',
);
const AdminAgentsRoute = lazyRouteComponent(
  () => import('./routes/admin-agents'),
  'AdminAgentsRoute',
);
const ConnectRoute = lazyRouteComponent(() => import('./routes/connect'), 'ConnectRoute');
const HomeRoute = lazyRouteComponent(() => import('./routes/home'), 'HomeRoute');
const InviteRoute = lazyRouteComponent(() => import('./routes/invite'), 'InviteRoute');
const NotificationsRoute = lazyRouteComponent(
  () => import('./routes/notifications'),
  'NotificationsRoute',
);
const LoginRoute = lazyRouteComponent(() => import('./routes/login'), 'LoginRoute');
const GuestSupportRoute = lazyRouteComponent(
  () => import('./routes/guest-support'),
  'GuestSupportRoute',
);
const SupportRoute = lazyRouteComponent(() => import('./routes/support'), 'SupportRoute');
const OauthErrorRoute = lazyRouteComponent(() => import('./routes/oauth-error'), 'OauthErrorRoute');
const PublicRadarRoute = lazyRouteComponent(
  () => import('./routes/public-radar'),
  'PublicRadarRoute',
);
const RadarRoute = lazyRouteComponent(() => import('./routes/radar'), 'RadarRoute');
import { RADAR_SETTINGS_SECTIONS } from './lib/radar-settings';
import { legacySettingsTarget } from './lib/settings-sections';
const RadarSettingsRoute = lazyRouteComponent(
  () => import('./routes/radar-settings'),
  'RadarSettingsRoute',
);
const RadarsRoute = lazyRouteComponent(() => import('./routes/radars'), 'RadarsRoute');
const SearchRoute = lazyRouteComponent(() => import('./routes/search'), 'SearchRoute');
const TopicRoute = lazyRouteComponent(() => import('./routes/topic'), 'TopicRoute');
const TopicsRoute = lazyRouteComponent(() => import('./routes/topics'), 'TopicsRoute');
const AgentsRoute = lazyRouteComponent(() => import('./routes/repo'), 'AgentsRoute');
const NewAgentRoute = lazyRouteComponent(() => import('./routes/repo-new'), 'NewAgentRoute');
const AgentLayoutRoute = lazyRouteComponent(
  () => import('./routes/repo-agent'),
  'AgentLayoutRoute',
);
const AgentPromptTab = lazyRouteComponent(() => import('./components/repo-prompt'), 'PromptTab');
const AgentToolsTab = lazyRouteComponent(() => import('./components/repo-tools'), 'ToolsTab');
const AgentBriefsTab = lazyRouteComponent(() => import('./components/repo-briefs'), 'BriefsTab');
const AgentMemoryTab = lazyRouteComponent(() => import('./components/repo-memory'), 'MemoryTab');
const AgentActivityTab = lazyRouteComponent(
  () => import('./components/repo-activity'),
  'ActivityTab',
);
const AgentSettingsTab = lazyRouteComponent(
  () => import('./components/repo-settings'),
  'SettingsTab',
);
const settingsPage = () => import('./routes/settings');
const SettingsLayout = lazyRouteComponent(settingsPage, 'SettingsLayout');
const SettingsHome = lazyRouteComponent(settingsPage, 'SettingsHome');
const ProfileSettings = lazyRouteComponent(settingsPage, 'ProfileSettings');
const NotificationsSettings = lazyRouteComponent(settingsPage, 'NotificationsSettings');
const ConnectionsSettings = lazyRouteComponent(settingsPage, 'ConnectionsSettings');
const EmailSettings = lazyRouteComponent(settingsPage, 'EmailSettings');
const DataSettings = lazyRouteComponent(settingsPage, 'DataSettings');
const TagRoute = lazyRouteComponent(() => import('./routes/tag'), 'TagRoute');
const WaitingRoute = lazyRouteComponent(() => import('./routes/waiting'), 'WaitingRoute');

/**
 * The one place the visual viewport is measured. Everything that has to stay
 * clear of the iOS keyboard reads the custom properties it publishes — see
 * `lib/viewport.ts` for why `dvh` is not enough.
 */
function RootLayout() {
  useVisualViewport();
  return (
    <>
      <Outlet />
      <ToastHost />
    </>
  );
}

const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: () => <NotFound />,
});

/**
 * Gate for everything inside the shell, and the shell itself. A pending account
 * is sent to the waiting room rather than shown an app it cannot use, and the
 * path being visited is carried through the login round trip.
 *
 * Mounted once, by `appRoute`, for the whole authenticated section — see the
 * note at the top of this file. Everything it renders therefore survives a
 * navigation, which is what makes frame-level state (a scroll position, an open
 * filter, a live connection) possible to hold in ordinary component state
 * rather than in a module that outlives the tree.
 */
function AppFrame() {
  const { user, loading, error, refresh } = useSession();
  const navigate = useNavigate();
  const path = useRouterState({ select: (state) => state.location.href });
  // This guard stays mounted through the pending navigation it triggers, and
  // `path` updates immediately — so without a latch the effect re-fires with the
  // URL it just produced, nesting it inside itself once per pass. That is what
  // grew /login?next=… exponentially until the request line hit nginx's limit
  // and returned 414, which made SSO unreachable. `safeNextPath` refuses a
  // /login destination as well, so the recursion cannot restart from a stale URL.
  const redirected = useRef(false);

  useEffect(() => {
    if (loading || error || redirected.current) return;
    if (!user) {
      redirected.current = true;
      const next = safeNextPath(path);
      void navigate({ to: '/login', search: next ? { next } : {}, replace: true });
    } else if (user.state !== 'active') {
      redirected.current = true;
      void navigate({ to: '/waiting', replace: true });
    }
  }, [error, loading, navigate, path, user]);

  // Let the guard arm again once a real session appears, so a later sign-out
  // still redirects rather than leaving a dead screen.
  useEffect(() => {
    if (user && user.state === 'active') redirected.current = false;
  }, [user]);

  if (error) return <QueryError error={error} resource="Session" retry={refresh} />;
  if (loading) return <Spinner label="Signing you in" />;
  if (!user || user.state !== 'active') return <Spinner label="One moment" />;
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

/**
 * The authenticated section. Pathless: `id` and no `path`, so it contributes
 * nothing to any URL and exists only to hold `AppFrame` above its children.
 */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_app',
  component: AppFrame,
});

function NotFound() {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 px-6 py-20 text-center">
      <h1 className="text-[19px] font-semibold tracking-tight">Nothing here</h1>
      <p className="max-w-sm text-[13.5px] text-[color:var(--paper-dim)]">
        That address does not point at anything on On My Radar.
      </p>
      <Link to="/" className="btn mt-2">
        Go home
      </Link>
    </div>
  );
}

/* ------------------------------ public routes ---------------------------- */

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  // Both are optional: navigating to /login with no search must stay legal.
  validateSearch: (search: Record<string, unknown>): { next?: string; error?: string } => ({
    ...(typeof search['next'] === 'string' ? { next: search['next'] } : {}),
    ...(typeof search['error'] === 'string' ? { error: search['error'] } : {}),
  }),
  component: LoginRoute,
});

/**
 * Outside the shell, beside `/login`, because it *is* `/login` wearing an
 * invitation — the person following the link has no session and may have no
 * account at all.
 */
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invite/$token',
  component: InviteRoute,
});

const waitingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/waiting',
  component: WaitingRoute,
});

const guestSupportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/help',
  component: GuestSupportRoute,
});
const supportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/support',
  validateSearch: (search: Record<string, unknown>): { request?: string } => ({
    ...(typeof search['request'] === 'string' && /^[0-9a-f-]{36}$/i.test(search['request'])
      ? { request: search['request'] }
      : {}),
  }),
  component: SupportRoute,
});

const publicRadarRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/r/$slug',
  component: PublicRadarRoute,
});

const connectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/connect',
  validateSearch: (search: Record<string, unknown>) => search,
  component: ConnectRoute,
});

// Deliberately NOT under /oauth: the API owns that whole namespace, and the
// not-found handler answers /oauth/* with JSON — so an SPA route there could
// never render. This page is where /oauth/authorize sends a request it cannot
// safely bounce back to the client.
const oauthErrorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/connect/error',
  validateSearch: (search: Record<string, unknown>): { message?: string } =>
    typeof search['message'] === 'string' ? { message: search['message'] } : {},
  component: OauthErrorRoute,
});

/* --------------------------- authenticated routes ------------------------ */

const homeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  component: HomeRoute,
});

/**
 * The radar index. It is a route rather than a drawer so that drilling into a
 * radar is real navigation — the browser's back gesture returns here, which is
 * exactly what an overlay could never give.
 */
const radarsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/radars',
  component: RadarsRoute,
});

const radarRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/radar/$radarId',
  /**
   * `?blip=` is where a notification points. Optional, and validated loosely on
   * purpose: an unknown id simply finds nothing to scroll to, which is the right
   * behaviour for a blip that has been deleted since the notification was
   * written — the page still loads.
   */
  validateSearch: (search: Record<string, unknown>): { blip?: string; sel?: string } => ({
    ...(typeof search['blip'] === 'string' ? { blip: search['blip'] } : {}),
    // The open item of a template that shows an index beside it (`useSelectedItem`).
    ...(typeof search['sel'] === 'string' ? { sel: search['sel'] } : {}),
  }),
  remountDeps: ({ params }) => params.radarId,
  component: RadarRoute,
});

/**
 * One card's stable link. A child of the radar, not a sibling, so opening a card
 * keeps the radar mounted behind it (its filters, its scroll, its lanes); the
 * radar's own component reads the card id and draws the modal.
 */
const radarBlipRoute = createRoute({
  getParentRoute: () => radarRoute,
  path: '/blip/$blipId',
});

/**
 * Everything that configures one radar.
 *
 * A route rather than the 512px modal it used to be, for the reason `/radars` is
 * a route: it is already two screens of content, a URL makes it linkable and
 * back-gesture-able, and the section is in the URL so "who can see this radar"
 * is a link somebody can send.
 *
 * `?section=` is validated against the registry and falls back rather than
 * erroring — an unknown section is a settings page open on Identity, which is
 * the right behaviour for a link written against an older build.
 */
const radarSettingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/radar/$radarId/settings',
  validateSearch: (search: Record<string, unknown>): { section?: string } =>
    typeof search['section'] === 'string' &&
    (RADAR_SETTINGS_SECTIONS as readonly string[]).includes(search['section'])
      ? { section: search['section'] }
      : {},
  component: RadarSettingsRoute,
});

/**
 * Universal search. `?q=` carries the whole query — words and filters together —
 * so a search is a link somebody can send, and the back gesture undoes one.
 * Validated loosely: an unparseable query is not an error, it is a query that
 * finds nothing and says which part it could not read.
 */
const searchRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/search',
  validateSearch: (
    search: Record<string, unknown>,
  ): { q?: string; radarId?: string; preferRadarId?: string; blip?: string } => ({
    ...(typeof search['q'] === 'string' ? { q: search['q'] } : {}),
    ...(typeof search['radarId'] === 'string' ? { radarId: search['radarId'] } : {}),
    ...(typeof search['preferRadarId'] === 'string'
      ? { preferRadarId: search['preferRadarId'] }
      : {}),
    ...(typeof search['blip'] === 'string' ? { blip: search['blip'] } : {}),
  }),
  component: SearchRoute,
});

/**
 * The array index (an array is a group of radars; the code still says topic).
 * Registered before `/array/$topicId` for readability only — the paths do not
 * collide, `/arrays` is its own literal segment.
 *
 * It exists because `/radars` had no counterpart: an array could be made and
 * managed one at a time, and there was nowhere that listed them. The sidebar's
 * Arrays heading points here, the same way its Radars heading points at
 * `/radars`.
 */
const topicsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/arrays',
  component: TopicsRoute,
});

/** An array: what is in it, who can reach it, and the cascade switch. */
const topicRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/array/$topicId',
  // As for radars: array A's half-typed invite must not survive into cached
  // array B, where Send would invite that person to the wrong array.
  remountDeps: ({ params }) => params.topicId,
  component: TopicRoute,
});

/**
 * The old names. Emails, notifications and bookmarks hold `/topics` and
 * `/topic/<id>`, so these stay for good. They hang off the root, ahead of the
 * account guard: the redirect needs no session, and the array route then asks
 * for one as usual.
 */
const legacyTopicsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/topics',
  beforeLoad: () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router's redirect is thrown by design
    throw redirect({ to: '/arrays', replace: true });
  },
});
const legacyTopicRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/topic/$topicId',
  beforeLoad: ({ params }) => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router's redirect is thrown by design
    throw redirect({ to: '/array/$topicId', params: { topicId: params.topicId }, replace: true });
  },
});

/**
 * The Agent Repo: agents — a prompt and a memory — that follow a person to any
 * device. At `/repo`, not `/agents`: onmyradar.io is split between the app and
 * the marketing site by path, and the marketing site owns `/agents`
 * (docs/ARCHITECTURE.md, "One hostname, two origins").
 */
const agentsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/repo',
  component: AgentsRoute,
});

/** A new agent is a page of its own: a prompt is too big a thing to write in a dialog. */
const newAgentRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/repo/new',
  component: NewAgentRoute,
});

/**
 * What an agent's page carries in its query string. All of it on the layout,
 * so every tab reads one shape: the linkable dialogs (`use`, `share`), the
 * version History opens on (`history`), the profile open on Tools
 * (`profile`), the brief open on Briefs (`b`), and the memory open on Memory (`m`). Validated loosely — an
 * unknown value is simply absent, which is the right reading of a link
 * written against an older build.
 */
export interface AgentSearch {
  /**
   * A tool, as the link spelled it. Resolved to a registry id by the agent
   * page, not here: the harness registry imports zod at module level, and
   * importing it into the router put all of zod in the main chunk.
   */
  use?: string;
  share?: true;
  history?: number;
  profile?: string;
  m?: string;
  /** The brief open on Briefs, by name. */
  b?: string;
}

const agentRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/repo/$agentId',
  validateSearch: (search: Record<string, unknown>): AgentSearch => {
    const use = typeof search['use'] === 'string' ? search['use'].slice(0, 40) : '';
    const history = Number(search['history']);
    return {
      ...(use ? { use } : {}),
      ...(search['share'] === true || search['share'] === '1' || search['share'] === 1
        ? { share: true as const }
        : {}),
      ...(Number.isInteger(history) && history > 0 ? { history } : {}),
      ...(typeof search['profile'] === 'string' ? { profile: search['profile'] } : {}),
      ...(typeof search['m'] === 'string' ? { m: search['m'] } : {}),
      ...(typeof search['b'] === 'string' ? { b: search['b'].slice(0, 64) } : {}),
    };
  },
  /*
    One agent's page must not survive into the next: going from agent A to a
    cached agent B kept A's forms on screen, and Save wrote them onto B.
  */
  remountDeps: ({ params }) => params.agentId,
  component: AgentLayoutRoute,
});

const agentPromptRoute = createRoute({
  getParentRoute: () => agentRoute,
  path: '/',
  component: AgentPromptTab,
});
const agentToolsRoute = createRoute({
  getParentRoute: () => agentRoute,
  path: 'tools',
  component: AgentToolsTab,
});
const agentBriefsRoute = createRoute({
  getParentRoute: () => agentRoute,
  path: 'briefs',
  component: AgentBriefsTab,
});
const agentMemoryRoute = createRoute({
  getParentRoute: () => agentRoute,
  path: 'memory',
  component: AgentMemoryTab,
});
const agentActivityRoute = createRoute({
  getParentRoute: () => agentRoute,
  path: 'activity',
  component: AgentActivityTab,
});
const agentSettingsRoute = createRoute({
  getParentRoute: () => agentRoute,
  path: 'settings',
  component: AgentSettingsTab,
});

const notificationsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/notifications',
  component: NotificationsRoute,
});

/** Every blip carrying one tag, from every radar the viewer can read. */
const tagRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/t/$tag',
  // "Often with #other" links tag to tag; each tag is its own page state.
  remountDeps: ({ params }) => params.tag,
  component: TagRoute,
});

/**
 * Account settings, one URL per section (`lib/settings-sections.ts`). Links
 * written for the old single page — `#email-capture` — are redirected to their
 * section before anything renders.
 */
const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings',
  beforeLoad: ({ location }) => {
    const target = legacySettingsTarget(location.pathname, location.hash);
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router's redirect is thrown by design
    if (target) throw redirect({ to: target.to, replace: true });
  },
  component: SettingsLayout,
});
const settingsHomeRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/',
  component: SettingsHome,
});
const settingsProfileRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'profile',
  component: ProfileSettings,
});
const settingsNotificationsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'notifications',
  component: NotificationsSettings,
});
const settingsConnectionsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'connections',
  component: ConnectionsSettings,
});
const settingsEmailRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'email',
  component: EmailSettings,
});
const settingsDataRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'data',
  component: DataSettings,
});

const adminRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/admin',
  component: AdminRoute,
});

/** The admin dashboard's sections, inside its frame (`routes/admin.tsx`). */
const adminOverviewRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/',
  component: AdminOverviewRoute,
});
const adminPeopleRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/people',
  component: AdminPeopleRoute,
});
const adminAgentsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/agents',
  component: AdminAgentsRoute,
});
const adminModelsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/models',
  component: AdminModelsRoute,
});

/**
 * The split the file header promises, made structural: the public routes hang
 * off the root, everything that needs an account hangs off `appRoute`. A route
 * added to the wrong list is now a route that renders in the wrong frame, which
 * is a great deal more obvious than a forgotten `<RequireAccount>` wrapper.
 */
const routeTree = rootRoute.addChildren([
  loginRoute,
  inviteRoute,
  waitingRoute,
  supportRoute,
  guestSupportRoute,
  publicRadarRoute,
  connectRoute,
  oauthErrorRoute,
  legacyTopicsRoute,
  legacyTopicRoute,
  appRoute.addChildren([
    homeRoute,
    radarsRoute,
    radarRoute.addChildren([radarBlipRoute]),
    radarSettingsRoute,
    searchRoute,
    topicsRoute,
    topicRoute,
    agentsRoute,
    newAgentRoute,
    agentRoute.addChildren([
      agentPromptRoute,
      agentToolsRoute,
      agentBriefsRoute,
      agentMemoryRoute,
      agentActivityRoute,
      agentSettingsRoute,
    ]),
    notificationsRoute,
    tagRoute,
    settingsRoute.addChildren([
      settingsHomeRoute,
      settingsProfileRoute,
      settingsNotificationsRoute,
      settingsConnectionsRoute,
      settingsEmailRoute,
      settingsDataRoute,
    ]),
    adminRoute.addChildren([
      adminOverviewRoute,
      adminPeopleRoute,
      adminAgentsRoute,
      adminModelsRoute,
    ]),
  ]),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultPendingComponent: () => <Spinner label="Opening page" />,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
