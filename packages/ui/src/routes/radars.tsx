import { QueryError } from '../components/query-error';
/** Radar directory with topic grouping, local filtering and management shortcuts. */
import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Bell,
  Bot,
  ChevronRight,
  Compass,
  Plus,
  Search,
  Settings,
  Target,
  Users,
} from 'lucide-react';
import type { RadarDto } from '@onmyradar/contract';
import { templateFor } from '@onmyradar/contract';
import { accentStyle } from '../lib/theme';
import {
  groupByTopic,
  queryKeys,
  useDropBox,
  useRadars,
  useSession,
  useTopics,
} from '../lib/session';
import { useQueryClient } from '@tanstack/react-query';
import { Empty, RadarGlyph, Spinner } from '../components/primitives';
import { useNotificationCounts } from '../components/notifications';
import { NewRadarDialog, NewTopicDialog } from '../components/radar-dialogs';
import { useDocumentTitle } from '../lib/title';

export function RadarsRoute() {
  useDocumentTitle('Radars');
  const { user } = useSession();
  const active = Boolean(user && user.state === 'active');
  const { data, isLoading, error, refetch } = useRadars(active);
  const { data: dropBoxData } = useDropBox(active);
  // The same polled call the sidebar uses. On a phone there is no sidebar, so
  // this screen is where both the total and the per-radar counts have to live —
  // otherwise the notification badges exist only on a desktop.
  const { data: counts } = useNotificationCounts(active, 'needs_you');
  const { data: topicData } = useTopics(active);
  const [creating, setCreating] = useState(false);
  const [creatingTopic, setCreatingTopic] = useState(false);
  const navigate = useNavigate();
  const client = useQueryClient();

  const [filter, setFilter] = useState('');
  const all = data?.radars ?? [];
  const search = filter.trim().toLocaleLowerCase();
  const matches = (radar: RadarDto) =>
    [radar.name, radar.tagline, radar.topic?.name].some((value) =>
      value?.toLocaleLowerCase().includes(search),
    );
  // Same precedence as the sidebar: the provisioning response covers the very
  // first load, before the list has been refetched.
  const dropBox = all.find((radar) => radar.isDropBox) ?? dropBoxData?.radar ?? null;
  const radars = all.filter(
    (radar) => !radar.isDropBox && radar.kind !== 'smart' && matches(radar),
  );
  const smart = all.filter((radar) => radar.kind === 'smart' && matches(radar));
  // Grouped for display only. The drop box keeps its place at the top and smart
  // radars keep their own section — neither can be in a topic at all, so a list
  // that becomes topic-organised must not quietly lose them.
  const { groups, ungrouped } = groupByTopic(radars);
  const emptyTopics = (topicData?.topics ?? []).filter(
    (topic) =>
      !topic.archived &&
      topic.name.toLocaleLowerCase().includes(search) &&
      !all.some((radar) => radar.topicId === topic.id),
  );

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-5 px-4 py-5 sm:px-6">
      {/*
        Both create controls, in words, at the top of the index. The rail's `+`
        opens a menu to keep one glyph meaning one thing; here there is room to
        simply name them, and this is the screen a phone has instead of the rail
        — so it is the only place an array can be made on a phone at all.

        `flex-wrap` because two labelled buttons and a heading do not fit on one
        390px line, and a button sliced at the screen edge is the phone bug this
        app has already shipped twice.
      */}
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-[21px] font-semibold tracking-tight">Radars</h1>
        <button className="btn" onClick={() => setCreatingTopic(true)}>
          <Users className="h-4 w-4" />
          New array
        </button>
        <button className="btn btn-accent" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" />
          New radar
        </button>
      </header>

      <label className="relative block">
        <Search
          className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-[color:var(--paper-dim)]"
          aria-hidden="true"
        />
        <input
          className="field pl-10"
          type="search"
          aria-label="Filter radars"
          placeholder="Find a radar or array…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </label>
      <ul className="directory-shortcuts">
        <li>
          <Link to="/search" className="radar-row">
            <span className="shrink-0 text-[color:var(--paper-dim)]">
              <Search className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-medium">Search</span>
              <span className="instrument mt-0.5 block">All blips</span>
            </span>
          </Link>
        </li>
        <li>
          <Link to="/arrays" className="radar-row">
            <span className="shrink-0 text-[color:var(--paper-dim)]">
              <Users className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-medium">Arrays</span>
              <span className="instrument mt-0.5 block">Group radars</span>
            </span>
          </Link>
        </li>
        <li>
          <Link to="/repo" className="radar-row">
            <span className="shrink-0 text-[color:var(--paper-dim)]">
              <Bot className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-medium">Agents</span>
              <span className="instrument mt-0.5 block">Prompts and memory, anywhere</span>
            </span>
          </Link>
        </li>
        <li>
          <Link to="/notifications" className="radar-row">
            <span className="shrink-0 text-[color:var(--paper-dim)]">
              <Bell className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-medium">Activity</span>
              <span className="instrument mt-0.5 block">
                {(counts?.total ?? 0) > 0 ? `${counts?.total} unread` : 'Recent updates'}
              </span>
            </span>
            {(counts?.total ?? 0) > 0 ? (
              <span className="notification-badge">
                {(counts?.total ?? 0) > 99 ? '99+' : counts?.total}
              </span>
            ) : null}
          </Link>
        </li>
        {dropBox ? (
          <RadarRow
            radar={dropBox}
            glyph={<Compass className="h-5 w-5" />}
            meta="Unsorted blips"
            hideSettings
            hideCount
            hideChevron
            unread={counts?.byRadar[dropBox.id] ?? 0}
          />
        ) : null}
      </ul>
      {/* Below the shortcuts, which need nothing fetched: above them, the
          spinner's leaving moved all three up by its own height. */}
      {isLoading ? <Spinner label="Reading your radars" /> : null}
      {error ? <QueryError error={error} resource="Your radars" retry={() => refetch()} /> : null}

      {/*
        One section per array, then everything ungrouped. The heading is a link
        into the array and carries the rolled-up unread count beneath it, so
        grouping a radar can never hide the badge that was asking you to look.
      */}
      {groups.map((group) => (
        <section key={group.topic.id} className="flex flex-col gap-2">
          <h2 className="flex items-center gap-2">
            <Link
              to="/array/$topicId"
              params={{ topicId: group.topic.id }}
              className="instrument flex min-w-0 items-center gap-1.5 hover:underline"
              style={accentStyle(group.topic.accent)}
            >
              <Users className="h-3.5 w-3.5 shrink-0 text-[color:var(--accent-from)]" />
              <span className="truncate">{group.topic.name}</span>
            </Link>
            {group.topic.cascade ? (
              <span className="instrument text-[color:var(--paper-faint)]">shared throughout</span>
            ) : null}
            {(() => {
              const unread = group.radars.reduce(
                (total, radar) => total + (counts?.byRadar[radar.id] ?? 0),
                0,
              );
              return unread > 0 ? (
                <span className="notification-badge ml-auto">{unread > 99 ? '99+' : unread}</span>
              ) : null;
            })()}
          </h2>
          <ul className="radar-list">
            {group.radars.map((radar) => (
              <RadarRow key={radar.id} radar={radar} unread={counts?.byRadar[radar.id] ?? 0} />
            ))}
          </ul>
        </section>
      ))}

      {ungrouped.length > 0 ? (
        <section className="flex flex-col gap-2">
          {/* Only called "Ungrouped" when there is something to be ungrouped
              from; with no arrays at all it is still just "Yours". */}
          <h2 className="instrument">{groups.length > 0 ? 'Ungrouped' : 'Yours'}</h2>
          <ul className="radar-list">
            {ungrouped.map((radar) => (
              <RadarRow key={radar.id} radar={radar} unread={counts?.byRadar[radar.id] ?? 0} />
            ))}
          </ul>
        </section>
      ) : null}

      {emptyTopics.length > 0 ? (
        <section className="flex flex-col gap-2">
          {/* A link, like every other heading that names a place. The section
              lists topics holding nothing this person can read; the full list
              is one tap away rather than only reachable from the rail. */}
          <h2>
            <Link to="/arrays" className="instrument hover:underline">
              Arrays
            </Link>
          </h2>
          <ul className="radar-list">
            {emptyTopics.map((topic) => (
              <li key={topic.id} style={accentStyle(topic.accent)}>
                <Link to="/array/$topicId" params={{ topicId: topic.id }} className="radar-row">
                  <span className="shrink-0 text-[color:var(--accent-from)]">
                    <Users className="h-5 w-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium">{topic.name}</span>
                    <span className="instrument mt-0.5 block truncate">
                      {topic.cascade ? 'shared throughout' : 'grouping only'}
                    </span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-[color:var(--paper-faint)]" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {smart.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="instrument">Smart</h2>
          <ul className="radar-list">
            {smart.map((radar) => (
              <RadarRow
                key={radar.id}
                radar={radar}
                glyph={<Target className="h-5 w-5" />}
                // A smart radar owns nothing, so a count here would be a lie
                // about an empty radar. It resolves per reader when opened.
                meta={
                  radar.filter
                    ? radar.filter.tags
                        .map((tag) => `#${tag}`)
                        .join(radar.filter.match === 'all' ? ' + ' : ' / ')
                    : 'saved search'
                }
                hideCount
              />
            ))}
          </ul>
        </section>
      ) : null}

      {!isLoading &&
      !error &&
      radars.length === 0 &&
      smart.length === 0 &&
      emptyTopics.length === 0 ? (
        <Empty
          title={search ? 'No matching radars' : 'No radars yet'}
          hint={
            search
              ? 'Try a different name, array or description.'
              : 'A radar collects blips about one thing. Create one to get started.'
          }
          action={
            search ? (
              <button className="btn" onClick={() => setFilter('')}>
                Clear filter
              </button>
            ) : (
              <button className="btn btn-accent" onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" />
                New radar
              </button>
            )
          }
        />
      ) : null}

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
            void navigate({ to: '/array/$topicId', params: { topicId: topic.id } });
          }}
        />
      ) : null}
    </div>
  );
}

