import { usePushBinding } from '../lib/use-push-binding';
/** Desktop sidebar and mobile tab navigation. Sidebar collapse is remembered per browser. */
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import {
  ArrowLeft,
  Bell,
  Bot,
  Compass,
  LayoutGrid,
  Radio,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  Shield,
  SquarePen,
  Target,
  Users,
} from 'lucide-react';
import type { NotificationCountsDto, RadarDto } from '@onmyradar/contract';
import { UniversalSearch } from './universal-search';
import { accentStyle } from '../lib/theme';
import { prefersReducedMotion } from '../lib/motion';
import { upFor, useNavStack } from '../lib/navstack';
import { RailLabel } from './rail-label';
import {
  groupByTopic,
  queryKeys,
  useDropBox,
  useRadars,
  useSession,
  useSignOut,
  useSingleUser,
  useTopics,
} from '../lib/session';
import { Mark, RadarGlyph } from './primitives';
import { useNotificationCounts } from './notifications';
import { useQuickDropShortcut } from '../lib/quick-drop-shortcut';
import { useSidePanelOpen } from '../lib/side-panel';
import { useMediaQuery } from '../lib/viewport';

/*
  Not in the first paint. They carry the appearance picker, the array picker
  and the select every dialog uses, for something most visits never open.

  But fetched as soon as the page is idle, not when first opened: ⌘K is the
  capture path, and capture has to be cheaper than the thought — a quick drop
  that waits on a network round trip the first time is the one regression
  this split must not cause. Each loader is a single cached promise, so the
  prefetch and `lazy` share one request.
*/
const once = <T,>(load: () => Promise<T>) => {
  let pending: Promise<T> | undefined;
  return () => (pending ??= load());
};
const loadRadarCreate = once(() => import('./radar-create'));
const loadTopicDialogs = once(() => import('./topic-dialogs'));
const loadQuickDrop = once(() => import('./quick-drop'));
const NewRadarDialog = lazy(() =>
  loadRadarCreate().then((module) => ({ default: module.NewRadarDialog })),
);
const NewTopicDialog = lazy(() =>
  loadTopicDialogs().then((module) => ({ default: module.NewTopicDialog })),
);
const QuickDropDialog = lazy(() =>
  loadQuickDrop().then((module) => ({ default: module.QuickDropDialog })),
);

