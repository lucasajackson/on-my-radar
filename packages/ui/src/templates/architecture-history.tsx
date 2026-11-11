/**
 * The charter's history (plan e715ea20, U3): a panel of versions, a version read in the document's
 * place, a comparison with struck and inserted words, and a restore that adds a version.
 *
 * It is for members. A radar read through its public link has no history, and nothing here is
 * drawn for it (the server answers 404 to every door). The pieces are made by one hook so the
 * radar view only has to place them: the button in the bar, the panel beside the document, the
 * banner and the document itself in the document's place.
 *
 * A version is a read-only Milkdown (`lib/milkdown-history.ts`, loaded when one is opened), so the
 * words the server's offsets name are the words drawn; a diff and a deep link's highlight are
 * decorations over it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, History, X } from 'lucide-react';
import type {
  ArchitectureDto,
  CharterDiffDto,
  CharterVersionDto,
  RadarDto,
  RestoreCharterResult,
} from '@onmyradar/contract';
import { SidePanel } from '../components/side-panel';
import { Select } from '../components/select';
import { ConfirmDialog, Spinner, notify } from '../components/primitives';
import { ApiError, api } from '../lib/api';
import { anchorMap } from '../lib/charter-spans';
import {
  agoOf,
  changesFit,
  changesOf,
  countOf,
  limitNote,
  stampOf,
  versionParams,
  whoOf,
  whyOf,
  type Change,
} from '../lib/charter-history';
import type { ViewerHandle, ViewerMarks } from '../lib/milkdown-history';
import './charter-history.css';

/* ------------------------------ deep links ----------------------------- */

/** The event "See it in version N" raises when the charter is already on the page. */
const OPEN_EVENT = 'omr:charter-version';

/** Where a version, and a passage in it, is addressed. */
export const versionHref = (radarId: string, version: number, anchorId?: string | null): string =>
  `/radar/${encodeURIComponent(radarId)}?tab=charter&${versionParams(version, anchorId)}`;

/** Open a version of the charter on the page that is showing it. */
export function openVersion(version: number, anchorId?: string | null): void {
  window.dispatchEvent(
    new CustomEvent(OPEN_EVENT, { detail: { version, anchorId: anchorId ?? null } }),
  );
}

/**
 * "See it in version N": the version that last had the words an orphan was anchored to, opened
 * with the passage flashed. A real link (new tab, copy) that, on the page, opens in place.
 */
export function SeeInVersion({
  radarId,
  version,
  anchorId,
  className = 'btn btn-ghost',
}: {
  radarId: string;
  version: number;
  anchorId: string;
  className?: string;
}) {
  return (
    <a
      className={className}
      href={versionHref(radarId, version, anchorId)}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        openVersion(version, anchorId);
      }}
    >
      See it in version {version}
    </a>
  );
}

/**
 * A comparison, and the revision of the charter it was made on. The current charter can be
 * written between the two reads, so the revision is read on both sides and the diff is made again
 * if it moved: what is returned was made on one revision.
 */
async function diffAt(
  id: string,
  from: number,
  to: Ref,
): Promise<{ diff: CharterDiffDto; revision: number | null }> {
  if (to !== 'head') return { diff: await api.radars.charterDiff(id, from, to), revision: null };
  const revision = async () => (await api.radars.charterVersions(id)).head.revision;
  for (let tries = 0; tries < 3; tries += 1) {
    const before = await revision();
    const diff = await api.radars.charterDiff(id, from, to);
    if ((await revision()) === before) return { diff, revision: before };
  }
  throw new Error('The charter is changing');
}

/* ---------------------------------- URL --------------------------------- */

const param = (name: string): string | null =>
  new URLSearchParams(window.location.search).get(name);
const count = (name: string): number | null => {
  const n = Number(param(name));
  return Number.isInteger(n) && n > 0 ? n : null;
};
function writeParams(values: Record<string, string | null>): void {
  const url = new URL(window.location.href);
  for (const [name, value] of Object.entries(values)) {
    if (value) url.searchParams.set(name, value);
    else url.searchParams.delete(name);
  }
  window.history.replaceState(window.history.state, '', url);
}

type Ref = number | 'head';

/* --------------------------------- the hook ------------------------------ */