function RadarRow({
  radar,
  glyph,
  meta,
  hideCount = false,
  hideSettings = false,
  hideChevron = false,
  unread = 0,
}: {
  radar: RadarDto;
  glyph?: React.ReactNode;
  meta?: string;
  hideCount?: boolean;
  hideSettings?: boolean;
  hideChevron?: boolean;
  /** Unread notifications on this radar. Same rule as the sidebar: the badge
      REPLACES the blip count rather than sitting beside it, because when
      something is waiting for you, how many blips the radar holds is not the
      question you are asking. */
  unread?: number;
}) {
  const template = templateFor(radar.template);
  const line =
    meta ??
    [
      template.id === 'stream' ? null : template.label.toLowerCase(),
      radar.visibility === 'public' ? 'public' : null,
      radar.access.role === 'owner' ? null : `shared · ${radar.access.role}`,
      radar.tagline,
    ]
      .filter(Boolean)
      .join(' · ');

  return (
    <li className="topic-row" style={accentStyle(radar.accent)}>
      <Link
        to="/radar/$radarId"
        params={{ radarId: radar.id }}
        className="radar-row min-w-0 flex-1"
      >
        <span className="shrink-0 text-[color:var(--accent-from)]">
          {glyph ?? <RadarGlyph glyph={radar.glyph} className="h-5 w-5" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium">{radar.name}</span>
          {line ? <span className="instrument mt-0.5 block truncate">{line}</span> : null}
        </span>
        {unread > 0 ? (
          <span className="notification-badge" title={`${unread} unread`}>
            {unread > 99 ? '99+' : unread}
          </span>
        ) : hideCount ? null : (
          <span className="instrument !tracking-normal shrink-0">{radar.blipCount}</span>
        )}
        {!hideChevron ? (
          <ChevronRight className="h-4 w-4 shrink-0 text-[color:var(--paper-faint)]" />
        ) : null}
      </Link>
      {radar.access.canManage && !hideSettings ? (
        <Link
          to="/radar/$radarId/settings"
          params={{ radarId: radar.id }}
          className="btn btn-ghost shrink-0 p-2"
          aria-label={`Settings for ${radar.name}`}
          title={`Settings for ${radar.name}`}
        >
          <Settings className="h-4 w-4" />
        </Link>
      ) : null}
    </li>
  );
}