function usePrefetchDialogs(): void {
  useEffect(() => {
    const prefetch = () => {
      void loadQuickDrop();
      void loadRadarCreate();
      void loadTopicDialogs();
    };
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(prefetch, { timeout: 3000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = setTimeout(prefetch, 1500);
    return () => clearTimeout(timer);
  }, []);
}
import { useQueryClient } from '@tanstack/react-query';
import { focusWhenPresent } from '../lib/focus';

const FURLED_KEY = 'omr:sidebar-furled';

/**
 * Remembered per browser rather than per account: it is a statement about this
 * screen's width, not about the person. Wrapped because a browser with site data
 * blocked throws on access, and a navigation shell must not fail to render over
 * a preference.
 */
function readFurled(): boolean {
  try {
    return window.localStorage.getItem(FURLED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * What the screen underneath is called, for the back control's label.
 *
 * A back button that says "Back" says nothing a chevron did not already say.
 * Naming the destination is what makes it worth the row it costs, and the four
 * places a phone can be standing on are the only ones that need naming — a
 * pushed screen's own title is not known here, and "Back" is honest for it.
 */
export function labelForPath(path: string, dropBox: RadarDto | null): string {
  if (dropBox && path === `/radar/${dropBox.id}`) return 'Drop box';
  if (path === '/') return 'Boards';
  if (path === '/radars') return 'Radars';
  if (path === '/settings') return 'You';
  if (path === '/arrays') return 'Arrays';
  if (path.startsWith('/array/')) return 'Array';
  if (path === '/repo') return 'Agents';
  if (path.startsWith('/repo/')) return 'Agent';
  // Before the radar rule: "Back to Radar" from a radar that came from its own
  // settings named the wrong screen — the one `history.back()` does not go to.
  if (/^\/radar\/[^/]+\/settings$/.test(path)) return 'Settings';
  if (path.startsWith('/radar/')) return 'Radar';
  if (path === '/notifications') return 'Activity';
  if (path === '/search') return 'Search';
  if (path.startsWith('/t/')) return 'Tag';
  if (path === '/admin' || path.startsWith('/admin/')) return 'Admin';
  return 'Back';
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user } = useSession();
  const active = Boolean(user && user.state === 'active');
  usePushBinding(active ? user?.id : undefined);
  const radarQuery = useRadars(active);
  const { data } = radarQuery;
  // The call that brings the drop box into existence, for every account.
  const { data: dropBoxData } = useDropBox(active);
  // One polled call feeds every badge in the shell — the total next to Activity
  // and the per-radar counts down the rail.
  const { data: counts } = useNotificationCounts(active, 'needs_you');
  // Topics group the rail below. Fetched here rather than per-section so the
  // sidebar and the /radars screen read the same list.
  const topicQuery = useTopics(active);
  const { data: topicData } = topicQuery;
  const sidebarPending = active && (radarQuery.isPending || topicQuery.isPending);
  const sidebarError = radarQuery.error || topicQuery.error;

  const [furledPref, setFurled] = useState(readFurled);
  // A side panel open on a narrow desktop (1024 to 1279) furls the sidebar to the rail while it is
  // there, so the panel and what it edits both fit. Not remembered: the preference is untouched.
  const panelOpen = useSidePanelOpen();
  const narrowDesktop = useMediaQuery('(min-width: 1024px) and (max-width: 1279px)');
  const autoFurled = !furledPref && panelOpen && narrowDesktop;
  const furled = furledPref || autoFurled;
  const sidebar = useRef<HTMLElement>(null);
  const [creating, setCreating] = useState(false);
  const [creatingTopic, setCreatingTopic] = useState(false);
  const [dropping, setDropping] = useState(false);
  const navigate = useNavigate();
  const router = useRouter();
  const client = useQueryClient();
  const signOut = useSignOut();
  const singleUser = useSingleUser();
  const path = useRouterState({ select: (state) => state.location.pathname });
  // Where this entry sits in the session history; see `advance` in navstack.
  const historyIndex = useRouterState({ select: (state) => state.location.state.__TSR_index });

  const openDrop = useCallback(() => setDropping(true), []);
  useQuickDropShortcut(openDrop);
  usePrefetchDialogs();
  const openSearch = useCallback(() => {
    document.getElementById('global-search')?.focus();
  }, []);
  useSearchShortcut(openSearch);

  const toggleFurl = () => {
    setFurled((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(FURLED_KEY, next ? '1' : '0');
      } catch {
        /* a remembered preference is a nicety, never a requirement */
      }
      return next;
    });
  };

  const [radarFilter, setRadarFilter] = useState('');
  const all = data?.radars ?? [];
  const filter = radarFilter.trim().toLocaleLowerCase();
  const matches = all.filter(
    (radar) =>
      !radar.isDropBox &&
      [radar.name, radar.tagline, radar.topic?.name].some((value) =>
        value?.toLocaleLowerCase().includes(filter),
      ),
  );
  // The drop box sits above the list rather than in it: it is where things go
  // when you have not decided where they go, so it should never be somewhere you
  // have to look for. Falling back to the provisioning response means it appears
  // on the very first load, before the radar list has been refetched.
  const dropBox = all.find((radar) => radar.isDropBox) ?? dropBoxData?.radar ?? null;
  const radars = matches.filter((radar) => radar.kind !== 'smart');
  const smart = matches.filter((radar) => radar.kind === 'smart');
  // Grouped for display only. The drop box and smart radars are filtered out
  // above and keep their own places — neither can be in a topic at all.
  const { groups, ungrouped } = groupByTopic(radars);
  // A topic the person can reach but which holds nothing they can read still
  // deserves a way in, or a topic shared with them without any radars would be
  // invisible in the one place topics are listed.
  const emptyTopics = (topicData?.topics ?? []).filter(
    (topic) =>
      !topic.archived &&
      topic.name.toLocaleLowerCase().includes(filter) &&
      !all.some((radar) => radar.topicId === topic.id),
  );
  // Whether the Topics section has anything to list. Zero is the interesting
  // case: the section renders either way and shows its empty state instead,
  // which is the entire point of this change.
  const hasTopics = groups.length > 0 || emptyTopics.length > 0;
  const inRadars =
    path.startsWith('/radar') && (!dropBox || !path.startsWith(`/radar/${dropBox.id}`));

  /*
    Depth. The stack decides which way a screen arrives and whether there is
    anything underneath it; the pane below wears the answer as `data-nav`.
  */
  const nav = useNavStack(path, dropBox ? `/radar/${dropBox.id}` : null, historyIndex);
  // Not until the drop box is known: before that it looks like any radar, and
  // would flash a "Radars" control on a screen that is itself a tab root.
  const up = nav.canPop || !dropBox ? null : upFor(path, `/radar/${dropBox.id}`);
  /*
    A navigation that unmounts the control somebody used — the New radar
    dialog's button, a list row, a card that was just deleted — leaves focus on
    the body. When that happens the new page's heading takes it, which is what
    a screen reader needs to say where you are. Only a rescue: focus somebody
    put in a field, or that a page gave to its composer, is left alone.
  */
  useEffect(() => {
    focusWhenPresent(['main h1'], { frames: 45, onlyIfLost: true, preventScroll: true });
  }, [path]);
  const pane = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = pane.current;
    if (!node) return;
    node.removeAttribute('data-nav');
    if (nav.direction === 'none' || prefersReducedMotion()) return;
    // Reading a layout property between the two writes is what makes the
    // browser treat this as a new animation rather than a continuation of the
    // one already running. Without it, two pushes in a row animate once.
    void node.offsetWidth;
    node.setAttribute('data-nav', nav.direction);
  }, [nav.direction, nav.nonce]);

  return (
    <div className={`app-shell ${furled ? 'is-furled' : ''}`}>
      <aside ref={sidebar} className="app-sidebar" style={{ background: 'var(--ink-850)' }}>
        <RailLabel enabled={furled} container={sidebar} />
        {/*
          The brand row, and the control that furls the sidebar.

          It used to be one markup for both states: a link on the mark and a
          chevron pushed to the far end by `ml-auto`. In the rail there is no far
          end — 60px of width holds one glyph — so the row turned into a column
          and the chevron dropped onto a second line underneath the mark. That is
          the jump a user photographed: the control is on the right when expanded
          and below the logo when collapsed, and the rail grows a row of chrome
          that exists only to hold it.

          Collapsed, the mark IS the control. Hovering swaps the radar sweep for
          the panel glyph in place, so the brand row stays one row at one height
          in both states and there is nothing under the logo. Nothing is lost by
          the mark no longer linking to `/` in that state: Dashboards is the very
          next row and it is the same destination.
        */}
        <div className="sidebar-head">
          {furled ? (
            <button
              className="sidebar-brand"
              aria-label="Expand the sidebar"
              aria-expanded={false}
              data-rail-label="Expand the sidebar"
              onClick={autoFurled ? undefined : toggleFurl}
            >
              <span className="sidebar-brand-mark text-[color:var(--accent-from)]">
                <Mark size={24} />
              </span>
              <span className="sidebar-brand-open" aria-hidden="true">
                <PanelLeftOpen className="h-[18px] w-[18px]" />
              </span>
            </button>
          ) : (
            <>
              <Link
                to="/"
                className="flex min-w-0 items-center gap-2.5 text-[color:var(--accent-from)]"
                title="On My Radar"
              >
                <Mark size={24} />
                <span className="sidebar-wordmark">On My Radar</span>
              </Link>

              {/* Where the product owner said it was already right. */}
              <button
                className="btn btn-ghost ml-auto p-1.5"
                aria-label="Collapse the sidebar"
                aria-expanded
                title="Collapse"
                onClick={toggleFurl}
              >
                <PanelLeftClose className="h-4 w-4" />
              </button>
            </>
          )}
        </div>

        <nav
          className="scroll-area sidebar-nav"
          aria-label="Sidebar navigation"
          aria-busy={sidebarPending}
        >
          <SidebarLink to="/" icon={<LayoutGrid className="h-4 w-4 opacity-70" />} exact>
            Dashboards
          </SidebarLink>

          <SidebarLink to="/radars" icon={<Radio className="h-4 w-4 opacity-70" />}>
            All radars
          </SidebarLink>
          <SidebarLink to="/arrays" icon={<Users className="h-4 w-4 opacity-70" />}>
            Arrays
          </SidebarLink>
          {/* Present at zero, like Arrays: the rail is where the Agent Repo is
              found, not where it appears once you have already found it. */}
          <SidebarLink to="/repo" icon={<Bot className="h-4 w-4 opacity-70" />}>
            Agents
          </SidebarLink>

          <Link
            to="/notifications"
            className="sidebar-item"
            data-rail-label="Activity"
            {...railMeta(counts?.total ?? 0, true)}
            activeProps={{ className: 'sidebar-item is-active' }}
          >
            <Bell className="h-4 w-4 shrink-0 opacity-70" />
            <span className="sidebar-label">Activity</span>
            {/*
              The count is the whole point of this entry, so unlike the blip
              counts beside it this one is a filled badge rather than a quiet
              number — it is the one thing in the rail that is asking for
              something back.
            */}
            {(counts?.total ?? 0) > 0 ? (
              <span className="notification-badge">
                {(counts?.total ?? 0) > 99 ? '99+' : counts?.total}
              </span>
            ) : null}
          </Link>

          {dropBox ? (
            <Link
              to="/radar/$radarId"
              params={{ radarId: dropBox.id }}
              className="sidebar-item"
              data-rail-label="Drop box"
              {...railMeta(dropBox.blipCount, false)}
              activeProps={{ className: 'sidebar-item is-active' }}
            >
              <Compass className="h-4 w-4 shrink-0 opacity-70" />
              <span className="sidebar-label">Drop box</span>
              {dropBox.blipCount > 0 ? (
                <span className="instrument sidebar-count !tracking-normal">
                  {dropBox.blipCount}
                </span>
              ) : null}
            </Link>
          ) : (
            // Its row, held while the drop box is being read: arriving late,
            // it pushed Quick drop and everything under it down a row.
            <span className="sidebar-item invisible" aria-hidden="true">
              <Compass className="h-4 w-4 shrink-0" />
              <span className="sidebar-label">Drop box</span>
            </span>
          )}

          {/*
            Capture from anywhere, which is what makes the drop box worth having:
            the point is not to navigate to it.

            The glyph is a pen, not a plus, and that is the fix for a real
            report — the rail carried TWO plus signs a few rows apart doing
            different things, and furled to bare glyphs they were the same
            control twice. They were never the same kind of thing: this one is a
            verb (write something down), the one below is a list gaining a row.
            Giving the verb the compose glyph every application uses for it, and
            leaving `+` to mean only "add to the list under it", is what tells
            them apart at a glance instead of on a tooltip.
          */}
          <button
            className="sidebar-item sidebar-drop"
            onClick={openDrop}
            data-rail-label="Quick drop"
            data-rail-meta="⌘K"
          >
            <SquarePen className="h-4 w-4 shrink-0" />
            <span className="sidebar-label">Quick drop</span>
            <span className="instrument sidebar-count !tracking-normal">⌘K</span>
          </button>

          {!furled ? (
            <div className="mt-3 px-1">
              <input
                className="field"
                type="search"
                aria-label="Filter sidebar radars"
                placeholder="Find a radar or array…"
                value={radarFilter}
                onChange={(event) => setRadarFilter(event.target.value)}
              />
              {sidebarPending ? (
                <p className="note mt-2" role="status">
                  Loading radars and arrays…
                </p>
              ) : sidebarError ? (
                <div className="note mt-2" role="alert">
                  Could not load navigation.
                  <button
                    className="btn btn-ghost mt-1"
                    onClick={() => {
                      void radarQuery.refetch();
                      void topicQuery.refetch();
                    }}
                  >
                    Try again
                  </button>
                </div>
              ) : filter && matches.length === 0 && emptyTopics.length === 0 ? (
                <p className="note mt-2">No matching radars or arrays.</p>
              ) : null}
            </div>
          ) : null}

          <div className={`sidebar-section ${hasTopics ? '' : 'sidebar-hint'}`}>
            <Link to="/arrays" className="instrument sidebar-label hover:underline">
              Arrays
            </Link>
            {/*
              There are two `+` in the rail again, and this time that IS the
              documented rule rather than a departure from it.

              The rule the two-plus bug produced is that `+` means "add a row to
              the list under this heading" and nothing else; the fix was to take
              the *verb* — quick drop — off the glyph and give it a pen, which is
              done and stays done. Two pluses that each add a row to the list
              directly beneath them are one control doing one thing in two
              places, which is what the rule is for. The single `+` whose menu
              offered a second kind of object under a heading naming only the
              first was the compromise, and it is what kept topics hidden.
            */}
            <SectionAdd label="New array" onClick={() => setCreatingTopic(true)} />
          </div>

          {hasTopics ? (
            <>
              {/*
                Each array with its radars nested under it. The heading carries
                the rolled-up unread count of the radars beneath it, so a badge
                deeper in the tree is never hidden by the grouping — that would
                make the grouping cost information.
              */}
              {groups.map((group) => (
                <TopicGroup
                  key={group.topic.id}
                  topic={group.topic}
                  radars={group.radars}
                  counts={counts}
                />
              ))}

              {/* An array holding nothing this person can read still needs a way
                  in, or an array shared with them and no radars would be
                  invisible in the one place topics are listed. */}
              {emptyTopics.length > 0 ? (
                <ul className="flex flex-col gap-0.5">
                  {emptyTopics.map((topic) => (
                    <li key={topic.id}>
                      <Link
                        to="/array/$topicId"
                        params={{ topicId: topic.id }}
                        style={accentStyle(topic.accent)}
                        className="sidebar-item"
                        data-rail-label={topic.name}
                        activeProps={{ className: 'sidebar-item is-active' }}
                      >
                        <span className="shrink-0 text-[color:var(--accent-from)]">
                          <Users className="h-4 w-4" />
                        </span>
                        <span className="sidebar-label">{topic.name}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            /*
              The empty state is the feature. `sidebar-label` takes the sentence
              out of the rail along with every other label, which is correct:
              60px of glyphs is not where an explanation belongs, and there the
              hairline rule and the `+` still say a section exists. Expanded —
              the state anybody meeting the app is in — it names the thing and
              links to the screen that explains it.
            */
            <Link to="/arrays" className="sidebar-item sidebar-hint">
              {/*
                The glyph keeps this row in the same column as every radar row
                below it. Without it the sentence started hard against the rail's
                left edge and read as a caption — something the section was
                saying about itself — rather than as a row you can click, which
                is the one thing it has to read as.
              */}
              <span className="shrink-0 text-[color:var(--paper-faint)]">
                <Users className="h-4 w-4" />
              </span>
              <span className="sidebar-label text-[12.5px] text-[color:var(--paper-faint)]">
                Group related radars
              </span>
            </Link>
          )}

          <div className="sidebar-section">
            <Link to="/radars" className="instrument sidebar-label hover:underline">
              Radars
            </Link>
            <SectionAdd label="New radar" onClick={() => setCreating(true)} />
          </div>

          {ungrouped.length > 0 ? (
            <ul className="flex flex-col gap-0.5">
              {ungrouped.map((radar) => (
                <li key={radar.id}>
                  <RadarLink radar={radar} unread={counts?.byRadar[radar.id] ?? 0} />
                </li>
              ))}
            </ul>
          ) : null}

          {/*
            Two different empty Radars sections, and they mean opposite things.

            Splitting topics into their own section above made a second one
            possible: with every radar filed, this heading has nothing under it
            while the account is full of radars. A bare heading and a `+` over
            blank space reads as something failing to load — a screenshot of a
            fully-organised account showed exactly that — where the truth is the
            happy case. So it says which of the two it is.

            `sidebar-hint` takes both out of the rail, along with the Arrays one:
            60px of glyphs carries no sentences.
          */}
          {sidebarPending || sidebarError || filter ? null : radars.length === 0 ? (
            <p className="sidebar-item sidebar-hint sidebar-label text-[12.5px] text-[color:var(--paper-faint)]">
              No radars yet. Create one to start dropping blips.
            </p>
          ) : ungrouped.length === 0 ? (
            <p className="sidebar-item sidebar-hint sidebar-label text-[12.5px] text-[color:var(--paper-faint)]">
              Every radar is in an array.
            </p>
          ) : null}

          {smart.length > 0 ? (
            <>
              <div className="sidebar-section">
                <span className="instrument sidebar-label">Smart</span>
              </div>
              <ul className="flex flex-col gap-0.5">
                {smart.map((radar) => (
                  <li key={radar.id}>
                    <RadarLink radar={radar} smart />
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </nav>

        <div className="sidebar-foot">
          <SidebarLink
            to="/support"
            icon={
              <span aria-hidden="true" className="h-4 w-4 text-center">
                ?
              </span>
            }
          >
            Help
          </SidebarLink>
          {user?.isAdmin ? (
            <SidebarLink to="/admin" icon={<Shield className="h-4 w-4 opacity-70" />}>
              Admin
            </SidebarLink>
          ) : null}
          <SidebarLink to="/settings" icon={<Settings className="h-4 w-4 opacity-70" />}>
            Settings
          </SidebarLink>
          {singleUser ? null : (
            <button
              className="sidebar-item w-full text-left"
              data-rail-label="Sign out"
              onClick={() => void signOut()}
            >
              <LogOut className="h-4 w-4 shrink-0 opacity-70" />
              <span className="sidebar-label">Sign out</span>
            </button>
          )}
          <div className="sidebar-label truncate px-2.5 pt-1.5 pb-1">
            <span className="instrument truncate">{user?.email}</span>
          </div>
        </div>
      </aside>

      <div className="app-main">
        <UniversalSearch />
        <main className="scroll-area app-content">
          {/*
            The stack pane. `data-nav` is what the stylesheet animates against,
            and it is set imperatively in the effect below rather than as a React
            prop for one reason: the same value twice in a row — two pushes —
            has to restart the animation, and re-rendering an unchanged attribute
            does not. Removing it and forcing a reflow does.
          */}
          <div className="nav-pane" ref={pane}>
            {nav.canPop ? (
              /* Not a title bar. No wordmark, no band, no background, no
                 sticky — it scrolls away with the content and it is absent on
                 every tab root. It exists because the alternative on a phone is
                 the browser's own back gesture, which is chrome, not the app. */
              <button
                className="nav-back lg:hidden"
                onClick={() => window.history.back()}
                aria-label={`Back${nav.backTo ? ` to ${labelForPath(nav.backTo, dropBox)}` : ''}`}
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                <span className="instrument">
                  {nav.backTo ? labelForPath(nav.backTo, dropBox) : 'Back'}
                </span>
              </button>
            ) : up ? (
              // Nothing underneath (a link, a reload): up to the parent instead.
              <button
                className="nav-back lg:hidden"
                onClick={() => void router.navigate({ href: up })}
                aria-label={`Back to ${labelForPath(up, dropBox)}`}
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                <span className="instrument">{labelForPath(up, dropBox)}</span>
              </button>
            ) : null}
            {children}
          </div>
        </main>

        {/* The bottom bar is the mobile app frame. Capture sits in the middle,
            where the primary action lives on a phone, and it is the drop box —
            the one place something can always go. */}
        <nav className="app-tabbar lg:hidden" aria-label="Main">
          <Link
            to="/"
            className="tab"
            activeProps={{ className: 'tab is-active' }}
            activeOptions={{ exact: true }}
          >
            <LayoutGrid className="h-5 w-5" />
            <span className="instrument">Boards</span>
          </Link>
          {/* A Link, not a button that opens something over the page: the whole
              point of the change is that this is navigation, so back works.
              It stays lit while you are inside a radar you reached through it,
              because a tab bar with nothing lit two screens deep is disorienting
              — but not for the drop box, which is its own tab. */}
          <Link
            to="/radars"
            className={`tab ${inRadars ? 'is-active' : ''}`}
            activeProps={{ className: 'tab is-active' }}
          >
            <span className="tab-glyph">
              <Target className="h-5 w-5" />
              {/*
                The unread total, which on a phone has nowhere else to be — the
                rail that carries it on a desktop is not rendered here. A dot
                rather than a number: a tab bar glyph has no room for one, and
                the number itself is one tap away on the Radars screen, which is
                also the only route to Activity on a phone.
              */}
              {(counts?.total ?? 0) > 0 ? (
                <span className="tab-dot" role="status" aria-label={`${counts?.total} unread`} />
              ) : null}
            </span>
            <span className="instrument">Radars</span>
          </Link>
          {/* The same verb as the rail's Quick drop, and therefore the same
              glyph. A phone has no second plus to be confused with, but one
              action drawn two ways across two surfaces is its own small lie. */}
          <button className="tab tab-capture" onClick={openDrop} aria-label="Quick drop">
            <span className="tab-capture-dot">
              <SquarePen className="h-5 w-5" />
            </span>
          </button>
          {dropBox ? (
            <Link
              to="/radar/$radarId"
              params={{ radarId: dropBox.id }}
              className="tab"
              activeProps={{ className: 'tab is-active' }}
            >
              <Compass className="h-5 w-5" />
              <span className="instrument">Drop box</span>
            </Link>
          ) : (
            <span className="tab opacity-40">
              <Compass className="h-5 w-5" />
              <span className="instrument">Drop box</span>
            </span>
          )}
          <Link to="/settings" className="tab" activeProps={{ className: 'tab is-active' }}>
            <Settings className="h-5 w-5" />
            <span className="instrument">You</span>
          </Link>
        </nav>
      </div>

      <Suspense fallback={null}>
        {creating ? (
          <NewRadarDialog
            onClose={() => setCreating(false)}
            onCreated={(radar) => {
              setCreating(false);
              void client.invalidateQueries({ queryKey: queryKeys.radars });
              void navigate({ to: '/radar/$radarId', params: { radarId: radar.id } });
            }}
          />
        ) : null}

        {creatingTopic ? (
          <NewTopicDialog
            onClose={() => setCreatingTopic(false)}
            onCreated={(topic) => {
              setCreatingTopic(false);
              void client.invalidateQueries({ queryKey: queryKeys.topics });
              void client.invalidateQueries({ queryKey: queryKeys.radars });
              // Straight into it, the same as a new radar. A topic you cannot see
              // is what this whole change is about.
              void navigate({ to: '/array/$topicId', params: { topicId: topic.id } });
            }}
          />
        ) : null}

        {dropping ? (
          <QuickDropDialog dropBoxId={dropBox?.id ?? null} onClose={() => setDropping(false)} />
        ) : null}
      </Suspense>
    </div>
  );
}

/**
 * The slash key opens search, unless something is already taking keystrokes.
 *
 * The guard is the same one quick drop uses and exists for the same reason: a
 * global single-character shortcut that fired inside the composer would eat a
 * character out of somebody's sentence, which on a surface whose whole thesis is
 * that capture must be cheap is the one thing a shortcut may never do.
 */
function useSearchShortcut(onOpen: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.key !== '/' ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        target?.isContentEditable ||
        target?.closest('[role=dialog], [role=combobox], [popover]')
      )
        return;
      event.preventDefault();
      onOpen();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onOpen]);
}

/**
 * The `+` beside a section heading. One per section, and it means one thing.
 *
 * This replaces a popover that offered "New radar" and "New topic" from a single
 * `+` sitting beside a heading that said RADARS. That popover was itself a fix —
 * for two `+` glyphs a few rows apart doing genuinely different kinds of thing,
 * one a verb (quick drop) and one a list gaining a row — and it over-corrected:
 * it made "add to the list under this heading" mean "add to a list that is not
 * under this heading", and the second object was reachable only by clicking
 * something labelled for the first.
 *
 * The original rule was right and is kept. Quick drop is a pen and stays a pen,
 * because it is a verb. `+` means a list gaining a row, and now every list that
 * can gain a row has its own heading and its own `+` directly above it. The
 * `title` and `aria-label` carry the specific words for the rail, where the
 * heading beside it is a hairline rule rather than a label.
 */
/** The count a rail label carries, and whether it is unread; nothing at zero. */
function railMeta(count: number, hot: boolean): Record<string, string> {
  if (count <= 0) return {};
  return {
    'data-rail-meta': count > 99 ? '99+' : String(count),
    ...(hot ? { 'data-rail-hot': 'true' } : {}),
  };
}

function SectionAdd({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      className="btn btn-ghost p-1"
      aria-label={label}
      data-rail-label={label}
      onClick={onClick}
    >
      <Plus className="h-3.5 w-3.5" />
    </button>
  );
}

function SidebarLink({
  to,
  icon,
  children,
  exact = false,
}: {
  to: string;
  icon: ReactNode;
  children: string;
  exact?: boolean;
}) {
  return (
    <Link
      // The route table is small and typed; this wrapper only exists so the rail
      // and the expanded sidebar cannot drift apart on markup.
      to={to as '/'}
      data-rail-label={children}
      className="sidebar-item"
      activeProps={{ className: 'sidebar-item is-active' }}
      activeOptions={{ exact }}
    >
      {icon}
      <span className="sidebar-label">{children}</span>
    </Link>
  );
}

function RadarLink({
  radar,
  smart = false,
  unread = 0,
}: {
  radar: RadarDto;
  smart?: boolean;
  unread?: number;
}) {
  return (
    <Link
      to="/radar/$radarId"
      params={{ radarId: radar.id }}
      style={accentStyle(radar.accent)}
      data-rail-label={radar.name}
      {...(unread > 0 ? railMeta(unread, true) : smart ? {} : railMeta(radar.blipCount, false))}
      className="sidebar-item"
      activeProps={{ className: 'sidebar-item is-active' }}
    >
      <span className="shrink-0 text-[color:var(--accent-from)]">
        {smart ? <Target className="h-4 w-4" /> : <RadarGlyph glyph={radar.glyph} />}
      </span>
      <span className="sidebar-label">{radar.name}</span>
      {/*
        Two numbers would be noise, so the unread badge REPLACES the blip count
        rather than sitting beside it. When something is waiting for you, how
        many blips the radar holds is not the question you are asking — and the
        moment you deal with it the count comes back.
      */}
      {unread > 0 ? (
        <span className="notification-badge">
          {unread > 99 ? '99+' : unread}
          <span className="sr-only"> unread</span>
        </span>
      ) : smart || radar.blipCount === 0 ? null : (
        /*
          A count is useful when there is something to count. A column of zeros
          down the sidebar beside every new radar was visual noise that also made
          an empty radar look broken — the same rule the unread badge above has
          always followed.

          A smart radar owns no blips at all, so a zero there would be a lie
          about an empty radar rather than a true count; its count is resolved
          per reader when the radar is opened.
        */
        <span className="instrument sidebar-count !tracking-normal">{radar.blipCount}</span>
      )}
    </Link>
  );
}

/**
 * One topic's worth of the rail.
 *
 * The heading is a link to the topic's own screen — a topic is a place, not just
 * a label — and it carries the **sum** of the unread counts beneath it. That
 * roll-up is not decoration: without it, grouping would let a badge sit inside a
 * section and be the only thing telling you to look, which would make organising
 * your radars cost you information. A grouping that hides a signal is worse than
 * no grouping.
 *
 * The cascade mark says the topic shares its radars with everyone in it. It is
 * shown wherever the topic is, because "who can see this" should be legible from
 * the navigation rather than only from a settings screen.
 */
function TopicGroup({
  topic,
  radars,
  counts,
}: {
  topic: NonNullable<RadarDto['topic']>;
  radars: RadarDto[];
  counts: NotificationCountsDto | undefined;
}) {
  const unread = radars.reduce((total, radar) => total + (counts?.byRadar[radar.id] ?? 0), 0);

  return (
    <div style={accentStyle(topic.accent)}>
      <div className="sidebar-section">
        {/*
          `sidebar-label` is on the TEXT, not on this link — and that is the CSS
          layer trap this codebase already has a rule about, met from the other
          side. Tailwind's `flex` is a utility and `.sidebar-label`'s
          `display: none` is a component, so utilities win: with both on one
          element the rail did not hide the array name at all, it drew it clipped
          to 20px behind the unread badge. In the rail this is now the accent
          glyph alone, saying an array starts here, with the name on its tooltip.
        */}
        <Link
          to="/array/$topicId"
          params={{ topicId: topic.id }}
          className="instrument flex min-w-0 items-center gap-1.5 hover:underline"
          data-rail-label={topic.name}
          {...railMeta(unread, true)}
        >
          <Users className="h-3 w-3 shrink-0 text-[color:var(--accent-from)]" />
          <span className="sidebar-label truncate">{topic.name}</span>
          {topic.cascade ? (
            <span
              className="sidebar-label !flex-none"
              title="Shared with everyone in this array"
              aria-label="shared"
            >
              ·
            </span>
          ) : null}
        </Link>
        {unread > 0 ? (
          <span className="notification-badge">
            {unread > 99 ? '99+' : unread}
            <span className="sr-only"> unread in {topic.name}</span>
          </span>
        ) : null}
      </div>
      <ul className="flex flex-col gap-0.5">
        {radars.map((radar) => (
          <li key={radar.id}>
            <RadarLink radar={radar} unread={counts?.byRadar[radar.id] ?? 0} />
          </li>
        ))}
      </ul>
    </div>
  );
}
