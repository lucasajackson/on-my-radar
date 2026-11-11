import {
  DashboardActions,
  DashboardBlipActions,
  DashboardDropTarget,
} from '../components/dashboard-actions';
import { EmailContent } from '../components/email-content';
import { QueryError } from '../components/query-error';
/**
 * Dashboards: tabs, each holding a draggable grid of radars.
 *
 * A tab is a working context — "this quarter", "client work", "the house" — and
 * the grid puts several radars in front of you at once so a project spread
 * across three of them still reads as one thing.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { DashboardDto, RadarDto, DashboardWidgetConfig } from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { accentStyle } from '../lib/theme';
import { plainText } from '../lib/markdown';
import { RelativeTime } from '../components/relative-time';
import { queryKeys, useRadars } from '../lib/session';
import { WidgetEditor, QueryWidget } from '../components/dashboard-widgets';
import { addWidget, arrangeWidgets, tabContents, widgetLayout } from '../lib/dashboard';
import { DashboardGrid, type GridItem } from '../components/dashboard-grid';
import { NotificationWidget } from '../components/notifications';
import { ConfirmDialog, Empty, Modal, RadarGlyph, Spinner, notify } from '../components/primitives';
import { focusWhenPresent } from '../lib/focus';
import { useDocumentTitle } from '../lib/title';

export function HomeRoute() {
  const client = useQueryClient();
  const { data: radarData } = useRadars();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingWidget, setEditingWidget] = useState<GridItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [emptyWidgets, setEmptyWidgets] = useState<Record<string, boolean>>({});
  const [showHidden, setShowHidden] = useState(false);
  const reportEmpty = useCallback(
    (id: string, empty: boolean) =>
      setEmptyWidgets((current) => (current[id] === empty ? current : { ...current, [id]: empty })),
    [],
  );
  const [renaming, setRenaming] = useState(false);
  const [deletingTab, setDeletingTab] = useState(false);
  const [naming, setNaming] = useState(false);

  const dashboardsQuery = useQuery({
    queryKey: queryKeys.dashboards,
    queryFn: () => api.dashboards.list(),
  });

  const dashboards = useMemo(() => dashboardsQuery.data?.dashboards ?? [], [dashboardsQuery.data]);
  const radars = radarData?.radars ?? [];
  const active = dashboards.find((d) => d.id === activeId) ?? dashboards[0] ?? null;
  // The tab's own name once there is more than one; "Dashboards" otherwise.
  useDocumentTitle(dashboards.length > 1 && active ? active.name : 'Dashboards');
  const hiddenIds = new Set(
    active?.widgets.filter((widget) => emptyWidgets[widget.id]).map((widget) => widget.id) ?? [],
  );

  useEffect(() => {
    if (!activeId && dashboards[0]) setActiveId(dashboards[0].id);
  }, [activeId, dashboards]);

  const persist = useCallback(
    async (dashboard: DashboardDto, widgets: GridItem[]) => {
      setSaving(true);
      // Optimistic: the grid already shows the new arrangement, so a round trip
      // here would make dragging feel like it snapped back.
      client.setQueryData(
        queryKeys.dashboards,
        (previous: { dashboards: DashboardDto[] } | undefined) =>
          previous
            ? {
                dashboards: previous.dashboards.map((d) =>
                  d.id === dashboard.id ? { ...d, widgets } : d,
                ),
              }
            : previous,
      );
      try {
        const { dashboard: saved } = await api.dashboards.update(dashboard.id, {
          widgets: widgetLayout(widgets),
          expectedRevision: dashboard.revision,
        });
        client.setQueryData<{ dashboards: DashboardDto[] }>(queryKeys.dashboards, (current) =>
          current
            ? {
                dashboards: current.dashboards.map((item) => (item.id === saved.id ? saved : item)),
              }
            : current,
        );
        return true;
      } catch (err) {
        client.setQueryData<{ dashboards: DashboardDto[] }>(queryKeys.dashboards, (current) =>
          current
            ? {
                dashboards: current.dashboards.map((item) =>
                  item.id === dashboard.id ? dashboard : item,
                ),
              }
            : current,
        );
        notify(err instanceof ApiError ? err.message : 'Could not save the layout', 'error');
        void client.invalidateQueries({ queryKey: queryKeys.dashboards });
        return false;
      } finally {
        setSaving(false);
      }
    },
    [client],
  );

  /**
   * Making a tab.
   *
   * This was a `window.prompt`. A dashboard tab is a persistent object with a
   * name people will read later, and it was being created through the one
   * surface in the browser that the app cannot style, cannot theme, and cannot
   * place — on iOS a system alert with no visible relationship to On My Radar.
   */
  const createTab = async (name: string) => {
    try {
      const { dashboard } = await api.dashboards.create(name.trim());
      await client.invalidateQueries({ queryKey: queryKeys.dashboards });
      setActiveId(dashboard.id);
      setNaming(false);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not create the tab', 'error');
    }
  };

  if (dashboardsQuery.error)
    return (
      <QueryError
        error={dashboardsQuery.error}
        resource="Dashboards"
        retry={() => dashboardsQuery.refetch()}
      />
    );

  if (dashboardsQuery.isLoading) return <Spinner label="Loading dashboards" />;

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-4 py-5 sm:px-6">
      {/*
        Activity sits above the tabs, not inside the grid, and that is what makes
        "it can't be removed" true rather than merely enforced: it has no row in
        `dashboard_widgets`, so there is nothing to delete and no stored state in
        which a dashboard comes back without it. It is also above the tab strip
        deliberately — activity is not per-tab, and duplicating it into every tab
        would make clearing it on one look like it failed on the others.
      */}
      <NotificationWidget />

      <div className="dashboard-navigation">
        <div className="dashboard-tab-strip scroll-area">
          {dashboards.map((dashboard) => (
            <button
              key={dashboard.id}
              data-dashboard-tab={dashboard.id}
              onClick={() => setActiveId(dashboard.id)}
              aria-current={active?.id === dashboard.id}
              className="relative shrink-0 rounded-t-lg px-3 py-2 text-[13.5px] transition-colors"
              style={{
                color: active?.id === dashboard.id ? 'var(--paper)' : 'var(--paper-dim)',
                background: active?.id === dashboard.id ? 'var(--ink-800)' : 'transparent',
              }}
            >
              {dashboard.name}
              <span
                className="instrument ml-2 !tracking-normal"
                title={`${dashboard.widgets.length} ${dashboard.widgets.length === 1 ? 'widget' : 'widgets'}`}
              >
                {dashboard.widgets.length}
                <span className="sr-only">
                  {dashboard.widgets.length === 1 ? ' widget' : ' widgets'}
                </span>
              </span>
            </button>
          ))}
        </div>
        <div className="dashboard-navigation-actions">
          <button
            className="btn btn-ghost shrink-0 p-1.5"
            onClick={() => setNaming(true)}
            aria-label="New tab"
          >
            <Plus className="h-4 w-4" />
          </button>

          {active ? (
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <button
                className="btn btn-ghost p-1.5"
                aria-label="Rename tab"
                onClick={() => setRenaming(true)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              {/* Its own control. It used to be reachable only from inside the
                  Rename dialog, which is not where anybody looks for Delete. */}
              <button
                className="btn btn-ghost p-1.5"
                aria-label={`Delete tab ${active.name}`}
                title="Delete tab"
                onClick={() => setDeletingTab(true)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
              <button className="btn" data-omr="add-widget" onClick={() => setAdding(true)}>
                <Plus className="h-4 w-4" />
                Add widget
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {hiddenIds.size > 0 ? (
        <div className="flex items-center justify-end gap-2">
          <button
            className="btn btn-ghost"
            aria-pressed={showHidden}
            onClick={() => setShowHidden((value) => !value)}
          >
            {showHidden ? 'Hide empty widgets' : `Show hidden widgets (${hiddenIds.size})`}
          </button>
          <span className="note">Reveal to manage empty widgets.</span>
        </div>
      ) : null}

      {!active ? (
        <Empty
          title="No dashboards yet"
          hint="A dashboard is a tab holding several radars side by side. Make one to see a whole project at once."
          action={
            <button className="btn btn-accent" onClick={() => setNaming(true)}>
              <Plus className="h-4 w-4" />
              New tab
            </button>
          }
        />
      ) : active.widgets.length === 0 ? (
        <Empty
          title={`"${active.name}" is empty`}
          hint="Add a radar or a live query across your radars. Arrange widgets however you like."
          action={
            <button className="btn btn-accent" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" />
              Add widget
            </button>
          }
        />
      ) : (
        <DashboardActions radars={radars}>
          <DashboardGrid
            hiddenIds={showHidden ? new Set() : hiddenIds}
            onRevealHidden={() => setShowHidden(true)}
            editable
            busy={saving}
            items={active.widgets}
            onChange={(next) => void persist(active, next)}
            onRemove={(id) =>
              void persist(
                active,
                active.widgets.filter((widget) => widget.id !== id),
              )
            }
            renderItem={(item) => {
              if (item.config.type === 'query')
                return (
                  <QueryWidget
                    dashboardId={active.id}
                    widget={item}
                    radars={radars}
                    onEdit={() => setEditingWidget(item)}
                    onEmpty={(empty) => reportEmpty(item.id, empty)}
                  />
                );
              const radar = radars.find((r) => r.id === item.radarId);
              return radar ? (
                <RadarWidget
                  radar={radar}
                  widget={item}
                  onEdit={() => setEditingWidget(item)}
                  onEmpty={(empty) => reportEmpty(item.id, empty)}
                />
              ) : (
                <MissingRadar />
              );
            }}
          />
        </DashboardActions>
      )}

      {(adding || editingWidget) && active ? (
        <WidgetEditor
          radars={radars}
          taken={
            new Set(
              active.widgets
                .filter((widget) => widget.config.type !== 'query')
                .map((widget) => widget.radarId)
                .filter((id): id is string => Boolean(id)),
            )
          }
          initial={editingWidget ?? undefined}
          queryLimitReached={
            active.widgets.filter((widget) => widget.config.type === 'query').length >= 12
          }
          onClose={() => {
            setAdding(false);
            setEditingWidget(null);
          }}
          onSave={async (radarId: string | null, config: DashboardWidgetConfig) => {
            let next = editingWidget
              ? active.widgets.map((widget) =>
                  widget.id === editingWidget.id
                    ? {
                        ...widget,
                        radarId,
                        config,
                        h:
                          config.type === 'query' && config.display === 'count'
                            ? widget.config.type === 'query' && widget.config.display === 'count'
                              ? widget.h
                              : 2
                            : Math.max(4, widget.h),
                        w:
                          config.type === 'query' && config.display === 'count'
                            ? widget.w
                            : Math.max(3, widget.w),
                      }
                    : widget,
                )
              : addWidget(active.widgets, {
                  id: `new-${crypto.randomUUID()}`,
                  radarId,
                  config,
                  x: 0,
                  y: 0,
                  w: config.type === 'query' && config.display === 'count' ? 2 : 4,
                  h: config.type === 'query' && config.display === 'count' ? 2 : 10,
                });
            if (editingWidget && next) next = arrangeWidgets(next, editingWidget.id);
            if (!next) {
              notify('There is no room for another widget on this dashboard.', 'error');
              return;
            }
            const before = new Set(active.widgets.map((widget) => widget.id));
            if (await persist(active, next)) {
              setAdding(false);
              setEditingWidget(null);
              // Focus lands on the widget just added or edited, not on the body
              // the closed dialog left behind. A new widget's id is the server's,
              // so it is found as the one that was not there before.
              const saved = client
                .getQueryData<{ dashboards: DashboardDto[] }>(queryKeys.dashboards)
                ?.dashboards.find((dashboard) => dashboard.id === active.id);
              const target =
                editingWidget?.id ?? saved?.widgets.find((widget) => !before.has(widget.id))?.id;
              if (target) {
                focusWhenPresent([
                  `[data-widget-id="${target}"] [aria-label="Arrange widget"]`,
                  `[data-widget-id="${target}"]`,
                ]);
              }
            }
          }}
        />
      ) : null}

      {naming ? (
        <NameTabDialog
          suggestion={`Tab ${dashboards.length + 1}`}
          onClose={() => setNaming(false)}
          onSubmit={createTab}
        />
      ) : null}

      {(renaming || deletingTab) && active ? (
        <RenameTabDialog
          dashboard={active}
          deleteFirst={deletingTab}
          onClose={() => {
            setRenaming(false);
            setDeletingTab(false);
          }}
          onDone={() => {
            setRenaming(false);
            void client.invalidateQueries({ queryKey: queryKeys.dashboards });
          }}
          onDeleted={() => {
            setRenaming(false);
            setDeletingTab(false);
            /*
              To the neighbouring tab, and to the tab itself. The dialog handed
              focus back to its trigger, which by then said "Delete tab" for
              the next tab over — one Enter from deleting that one too. A tab
              is a place; a destructive control is never where focus lands.
            */
            const at = dashboards.findIndex((dashboard) => dashboard.id === active.id);
            const neighbour = dashboards[at + 1] ?? dashboards[at - 1] ?? null;
            setActiveId(neighbour?.id ?? null);
            // A frame later: the closing dialog restores focus to its trigger
            // on the way out, and this has to land after that, not before.
            requestAnimationFrame(() =>
              focusWhenPresent(
                neighbour ? [`[data-dashboard-tab="${neighbour.id}"]`] : ['[aria-label="New tab"]'],
              ),
            );
            void client.invalidateQueries({ queryKey: queryKeys.dashboards });
          }}
        />
      ) : null}
    </div>
  );
}

/* -------------------------------- widgets -------------------------------- */

function RadarWidget({
  radar,
  widget,
  onEdit,
  onEmpty,
}: {
  radar: RadarDto;
  widget: GridItem;
  onEdit: () => void;
  onEmpty: (empty: boolean) => void;
}) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['widget-blips', radar.id],
    queryFn: () => api.radars.blips(radar.id, { limit: 12 }),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
  const empty = Boolean(widget.config.hideWhenEmpty && data && !error && data.items.length === 0);
  useEffect(() => onEmpty(empty), [empty, onEmpty]);

  return (
    <DashboardDropTarget radar={radar}>
      <div className="flex h-full flex-col" style={accentStyle(radar.accent)}>
        <header className="relative">
          <button
            className="btn btn-ghost absolute right-10 top-1 p-1.5"
            aria-label={`Edit ${radar.name} widget`}
            onClick={onEdit}
          >
            <Pencil size={14} />
          </button>
          <Link
            to="/radar/$radarId"
            params={{ radarId: radar.id }}
            className="flex items-center gap-2 border-b border-[color:var(--line-soft)] px-3 py-2.5 pr-12 pl-12"
          >
            <span className="text-[color:var(--accent-from)]">
              <RadarGlyph glyph={radar.glyph} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{radar.name}</span>
            <span
              className="instrument mr-6 !tracking-normal"
              title={`${radar.blipCount} ${radar.blipCount === 1 ? 'blip' : 'blips'}`}
            >
              {radar.blipCount}
              <span className="sr-only">{radar.blipCount === 1 ? ' blip' : ' blips'}</span>
            </span>
          </Link>
        </header>

        <div className="scroll-area min-h-0 flex-1 overflow-y-auto">
          {isLoading ? (
            <Spinner label="Reading the radar" />
          ) : error ? (
            <QueryError error={error} resource="Radar activity" retry={() => refetch()} />
          ) : (data?.items.length ?? 0) === 0 ? (
            <p className="px-3 py-4 text-[12.5px] text-[color:var(--paper-faint)]">
              Nothing here yet.
            </p>
          ) : (
            <ul className="divide-y divide-[color:var(--line-soft)]">
              {data?.items.map((blip) => (
                <li key={blip.id} data-dashboard-blip={blip.id}>
                  {blip.email ? (
                    <EmailContent blip={blip} compact />
                  ) : (
                    <Link
                      to="/radar/$radarId"
                      params={{ radarId: radar.id }}
                      search={{ blip: blip.id }}
                      className="block px-3 py-2 hover:bg-[color:var(--ink-750)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--accent-from)]"
                    >
                      <div className="instrument mb-0.5">
                        <RelativeTime iso={blip.createdAt} />
                      </div>
                      <div className="line-clamp-3 text-[13px] leading-snug text-[color:var(--paper-dim)]">
                        {blip.title ?? plainText(blip.body || blip.url || '', 160)}
                      </div>
                    </Link>
                  )}
                  <DashboardBlipActions blip={blip} radar={radar} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </DashboardDropTarget>
  );
}

function MissingRadar() {
  return (
    <div className="flex h-full items-center justify-center px-4 text-center">
      <p className="text-[13px] text-[color:var(--paper-faint)]">
        This radar is no longer shared with you. Remove it from the tab.
      </p>
    </div>
  );
}

/* -------------------------------- dialogs -------------------------------- */

function RenameTabDialog({
  dashboard,
  onClose,
  onDone,
  onDeleted,
  deleteFirst = false,
}: {
  dashboard: DashboardDto;
  onClose: () => void;
  onDone: () => void;
  onDeleted: () => void;
  /** Opened from the tab's own Delete control: straight to the confirmation. */
  deleteFirst?: boolean;
}) {
  const [name, setName] = useState(dashboard.name);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(deleteFirst);

  if (confirming) {
    return (
      <ConfirmDialog
        title="Delete this tab?"
        body={
          <>
            <strong className="text-[color:var(--paper)]">{dashboard.name}</strong> holds{' '}
            {tabContents(dashboard)}. Deleting the tab removes the arrangement only — every radar on
            it, and everything in them, stays exactly where it is.
          </>
        }
        confirmLabel="Delete tab"
        danger
        busy={busy}
        onClose={() => {
          if (deleteFirst) onClose();
          else setConfirming(false);
        }}
        onConfirm={() =>
          void (async () => {
            setBusy(true);
            try {
              await api.dashboards.remove(dashboard.id);
              onDeleted();
            } catch (err) {
              notify(err instanceof ApiError ? err.message : 'Could not delete the tab', 'error');
              setBusy(false);
            }
          })()
        }
      />
    );
  }

  return (
    <Modal
      title="Rename tab"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-accent"
            disabled={busy || !name.trim()}
            onClick={() =>
              void (async () => {
                setBusy(true);
                // A failed rename left Save disabled for good, with no word of why
                // and an unhandled rejection behind it.
                try {
                  await api.dashboards.update(dashboard.id, { name: name.trim() });
                  onDone();
                } catch (err) {
                  notify(
                    err instanceof ApiError ? err.message : 'Could not rename the tab',
                    'error',
                  );
                  setBusy(false);
                }
              })()
            }
          >
            <Check className="h-4 w-4" />
            Save
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <input
          className="field"
          value={name}
          autoFocus
          onChange={(event) => setName(event.target.value)}
        />
        {/* Not in the footer beside Save. A tab is cheap to remake and this is
            the mildest destructive act in the product, but it is still the only
            irreversible thing on this screen and it does not share a row with
            the button pressed on every visit. */}
        <div className="danger-row">
          <span className="note">Deleting the tab keeps every radar on it.</span>
          <button className="btn btn-danger" disabled={busy} onClick={() => setConfirming(true)}>
            <X className="h-4 w-4" />
            Delete tab
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Naming a new tab. A dialog rather than `window.prompt` — see `createTab`. */
function NameTabDialog({
  suggestion,
  onClose,
  onSubmit,
}: {
  suggestion: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(suggestion);
  // Enter pressed twice, or Enter then a click, made two tabs.
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    try {
      await onSubmit(name.trim());
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="New tab"
      description="A working context — this quarter, client work, the house."
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-accent"
            disabled={busy || !name.trim()}
            onClick={() => void submit()}
          >
            <Plus className="h-4 w-4" />
            Create tab
          </button>
        </>
      }
    >
      <label className="flex flex-col gap-1.5">
        <span className="instrument">Name</span>
        <input
          className="field"
          value={name}
          autoFocus
          // "Tab 2" is a placeholder somebody means to replace: selected, so the
          // first keystroke replaces it rather than appending to it.
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) void submit();
          }}
        />
      </label>
    </Modal>
  );
}