export interface CharterHistory {
  /** History exists for this reader (a member, not a public link). */
  available: boolean;
  /** A version or a comparison is drawn in the document's place. */
  active: boolean;
  panelOpen: boolean;
  openPanel: () => void;
  closePanel: () => void;
  /** The text being read, for the outline; null when the live charter is. */
  text: string | null;
  button: ReactNode;
  panel: ReactNode;
  banner: ReactNode;
  document: ReactNode;
  dialogs: ReactNode;
}

export function useCharterHistory({
  radar,
  head,
  editing,
  desktop,
  showCharter,
  onRestored,
  beforeOpen,
}: {
  radar: RadarDto;
  /** The live charter as the radar view reads it (`view=source`). */
  head: ArchitectureDto | undefined;
  editing: boolean;
  /** The window is wide enough for the panel to be a column; below it the panel is a sheet. */
  desktop: boolean;
  /** Bring the Charter tab up (a deep link may be followed from the Map). */
  showCharter: () => void;
  /** After a restore: the live charter has changed. */
  onRestored: () => void;
  /** Asked before the panel opens, so the radar view can make room (an ADR being written). */
  beforeOpen: (open: () => void) => void;
}): CharterHistory {
  const client = useQueryClient();
  const available = radar.access.canRead && !radar.access.viaPublicLink;
  const canWrite = radar.access.canWrite;
  const id = radar.id;
  const [panelOpen, setPanelOpen] = useState(false);
  const [version, setVersion] = useState<number | null>(() => count('version'));
  const [anchor, setAnchor] = useState<string | null>(() => param('anchor'));
  const [compareTo, setCompareTo] = useState<Ref | null>(() => {
    const raw = param('compare');
    return raw === 'head' ? 'head' : count('compare');
  });
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [change, setChange] = useState(0);
  const [nav, setNav] = useState(0);
  const [stale, setStale] = useState(false);
  const active = available && version !== null;
  const comparing = active && compareTo !== null;
  const headRevision = head?.revision ?? null;

  // The URL names what is shown, so a reload or a pasted link lands on it.
  useEffect(() => {
    if (!available) return;
    writeParams({
      version: version === null ? null : String(version),
      anchor: version === null ? null : anchor,
      compare: version === null || compareTo === null ? null : String(compareTo),
    });
  }, [available, version, anchor, compareTo]);

  const show = useCallback(
    (next: number | null, at: string | null = null, against: Ref | null = null) => {
      setVersion(next);
      setAnchor(at);
      setCompareTo(against);
      setChange(0);
      setNav((n) => n + 1);
      setStale(false);
      if (next !== null) {
        showCharter();
        // A sheet would hide the version it just opened.
        if (!desktop) setPanelOpen(false);
      }
    },
    [showCharter, desktop],
  );
  useEffect(() => {
    if (!available) return;
    const on = (event: Event) => {
      const { version: next, anchorId } = (
        event as CustomEvent<{ version: number; anchorId: string | null }>
      ).detail;
      show(next, anchorId);
    };
    window.addEventListener(OPEN_EVENT, on);
    return () => window.removeEventListener(OPEN_EVENT, on);
  }, [available, show]);

  // Esc closes the panel, wherever focus is: the column beside the document has no dialog around
  // it, and a sheet's own handler only hears keys from inside it (focus can still be on the button
  // that opened it). Another dialog or an open menu has the key first.
  useEffect(() => {
    if (!panelOpen) return;
    const on = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const other = [...document.querySelectorAll('[aria-modal="true"]')].some(
        (element) => !element.classList.contains('side-panel'),
      );
      if (other || document.querySelector('[role="listbox"]')) return;
      setPanelOpen(false);
    };
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, [panelOpen]);

  /* the list */
  const needList = available && (panelOpen || comparing);
  const list = useInfiniteQuery({
    queryKey: ['charter-versions', id],
    queryFn: ({ pageParam }) => api.radars.charterVersions(id, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: needList,
  });
  const versions = useMemo(() => list.data?.pages.flatMap((p) => p.versions) ?? [], [list.data]);
  const listHead = list.data?.pages[0]?.head ?? null;
  // The list is behind the moment the charter is written: read it again.
  const lastRevision = useRef(headRevision);
  useEffect(() => {
    if (lastRevision.current === headRevision) return;
    lastRevision.current = headRevision;
    void client.invalidateQueries({ queryKey: ['charter-versions', id] });
  }, [headRevision, client, id]);

  /* the version read */
  const past = useQuery({
    queryKey: ['charter-at', id, version, anchor],
    queryFn: () => api.radars.architectureAt(id, version ?? 0, anchor ?? undefined),
    enabled: active,
    // A sealed version never changes.
    staleTime: Infinity,
    retry: (tries, error) => !(error instanceof ApiError && error.status === 404) && tries < 2,
  });
  const against = useQuery({
    queryKey: ['charter-at', id, compareTo, null],
    queryFn: () => api.radars.architectureAt(id, typeof compareTo === 'number' ? compareTo : 0),
    enabled: comparing && typeof compareTo === 'number',
    staleTime: Infinity,
  });
  const diff = useQuery({
    queryKey: ['charter-diff', id, version, compareTo, compareTo === 'head' ? headRevision : null],
    queryFn: () => diffAt(id, version ?? 1, compareTo ?? 'head'),
    // Against the current charter, once the page has read it: the diff is of that revision.
    enabled: comparing && (compareTo !== 'head' || headRevision !== null),
    staleTime: compareTo === 'head' ? 0 : Infinity,
  });
  // A comparison with the current charter is drawn on the head the page holds. A diff made on
  // another revision (a deletion leaves nothing in the words to check it against) waits for the
  // page to read the head again; marks are never put on words they were not made for.
  const behind =
    comparing &&
    compareTo === 'head' &&
    diff.data !== undefined &&
    diff.data.revision !== headRevision;
  useEffect(() => {
    if (behind) void client.invalidateQueries({ queryKey: ['architecture', id] });
  }, [behind, diff.data, headRevision, client, id]);

  const labelOf = useCallback((data: ArchitectureDto | undefined) => {
    const names = new Map((data?.adrs ?? []).map((a) => [a.id, a.label]));
    return (adr: string) => names.get(adr) ?? 'ADR';
  }, []);
  /** A version's words, and the amendments drawn on it. */
  const read = useCallback(
    (data: ArchitectureDto | undefined) => {
      if (!data) return null;
      // A charter with nothing in it comes without a page or without text: an empty version.
      const source = data.charter[0]?.markdown ?? '';
      const map = anchorMap(source);
      const label = labelOf(data);
      return {
        written: map.written,
        draw: {
          text: map.text,
          spans: map.spans.map((s) => ({ start: s.start, end: s.end, labels: s.adrs.map(label) })),
        },
      };
    },
    [labelOf],
  );

  // What is drawn: the version, or (comparing) the newer of the two.
  const shownData = comparing ? (compareTo === 'head' ? head : against.data) : past.data;
  const shown = useMemo(() => read(shownData), [read, shownData]);
  const changes = useMemo<Change[]>(
    () => (diff.data ? changesOf(diff.data.diff) : []),
    [diff.data],
  );
  const marks = useMemo<ViewerMarks>(
    () =>
      comparing
        ? { changes, current: change }
        : {
            amend: shown?.draw ?? null,
            flash:
              past.data?.highlight &&
              past.data.highlight.start !== null &&
              past.data.highlight.end !== null
                ? { start: past.data.highlight.start, end: past.data.highlight.end }
                : null,
          },
    [comparing, changes, change, shown, past.data],
  );

  /* the version's own record */
  const meta: CharterVersionDto | undefined =
    past.data?.asOf ?? versions.find((v) => v.version === version);

  // A comparison drawn on words that moved is told so once; a new read starts clean.
  useEffect(() => setStale(false), [diff.data, shown?.written]);

  /* actions */
  const closeView = useCallback(() => show(null), [show]);
  const closePanel = useCallback(() => setPanelOpen(false), []);
  const restore = async () => {
    if (version === null || headRevision === null) return;
    setRestoring(true);
    try {
      const result = await api.radars.restoreCharter(id, version, headRevision);
      setConfirming(false);
      notify(restoredMessage(result), 'ok', {
        label: 'History',
        run: () => setPanelOpen(true),
      });
      show(null);
      if (desktop) setPanelOpen(true);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['charter-versions', id] }),
        client.invalidateQueries({ queryKey: ['architecture', id] }),
      ]);
      onRestored();
    } catch (error) {
      setConfirming(false);
      if (error instanceof ApiError && error.status === 409) {
        void client.invalidateQueries({ queryKey: ['architecture', id] });
        void client.invalidateQueries({ queryKey: ['charter-versions', id] });
        notify(
          'The charter changed while you were looking. Look at it again, then restore.',
          'error',
        );
      } else
        notify(
          error instanceof ApiError ? error.message : 'Could not restore that version.',
          'error',
        );
    } finally {
      setRestoring(false);
    }
  };

  /* pieces */
  const button = available ? (
    <button
      type="button"
      className={`btn ${panelOpen ? 'is-on' : ''}`}
      aria-pressed={panelOpen}
      disabled={editing}
      title={editing ? 'Finish editing to browse the history' : 'Version history'}
      onClick={() => (panelOpen ? setPanelOpen(false) : beforeOpen(() => setPanelOpen(true)))}
    >
      <History size={15} aria-hidden="true" />
      History
    </button>
  ) : null;

  const panel =
    available && panelOpen ? (
      <HistoryPanel
        versions={versions}
        head={listHead}
        pending={list.isPending}
        failed={list.isError}
        more={list.hasNextPage}
        loadingMore={list.isFetchingNextPage}
        onMore={() => void list.fetchNextPage()}
        onRetry={() => void list.refetch()}
        selected={active ? version : null}
        onView={(next) => show(next)}
        onCurrent={closeView}
        onCompare={(from) => show(from, null, 'head')}
        onClose={() => setPanelOpen(false)}
      />
    ) : null;

  const banner = active ? (
    <VersionBanner
      version={version}
      meta={meta}
      loading={past.isPending}
      missing={past.isError}
      canWrite={canWrite}
      comparing={comparing}
      versions={versions}
      compareTo={compareTo}
      diff={diff.data?.diff ?? null}
      diffPending={comparing && (diff.isPending || behind)}
      diffFailed={comparing && diff.isError}
      stale={stale}
      change={change}
      total={changes.length}
      missingPassage={
        !comparing &&
        anchor !== null &&
        past.data !== undefined &&
        past.data.highlight?.start == null
          ? (past.data.highlight?.quote ?? '')
          : null
      }
      onBack={closeView}
      onCompare={() => show(version, null, 'head')}
      onView={() => show(version)}
      onFrom={(next) => show(next, null, compareTo)}
      onTo={(next) => show(version, null, next)}
      onStep={(by) => {
        setChange((now) =>
          changes.length === 0 ? 0 : (now + by + changes.length) % changes.length,
        );
        setNav((n) => n + 1);
      }}
      onRestore={() => setConfirming(true)}
    />
  ) : null;

  const doc = active ? (
    <VersionDocument
      key={`${version}-${compareTo ?? ''}`}
      markdown={shown?.written ?? null}
      empty={!comparing && shown !== null && shown.written.trim() === ''}
      loading={
        comparing ? diff.isPending || (compareTo !== 'head' && against.isPending) : past.isPending
      }
      failed={past.isError || (comparing && (diff.isError || against.isError))}
      marks={comparing && (!diff.data || stale || behind) ? null : marks}
      changes={comparing ? changes : null}
      scroll={comparing ? { change } : past.data?.highlight ? { flash: true } : null}
      scrollKey={nav}
      onStale={() => setStale(true)}
      onRetry={() => {
        void past.refetch();
        void diff.refetch();
        // The other version of a comparison is its own read: a failure of it is retried too.
        if (comparing && typeof compareTo === 'number') void against.refetch();
      }}
    />
  ) : null;

  const dialogs =
    confirming && version !== null ? (
      <ConfirmDialog
        title={`Restore version ${version}?`}
        body={
          <>
            <p>
              The charter will read as it did in version {version}
              {meta ? ` (${stampOf(meta.createdAt)}, by ${whoOf(meta)})` : ''}.
            </p>
            <p className="chist-confirm-note">
              This adds a new version on top. Nothing is lost: the version you have now stays in the
              list, and you can come back to it. Amendments and links whose words come back are
              anchored again; any whose words go are flagged as orphaned.
            </p>
          </>
        }
        confirmLabel={restoring ? 'Restoring…' : `Restore version ${version}`}
        busy={restoring}
        onClose={() => setConfirming(false)}
        onConfirm={() => void restore()}
      />
    ) : null;

  return {
    available,
    active,
    panelOpen: available && panelOpen,
    openPanel: () => setPanelOpen(true),
    closePanel,
    text: active ? (shown?.written ?? '') : null,
    button,
    panel,
    banner,
    document: doc,
    dialogs,
  };
}

