import { DashboardBlipActions } from './dashboard-actions';
import { WidgetVisualization } from './dashboard-visualization';
import { Select } from './select';
import { EmailContent } from './email-content';
import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Pencil, Search } from 'lucide-react';
import type {
  DashboardDto,
  DashboardWidgetConfig,
  RadarDto,
  DashboardQueryResultDto,
} from '@onmyradar/contract';
import { api } from '../lib/api';
import { queryKeys } from '../lib/session';
import { plainText } from '../lib/markdown';
import { RelativeTime } from './relative-time';
import { Empty, Modal, RadarGlyph, Spinner } from './primitives';
import { QueryError } from './query-error';
import { Grammar, Interpretation, SearchBox, withSuggestion } from './search-input';

type Widget = DashboardDto['widgets'][number];

export function WidgetEditor({
  radars,
  taken,
  initial,
  queryLimitReached = false,
  onClose,
  onSave,
}: {
  radars: RadarDto[];
  taken: Set<string>;
  initial?: Widget | undefined;
  queryLimitReached?: boolean;
  onClose: () => void;
  onSave: (radarId: string | null, config: DashboardWidgetConfig) => Promise<void>;
}) {
  const config = initial?.config.type === 'query' ? initial.config : null;
  const [kind, setKind] = useState<'radar' | 'query'>(config ? 'query' : 'radar');
  const [title, setTitle] = useState(config?.title ?? '');
  const [query, setQuery] = useState(config?.query ?? 'is:inbox');
  const [limit, setLimit] = useState(config?.limit ?? 12);
  const [display, setDisplay] = useState<'list' | 'count' | 'lanes' | 'activity'>(
    config?.display ?? 'list',
  );
  const [groupByRadar, setGroupByRadar] = useState(config?.groupByRadar ?? true);
  const [hideWhenEmpty, setHideWhenEmpty] = useState(initial?.config.hideWhenEmpty ?? false);
  const [activityDays, setActivityDays] = useState<7 | 30 | 90>(config?.activityDays ?? 30);
  const [debounced, setDebounced] = useState(query);
  const [radarFilter, setRadarFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);
  const suggestions = useQuery({
    queryKey: queryKeys.searchSuggest,
    queryFn: () => api.search.suggest(),
    enabled: kind === 'query',
  });
  const preview = useQuery({
    queryKey: ['widget-preview', debounced, limit, display, groupByRadar, activityDays],
    queryFn: () =>
      api.dashboards.preview(debounced, limit, { display, groupByRadar, activityDays }),
    enabled: kind === 'query',
    retry: false,
  });
  const valid = Boolean(
    preview.data &&
    !preview.error &&
    !preview.isFetching &&
    !preview.data.unresolved &&
    preview.data.problems.length === 0 &&
    debounced === query.trim(),
  );
  // Why Add is disabled, said beside it rather than left for somebody to guess.
  const blocker =
    kind !== 'query'
      ? null
      : !title.trim()
        ? 'Name the widget to add it.'
        : debounced !== query.trim() || preview.isFetching
          ? 'Checking the query…'
          : preview.error
            ? 'The query could not be checked. Try again.'
            : preview.data?.unresolved || preview.data?.problems.length
              ? 'Fix the query first: a filter in it matches nothing.'
              : null;
  const available = radars.filter(
    (radar) =>
      !taken.has(radar.id) &&
      radar.name.toLocaleLowerCase().includes(radarFilter.toLocaleLowerCase()),
  );
  const save = async (radarId: string | null, next: DashboardWidgetConfig) => {
    if (busy) return;
    setBusy(true);
    try {
      await onSave(radarId, next);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={initial ? 'Edit widget' : 'Add widget'}
      description="A radar shows one collection. A live query brings matching blips together across radars."
      onClose={onClose}
      size="lg"
      footer={
        <>
          {blocker ? (
            <span className="note mr-auto" role="status">
              {blocker}
            </span>
          ) : null}
          <button className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          {kind === 'query' ? (
            <button
              className="btn btn-accent"
              disabled={busy || !title.trim() || !valid}
              onClick={() =>
                void save(null, {
                  type: 'query',
                  title: title.trim(),
                  query: query.trim(),
                  limit,
                  display,
                  groupByRadar,
                  hideWhenEmpty,
                  activityDays,
                })
              }
            >
              {busy ? 'Saving…' : initial ? 'Save widget' : 'Add widget'}
            </button>
          ) : initial?.radarId ? (
            <button
              className="btn btn-accent"
              disabled={busy}
              onClick={() => void save(initial.radarId, { hideWhenEmpty })}
            >
              Save widget
            </button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!initial ? (
          <fieldset className="flex flex-wrap gap-2">
            <legend className="sr-only">Widget source</legend>
            {(
              [
                { key: 'radar', label: 'Radar' },
                { key: 'query', label: 'Live query' },
              ] as const
            ).map((choice) => (
              <label className="btn cursor-pointer" key={choice.key}>
                <input
                  type="radio"
                  name="widget-source"
                  checked={kind === choice.key}
                  disabled={choice.key === 'query' && queryLimitReached}
                  onChange={() => setKind(choice.key)}
                  className="accent-[color:var(--accent-from)]"
                />
                {choice.label}
              </label>
            ))}
          </fieldset>
        ) : null}
        {queryLimitReached && !initial ? (
          <p className="note">
            This dashboard has the maximum of 12 live query widgets. You can still add radar
            widgets.
          </p>
        ) : null}
        <label className="flex items-center gap-2 text-[14px]">
          <input
            type="checkbox"
            checked={hideWhenEmpty}
            onChange={(event) => setHideWhenEmpty(event.target.checked)}
          />
          Hide when empty
        </label>
        <p className="note">
          Hidden widgets reappear when matches arrive. You can always reveal and manage them from
          the dashboard.
        </p>
        {kind === 'radar' ? (
          initial?.radarId ? (
            <p className="text-[14px]">
              {radars.find((radar) => radar.id === initial.radarId)?.name ?? 'Radar'}
            </p>
          ) : (
            <>
              <label className="flex flex-col gap-1.5">
                <span className="instrument">Find a radar</span>
                <input
                  className="field"
                  type="search"
                  value={radarFilter}
                  onChange={(event) => setRadarFilter(event.target.value)}
                  placeholder="Radar name"
                />
              </label>
              {available.length ? (
                <ul className="radar-list">
                  {available.map((radar) => (
                    <li key={radar.id}>
                      <button
                        className="radar-row w-full text-left"
                        disabled={busy}
                        onClick={() => void save(radar.id, { hideWhenEmpty })}
                      >
                        <RadarGlyph glyph={radar.glyph} className="h-4 w-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{radar.name}</span>
                        <span className="note">Add</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty
                  title="No available radars"
                  hint={
                    radarFilter
                      ? 'Try a different name.'
                      : 'Your radars are already on this dashboard. Use a live query for another view of them.'
                  }
                />
              )}
            </>
          )
        ) : (
          <>
            <label className="flex flex-col gap-1.5">
              <span className="instrument">
                Widget name {/* Seen, not heard twice: aria-required already says it. */}
                <span className="text-[color:var(--paper-faint)]" aria-hidden="true">
                  (required)
                </span>
              </span>
              <input
                className="field"
                value={title}
                required
                aria-required="true"
                maxLength={120}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Reading to catch up on"
              />
            </label>
            <div className="flex flex-col gap-1.5">
              <span className="instrument">Query</span>
              <SearchBox
                label="Widget query"
                value={query}
                onChange={setQuery}
                inputRef={inputRef}
                radars={suggestions.data?.radars ?? []}
                people={suggestions.data?.people ?? []}
                topics={suggestions.data?.topics ?? []}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="note">Try:</span>
              {['is:inbox', 'tag:reading', 'after:7d'].map((example) => (
                <button
                  key={example}
                  className="btn btn-ghost font-mono text-[12px]"
                  onClick={() => setQuery(example)}
                >
                  {example}
                </button>
              ))}
            </div>
            <details>
              <summary className="note cursor-pointer underline underline-offset-2">
                Query examples and filters
              </summary>
              <div className="pt-3">
                <Grammar
                  onPick={(example) => setQuery((current) => `${current} ${example}`.trim())}
                />
              </div>
            </details>
            <label className="flex flex-col gap-1.5">
              <span className="instrument">Display</span>
              <Select
                aria-label="Widget display"
                value={display}
                onValueChange={(value) => setDisplay(value as typeof display)}
                options={[
                  { value: 'list', label: 'List of blips' },
                  { value: 'count', label: 'Count' },
                  { value: 'lanes', label: 'Lane distribution' },
                  { value: 'activity', label: 'Capture over time' },
                ]}
              />
            </label>
            {display === 'list' ? (
              <label className="flex items-center gap-2 text-[14px]">
                <input
                  type="checkbox"
                  checked={groupByRadar}
                  onChange={(event) => setGroupByRadar(event.target.checked)}
                />
                Group by radar
              </label>
            ) : null}
            {display === 'activity' ? (
              <label className="flex items-center gap-3">
                <span className="instrument">Time range</span>
                <Select
                  aria-label="Activity range"
                  value={String(activityDays)}
                  onValueChange={(value) => setActivityDays(Number(value) as 7 | 30 | 90)}
                  options={[7, 30, 90].map((days) => ({
                    value: String(days),
                    label: `Past ${days} days`,
                  }))}
                />
              </label>
            ) : null}
            {display === 'list' ? (
              <label className="flex items-center gap-3">
                <span className="instrument">Blips to show</span>
                <Select
                  className="field w-auto"
                  value={String(limit)}
                  onValueChange={(value) => setLimit(Number(value))}
                  options={[6, 12, 24, 50].map((count) => ({
                    value: String(count),
                    label: String(count),
                  }))}
                />
              </label>
            ) : null}
            <section className="panel flex flex-col gap-3 p-3" aria-label="Query preview">
              <h3 className="text-[14px] font-semibold">Preview</h3>
              {preview.isFetching || debounced !== query.trim() ? (
                <Spinner label="Updating preview" />
              ) : preview.error ? (
                <QueryError
                  resource="Query preview"
                  error={preview.error}
                  retry={() => preview.refetch()}
                />
              ) : preview.data ? (
                <>
                  <Interpretation
                    result={preview.data}
                    onSuggest={(raw, value) =>
                      setQuery((current) => withSuggestion(current, raw, value))
                    }
                  />
                  {preview.data.unresolved || preview.data.problems.length ? (
                    <p className="note" role="alert">
                      Fix the filters above before saving this widget.
                    </p>
                  ) : (
                    <>
                      <p className="note">
                        {preview.data.total} matching blips across {preview.data.radarsSearched}{' '}
                        {preview.data.radarsSearched === 1 ? 'radar' : 'radars'} you can read.
                        Results update automatically.
                      </p>
                      <div className="max-h-56 overflow-y-auto">
                        {display === 'list' ? (
                          <WidgetResults
                            data={preview.data}
                            radars={radars}
                            grouped={groupByRadar}
                            interactive={false}
                          />
                        ) : (
                          <WidgetVisualization data={preview.data} display={display} />
                        )}
                      </div>
                    </>
                  )}
                </>
              ) : null}
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}

export function QueryWidget({
  dashboardId,
  widget,
  radars,
  onEdit,
  onEmpty,
}: {
  onEmpty?: (empty: boolean) => void;
  dashboardId: string;
  widget: Widget;
  radars: RadarDto[];
  onEdit: () => void;
}) {
  const config = widget.config.type === 'query' ? widget.config : null;
  const query = useQuery({
    queryKey: ['widget-results', dashboardId, widget.id, config],
    queryFn: () => api.dashboards.results(dashboardId, widget.id),
    enabled: Boolean(config && !widget.id.startsWith('new-')),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    staleTime: 10_000,
  });
  const empty = Boolean(
    config?.hideWhenEmpty &&
    query.isSuccess &&
    !query.data.unresolved &&
    !query.data.problems.length &&
    (config.display === 'activity'
      ? (query.data.activity ?? []).every((point) => point.count === 0)
      : config.display === 'lanes'
        ? (query.data.laneGroups ?? []).every((lane) => lane.total === 0)
        : query.data.total === 0),
  );
  useEffect(() => onEmpty?.(empty), [empty, onEmpty]);
  if (!config) return null;
  const display = config.display ?? 'list';
  return (
    <div className="flex h-full flex-col">
      <header
        className={
          display === 'count'
            ? 'widget-count-header'
            : 'flex items-center gap-2 border-b border-[color:var(--line-soft)] py-2.5 pr-11 pl-12'
        }
      >
        {display !== 'count' ? (
          <Search className="h-4 w-4 shrink-0 text-[color:var(--paper-dim)]" />
        ) : null}
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[13.5px] font-medium" title={config.title}>
            {display === 'count' ? (
              <button
                className="w-full truncate"
                onClick={onEdit}
                aria-label={`Edit ${config.title}`}
              >
                {config.title}
              </button>
            ) : (
              config.title
            )}
          </h2>
          {display !== 'count' ? (
            <p className="note">
              {query.data ? `${query.data.total} matching blips` : 'Live query'}
            </p>
          ) : null}
        </div>
        {display !== 'count' ? (
          <button
            className="btn btn-ghost shrink-0 p-1.5"
            onClick={onEdit}
            aria-label={`Edit ${config.title}`}
            title="Edit query"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </header>
      <div className="scroll-area min-h-0 flex-1 overflow-y-auto">
        {query.isLoading || widget.id.startsWith('new-') ? (
          <Spinner label="Loading widget" />
        ) : query.error ? (
          <QueryError resource="Widget results" error={query.error} retry={() => query.refetch()} />
        ) : query.data ? (
          query.data.unresolved || query.data.problems.length ? (
            <div className="p-3">
              <Interpretation result={query.data} />
              <button className="btn mt-3" onClick={onEdit}>
                Edit query
              </button>
            </div>
          ) : display !== 'list' ? (
            <WidgetVisualization data={query.data} display={display} query={config.query} />
          ) : query.data.items.length ? (
            <WidgetResults
              data={query.data}
              radars={radars}
              grouped={config.groupByRadar ?? false}
            />
          ) : (
            <Empty
              title="No matches yet"
              hint="New matching blips will appear here automatically."
            />
          )
        ) : null}
      </div>
      {display !== 'count' ? (
        <Link
          to="/search"
          search={{ q: config.query }}
          className="note flex items-center justify-center gap-1.5 border-t border-[color:var(--line-soft)] px-3 py-2 hover:underline"
        >
          Open full results
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      ) : null}
    </div>
  );
}

function WidgetResults({
  data,
  radars,
  grouped = false,
  interactive = true,
}: {
  interactive?: boolean;
  data: DashboardQueryResultDto;
  radars: RadarDto[];
  grouped?: boolean;
}) {
  const groups = grouped
    ? (data.radarGroups ?? []).map((group) => ({
        ...group,
        items: data.items.filter((blip) => blip.radarId === group.radarId),
      }))
    : [{ radarId: 'all', name: '', total: data.total, items: data.items }];
  return (
    <>
      {groups
        .filter((group) => group.items.length > 0)
        .map((group) => (
          <section key={group.radarId} className="widget-result-group">
            {grouped ? (
              <h3 className="widget-group-heading">
                <span>{group.name}</span>
                <span>{group.total}</span>
              </h3>
            ) : null}
            <ul className="divide-y divide-[color:var(--line-soft)]">
              {group.items.map((blip) => (
                <li key={blip.id} data-dashboard-blip={blip.id}>
                  {blip.email ? (
                    <>
                      <EmailContent blip={blip} compact />
                      <Link
                        to="/radar/$radarId"
                        params={{ radarId: blip.radarId }}
                        search={{ blip: blip.id }}
                        className="note block px-3 pb-2 hover:underline"
                      >
                        {radars.find((radar) => radar.id === blip.radarId)?.name ?? 'Radar'}
                      </Link>
                    </>
                  ) : (
                    <Link
                      to="/radar/$radarId"
                      params={{ radarId: blip.radarId }}
                      search={{ blip: blip.id }}
                      className="block px-3 py-3 hover:bg-[color:var(--ink-750)]"
                    >
                      <p className="line-clamp-2 break-words text-[13.5px] leading-relaxed">
                        {blip.title || plainText(blip.body).slice(0, 180) || 'Untitled blip'}
                      </p>
                      <p className="note mt-1 truncate">
                        {radars.find((radar) => radar.id === blip.radarId)?.name ?? 'Radar'} ·{' '}
                        <RelativeTime iso={blip.createdAt} />
                      </p>
                    </Link>
                  )}
                  {interactive ? (
                    <DashboardBlipActions
                      blip={blip}
                      radar={radars.find((radar) => radar.id === blip.radarId)}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
            {grouped && group.items.length < group.total ? (
              <p className="note px-3 pb-2">
                Showing {group.items.length} of {group.total}
              </p>
            ) : null}
          </section>
        ))}
    </>
  );
}