/** "Restored version 4 as version 13. ADR-0029 anchored again. ADR-0031 orphaned." */
export function restoredMessage(result: RestoreCharterResult): string {
  if (!result.changed)
    return `Version ${result.restoredFrom} is what the charter already says; nothing was added.`;
  const names = (list: ReadonlyArray<{ subject: { label: string } }>) =>
    list.length <= 3
      ? list.map((a) => a.subject.label).join(', ')
      : `${list
          .slice(0, 3)
          .map((a) => a.subject.label)
          .join(', ')} and ${list.length - 3} more`;
  const parts = [`Restored version ${result.restoredFrom} as version ${result.version}.`];
  if (result.healed.length > 0) parts.push(`Anchored again: ${names(result.healed)}.`);
  if (result.orphaned.length > 0) parts.push(`Orphaned: ${names(result.orphaned)}.`);
  return parts.join(' ');
}

/* --------------------------------- the panel ------------------------------ */

function HistoryPanel({
  versions,
  head,
  pending,
  failed,
  more,
  loadingMore,
  onMore,
  onRetry,
  selected,
  onView,
  onCurrent,
  onCompare,
  onClose,
}: {
  versions: readonly CharterVersionDto[];
  head: { revision: number; version: number; unsealed: boolean } | null;
  pending: boolean;
  failed: boolean;
  more: boolean;
  loadingMore: boolean;
  onMore: () => void;
  onRetry: () => void;
  selected: number | null;
  onView: (version: number) => void;
  onCurrent: () => void;
  onCompare: (version: number) => void;
  onClose: () => void;
}) {
  return (
    <SidePanel
      title="Version history"
      onClose={onClose}
      footer={
        <span className="chist-foot note">Restoring adds a version. Nothing is deleted.</span>
      }
    >
      {pending ? <Spinner label="Reading the history" /> : null}
      {failed && versions.length === 0 ? (
        <div className="chist-failed" role="alert">
          <p>The history could not be read.</p>
          <button type="button" className="btn" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : null}
      {head ? (
        <ol className="chist-list" aria-label="Versions, newest first">
          <li className={`chist-row is-current ${selected === null ? 'is-selected' : ''}`}>
            <button
              type="button"
              className="chist-main"
              aria-current={selected === null ? 'true' : undefined}
              onClick={onCurrent}
            >
              <span className="chist-title">
                <span className="chist-v">Now</span>
                <span className="chist-why">Current charter</span>
              </span>
              <span className="chist-meta instrument">
                {head.unsealed
                  ? `Changes since v${head.version} are not a version yet`
                  : `Same as v${head.version}`}
              </span>
            </button>
          </li>
          {versions.map((v) => (
            <li
              key={v.version}
              className={`chist-row ${selected === v.version ? 'is-selected' : ''}`}
            >
              <button
                type="button"
                className="chist-main"
                aria-current={selected === v.version ? 'true' : undefined}
                aria-label={`Version ${v.version}: ${whyOf(v)}, ${whoOf(v)}, ${agoOf(v.createdAt)}`}
                title={v.label}
                onClick={() => onView(v.version)}
              >
                <span className="chist-title">
                  <span className="chist-v">v{v.version}</span>
                  <span className="chist-why">{whyOf(v)}</span>
                </span>
                <span className="chist-meta">
                  <span className="chist-who">{whoOf(v)}</span>
                  {v.by.kind === 'agent' ? (
                    <span
                      className="chip-status is-agent"
                      title={
                        v.by.onBehalfOf ? `An agent, working for ${v.by.onBehalfOf}` : 'An agent'
                      }
                    >
                      Agent
                    </span>
                  ) : null}
                  <span className="chist-ago" title={stampOf(v.createdAt)}>
                    {agoOf(v.createdAt)}
                  </span>
                </span>
              </button>
              <button
                type="button"
                className="btn btn-ghost chist-compare"
                aria-label={`Compare version ${v.version} with current`}
                onClick={() => onCompare(v.version)}
              >
                Compare
              </button>
            </li>
          ))}
        </ol>
      ) : null}
      {more ? (
        <button type="button" className="btn chist-more" disabled={loadingMore} onClick={onMore}>
          {loadingMore ? 'Loading…' : 'Older versions'}
        </button>
      ) : null}
    </SidePanel>
  );
}

/* --------------------------------- the banner ----------------------------- */

function VersionBanner({
  version,
  meta,
  loading,
  missing,
  canWrite,
  comparing,
  versions,
  compareTo,
  diff,
  diffPending,
  diffFailed,
  stale,
  change,
  total,
  missingPassage,
  onBack,
  onCompare,
  onView,
  onFrom,
  onTo,
  onStep,
  onRestore,
}: {
  version: number;
  meta: CharterVersionDto | undefined;
  loading: boolean;
  missing: boolean;
  canWrite: boolean;
  comparing: boolean;
  versions: readonly CharterVersionDto[];
  compareTo: Ref | null;
  diff: CharterDiffDto | null;
  diffPending: boolean;
  diffFailed: boolean;
  stale: boolean;
  change: number;
  total: number;
  missingPassage: string | null;
  onBack: () => void;
  onCompare: () => void;
  onView: () => void;
  onFrom: (version: number) => void;
  onTo: (ref: Ref) => void;
  onStep: (by: 1 | -1) => void;
  onRestore: () => void;
}) {
  if (missing)
    return (
      <div className="chist-banner is-problem" role="alert">
        <p className="chist-banner-line">
          <strong>Version {version} could not be opened.</strong> It does not exist, or history is
          only open to members of this radar.
        </p>
        <div className="chist-actions">
          <button type="button" className="btn btn-accent" onClick={onBack}>
            Back to current
          </button>
        </div>
      </div>
    );
  const options = (extra: readonly number[]) => {
    const seen = new Set(versions.map((v) => v.version));
    const numbers = [...versions.map((v) => v.version), ...extra.filter((n) => !seen.has(n))].sort(
      (a, b) => b - a,
    );
    return numbers.map((n) => ({ value: String(n), label: `Version ${n}` }));
  };
  const note = diff ? limitNote(diff) : null;
  // Which versions are being compared, short enough for the sticky bar too.
  const pair = `v${version} → ${compareTo === 'head' || compareTo === null ? 'current' : `v${compareTo}`}`;
  return (
    <>
      <div
        className={`chist-banner ${comparing ? '' : 'is-viewing'}`}
        role="region"
        aria-label={comparing ? 'Comparing versions' : 'Viewing a version'}
      >
        {comparing ? (
          <div className="chist-compare-row">
            <span className="chist-banner-line">
              <strong>Comparing {pair}</strong>
            </span>
            <label className="chist-pick">
              <span className="instrument">From</span>
              <Select
                aria-label="Compare from"
                value={String(version)}
                onValueChange={(value) => onFrom(Number(value))}
                options={options([version])}
              />
            </label>
            <label className="chist-pick">
              <span className="instrument">To</span>
              <Select
                aria-label="Compare to"
                value={String(compareTo)}
                onValueChange={(value) => onTo(value === 'head' ? 'head' : Number(value))}
                options={[
                  { value: 'head', label: 'Current' },
                  ...options(typeof compareTo === 'number' ? [compareTo] : []),
                ]}
              />
            </label>
          </div>
        ) : (
          <p className="chist-banner-line">
            {loading || !meta ? (
              <strong>Opening version {version}…</strong>
            ) : (
              <>
                <strong>Viewing version {version}</strong>
                <span className="chist-banner-meta">
                  {stampOf(meta.createdAt)} · by {whoOf(meta)}
                </span>
                {meta.by.kind === 'agent' ? (
                  <span className="chip-status is-agent">Agent</span>
                ) : null}
                <span className="chist-banner-why">{whyOf(meta)}</span>
              </>
            )}
          </p>
        )}
        {missingPassage !== null ? (
          <p className="chist-banner-note">
            The passage had no place in this version{missingPassage ? `: “${missingPassage}”` : ''}.
          </p>
        ) : null}
        {note ? <p className="chist-banner-note">{note}</p> : null}
        <div className="chist-actions">
          {comparing ? null : (
            <button type="button" className="btn btn-accent" onClick={onBack}>
              <X size={14} aria-hidden="true" />
              Back to current
            </button>
          )}
          {comparing ? (
            <button type="button" className="btn" onClick={onView}>
              View version {version}
            </button>
          ) : (
            <button type="button" className="btn" onClick={onCompare}>
              Compare with current
            </button>
          )}
          {canWrite ? (
            <button type="button" className="btn" onClick={onRestore}>
              Restore {comparing ? `version ${version}` : 'this version'}
            </button>
          ) : null}
        </div>
      </div>
      {comparing ? (
        <div className="chist-nav" role="toolbar" aria-label="Changes">
          <div className="chist-where">
            <span className="chist-pair instrument">{pair}</span>
            <span className="chist-count" role="status" aria-live="polite">
              {diffPending
                ? 'Comparing…'
                : diffFailed
                  ? 'Could not compare'
                  : stale
                    ? 'The charter changed while you were looking'
                    : diff?.identical
                      ? 'No changes'
                      : total === 0
                        ? countOf(0)
                        : `${change + 1} of ${total}${diff && diff.stats.hunks > total ? ` (of ${diff.stats.hunks})` : ''}`}
            </span>
          </div>
          <button
            type="button"
            className="btn btn-ghost chist-step"
            aria-label="Previous change"
            disabled={total === 0}
            onClick={() => onStep(-1)}
          >
            <ChevronUp size={16} aria-hidden="true" />
            <span className="chist-step-text">Previous</span>
          </button>
          <button
            type="button"
            className="btn btn-ghost chist-step"
            aria-label="Next change"
            disabled={total === 0}
            onClick={() => onStep(1)}
          >
            <ChevronDown size={16} aria-hidden="true" />
            <span className="chist-step-text">Next</span>
          </button>
          <button
            type="button"
            className="btn btn-accent chist-exit"
            aria-label="Back to current"
            onClick={onBack}
          >
            <X size={14} aria-hidden="true" />
            <span className="chist-step-text">Back to current</span>
          </button>
        </div>
      ) : null}
    </>
  );
}

/* -------------------------------- the document ---------------------------- */

function VersionDocument({
  markdown,
  empty,
  loading,
  failed,
  marks,
  changes,
  scroll,
  scrollKey,
  onStale,
  onRetry,
}: {
  markdown: string | null;
  /** The version has no words: say so instead of drawing nothing. */
  empty: boolean;
  loading: boolean;
  failed: boolean;
  /** Null holds the marks back (a comparison that is not ready, or is stale). */
  marks: ViewerMarks | null;
  /** The comparison's changes, to check against the document before they are drawn. */
  changes: readonly Change[] | null;
  scroll: { change: number } | { flash: true } | null;
  /** A new value asks for the scroll again (the next change). */
  scrollKey: number;
  onStale: () => void;
  onRetry: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = useState<ViewerHandle | null>(null);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    const element = root.current;
    if (markdown === null || !element) return;
    let gone = false;
    let made: ViewerHandle | null = null;
    setBroken(false);
    void import('../lib/milkdown-history')
      .then((m) => m.createViewer(element, markdown))
      .then(
        (handle) => {
          if (gone) void handle.destroy();
          else {
            made = handle;
            setViewer(handle);
          }
        },
        () => {
          if (!gone) setBroken(true);
        },
      );
    return () => {
      gone = true;
      setViewer(null);
      if (made) void made.destroy();
    };
  }, [markdown]);

  // The marks are drawn only on the text they were made for.
  const fits = useMemo(
    () => (viewer && changes ? changesFit(changes, viewer.text()) : true),
    [viewer, changes],
  );
  useEffect(() => {
    if (!viewer || !changes || fits) return;
    onStale();
  }, [viewer, changes, fits, onStale]);
  useEffect(() => {
    if (viewer && marks && fits) viewer.setMarks(marks);
  }, [viewer, marks, fits]);
  const target = scroll && 'flash' in scroll ? 'flash' : scroll ? `change-${scroll.change}` : null;
  useEffect(() => {
    if (!viewer || !marks || !fits || !scroll) return;
    // After the marks are in the document.
    const frame = requestAnimationFrame(() => viewer.scrollTo(scroll));
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `scroll` is read through `target`
  }, [viewer, marks, fits, target, scrollKey]);

  return (
    <div className="chist-doc" data-state={viewer ? 'ready' : 'loading'}>
      {failed || broken ? (
        <div className="chist-failed" role="alert">
          <p>This version could not be shown.</p>
          <button type="button" className="btn" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : empty ? (
        <p className="chist-empty" role="status">
          This version was empty.
        </p>
      ) : !viewer ? (
        <Spinner label={loading ? 'Opening the version' : 'Drawing the version'} />
      ) : null}
      <div
        ref={root}
        className="chist-doc-body md-doc md-rich"
        aria-label="Charter, read only"
        hidden={!viewer}
      />
    </div>
  );
}
