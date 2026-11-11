/**
 * The architecture layout: one card, with the views (Charter, Map, Matrix) in
 * its top bar. The Charter is one document, an As written / As amended toggle, and
 * beside it a rail: what is orphaned, then Decisions (the ledger of accepted and
 * repealed ADRs in the order they were ratified, what is open, what was refused) or
 * the document's Outline. "Edit charter" edits the document in place
 * (`architecture-charter.tsx`). From 1024px the Map and Matrix fill the screen below the header,
 * so nothing needs a scroll to be seen at once.
 *
 * Select text in the charter to amend it: a selection toolbar (Propose ADR) opens the ADR panel
 * beside the charter with the selection as the quote. The toggle lives in `?view=`; the Map and
 * Matrix tabs (`?tab=`, focus in `?focus=`) are in `architecture-map.tsx`.
 */
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { replaceMarkers } from '@onmyradar/contract';
import type { ArchitectureAdrDto, BlipDto } from '@onmyradar/contract';
import { PanelHostProvider, usePanelHost, type PanelSlot } from '../components/side-panel';
import { AdrPanel, adrDraftDirty, emptyAdrDraft, type AdrDraft } from '../components/adr-panel';
import { BlipCard } from '../components/blips';
import { ConfirmDialog, Modal, Spinner, notify } from '../components/primitives';
import { ApiError, api } from '../lib/api';
import { renderMarkdown } from '../lib/markdown';
import { DESKTOP_QUERY, WIDE_QUERY, useMediaQuery } from '../lib/viewport';
import { Segmented } from '../components/repo-common';
import { MapKey, MapTab, MatrixTab } from './architecture-map';
import {
  BoundaryForm,
  ContractForm,
  EmptyTab,
  boundaryDraftKey,
  contractDraftKey,
  useFormDrafts,
} from './architecture-forms';
import {
  CharterEditor,
  Outline,
  SaveBadge,
  CharterDraftNotice,
  CharterLeaveGuard,
  useCharterEditing,
} from './architecture-charter';
import { useCharterHistory } from './architecture-history';
import { readingProps, type TemplateViewProps } from './index';
import {
  SelectionBar,
  selectionContext,
  selectionRect,
  type Selected,
} from './architecture-selection';
import { charterSelection } from './architecture-link-selection';
import { LinkActionsProvider, useCharterLinks } from './architecture-links';
import { ORPHAN_ACCEPT, OrphanTray } from './architecture-orphans';

export { seenText } from './architecture-selection';

type View = 'written' | 'amended';
type Tab = 'charter' | 'map' | 'matrix';
/** The open form on the Map tab: which kind, and which element (none is a new one). */
interface MapForm {
  kind: 'boundary' | 'contract';
  id: string | null;
  /** A new contract's two boundaries, when it was opened from a matrix cell. */
  ends?: { a: string; b: string };
}
const query = (name: string) => new URLSearchParams(window.location.search).get(name);
const initialView = (): View => (query('view') === 'written' ? 'written' : 'amended');
const TABS: Array<[Tab, string]> = [
  ['charter', 'Charter'],
  ['map', 'Map'],
  ['matrix', 'Matrix'],
];

/**
 * Sizes the card to the room left in the scroll pane below it (`--arch-fill`), so
 * the map and its detail are on screen together without the page scrolling. The
 * pane is `.scroll-area`; a page with none (a public one) scrolls the window.
 * Measured rather than guessed because what sits above the card - a composer,
 * a filter bar - is not the same on every radar. Set on the node itself: it is
 * not React state, and the same value twice changes nothing, so watching the
 * card's own parent for size changes cannot loop.
 */
function useFill(card: HTMLElement | null, active: boolean) {
  useLayoutEffect(() => {
    if (!card || !active) return;
    const pane = card.closest<HTMLElement>('.scroll-area');
    const measure = () => {
      const box = card.getBoundingClientRect();
      const top = pane
        ? box.top - pane.getBoundingClientRect().top + pane.scrollTop
        : box.top + window.scrollY;
      const room = (pane ? pane.clientHeight : window.innerHeight) - top - FILL_GAP;
      card.style.setProperty('--arch-fill', `${Math.max(0, Math.round(room))}px`);
    };
    measure();
    window.addEventListener('resize', measure);
    const watcher = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    watcher?.observe(card.parentElement ?? card);
    if (pane) watcher?.observe(pane);
    return () => {
      window.removeEventListener('resize', measure);
      watcher?.disconnect();
      card.style.removeProperty('--arch-fill');
    };
  }, [card, active]);
}
/** The radar column's bottom padding, left clear under the card. */
const FILL_GAP = 16;

/**
 * The bar's real height, as `--arch-bar`, so what sticks under it (the editor's tools, the rail)
 * clears it however many rows it wraps to. The stylesheet's 3.75rem is the one-row bar; an edit
 * bar that wraps at 1024px is taller, and the tools would slide under it.
 */
function useBarHeight(card: HTMLElement | null, active: boolean) {
  useLayoutEffect(() => {
    const bar = card?.querySelector<HTMLElement>('.arch-bar');
    if (!card || !bar || !active || typeof ResizeObserver === 'undefined') return;
    const measure = () => card.style.setProperty('--arch-bar', `${Math.round(bar.offsetHeight)}px`);
    measure();
    const watcher = new ResizeObserver(measure);
    watcher.observe(bar);
    return () => {
      watcher.disconnect();
      card.style.removeProperty('--arch-bar');
    };
  }, [card, active]);
}

export function ArchitectureView(props: TemplateViewProps) {
  const { radar, blips, readOnly, onChanged } = props;
  const client = useQueryClient();
  const [view, setView] = useState<View>(initialView);
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const wide = useMediaQuery(WIDE_QUERY);
  // State, not a ref: the card mounts after the data and the blips have both arrived, and the
  // measuring has to start when it does, not when the first render happened to ask.
  const [card, setCard] = useState<HTMLDivElement | null>(null);
  const [asked, setAsked] = useState<string | null>(() => query('tab'));
  const [focus, setFocus] = useState<string | null>(() => query('focus'));
  const [landOn, setLandOn] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [amending, setAmending] = useState<Selected | null>(null);
  // Writing: a boundary or contract, a free-standing ADR. The charter is edited in place, below.
  const [rail, setRail] = useState<'decisions' | 'outline'>('decisions');
  // The outline on a phone is a sheet: the rail is under the document there.
  const [outlining, setOutlining] = useState(false);
  const [form, setForm] = useState<MapForm | null>(null);
  // Boundary and contract drafts, kept here: the panel is drawn in a different place at 820px and at
  // 1024px, and a form mounted again opens on what was typed.
  const drafts = useFormDrafts();
  const [proposing, setProposing] = useState(false);
  // What has been typed into the Propose ADR panel, kept here so a tab switch (which takes the panel
  // away) or the window crossing 1024px (which swaps it for a sheet) does not take the text too.
  const [adrDraft, setAdrDraft] = useState<AdrDraft | null>(null);
  const [discarding, setDiscarding] = useState<(() => void) | null>(null);
  // Whether the ADR panel is open. A write to the draft after it was closed (the Why's last
  // moments, reported as the panel unmounts) is dropped, not kept for the next proposal.
  const proposalLive = useRef(false);
  const panelHost = usePanelHost();
  const [removing, setRemoving] = useState<string | null>(null);
  const pages = useRef<HTMLDivElement>(null);
  const architecture = useQuery({
    queryKey: ['architecture', radar.id],
    queryFn: () => api.radars.architecture(radar.id),
  });
  // The editor writes the charter as it is typed; each acknowledged write refreshes what is read.
  const editing = useCharterEditing(radar.id, (closed) => {
    void client.invalidateQueries({ queryKey: ['architecture', radar.id] });
    if (closed) onChanged();
  });
  const editingCharter = editing.active;

  const sources = architecture.data?.charter;
  useEffect(() => {
    if (readOnly) {
      setSelected(null);
      return;
    }
    // Words are selected in the reading view, or in the editor while the charter is being edited.
    const onChange = () =>
      setSelected(
        charterSelection(
          pages.current,
          editingCharter ? document.querySelector<HTMLElement>('.charter-edit .ProseMirror') : null,
          (sources ?? []).map((p) => ({ id: p.id, markdown: p.markdown ?? '' })),
        ),
      );
    // The toolbar follows the selection when the page scrolls under it: only where it is, not what
    // it is, so this is a rectangle read and not another look at the page.
    let frame = 0;
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const at = selectionRect();
        if (at) setSelected((now) => (now ? { ...now, ...at } : now));
      });
    };
    document.addEventListener('selectionchange', onChange);
    document.addEventListener('scroll', follow, { capture: true, passive: true });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', onChange);
      document.removeEventListener('scroll', follow, { capture: true });
    };
  }, [readOnly, editingCharter, sources]);

  // While the panel is open the text it changes stays marked in the charter, though the selection
  // itself has gone to the panel's fields. The CSS Custom Highlight API paints it without touching
  // the page's markup (a browser without it simply shows no mark).
  const marked = amending?.range;
  useEffect(() => {
    if (
      !marked ||
      typeof CSS === 'undefined' ||
      !('highlights' in CSS) ||
      typeof Highlight === 'undefined'
    )
      return;
    CSS.highlights.set('adr-selection', new Highlight(marked));
    return () => void CSS.highlights.delete('adr-selection');
  }, [marked]);

  const remember = (name: string, value: string | null) => {
    const url = new URL(window.location.href);
    if (value) url.searchParams.set(name, value);
    else url.searchParams.delete(name);
    window.history.replaceState(window.history.state, '', url);
  };
  const choose = (next: View) => {
    setView(next);
    remember('view', next);
  };
  const pick = (next: Tab) => {
    setAsked(next);
    remember('tab', next);
    // A map or matrix panel belongs to its tab. The ADR panel is the charter's, and what was typed
    // in it stays: it is there again when the Charter is.
    setForm(null);
  };
  /** Run `action`, after asking, when it would throw away an ADR somebody has started writing. */
  const unlessDraft = (action: () => void, keeps: string | null = null) => {
    if (adrDraftDirty(adrDraft) && adrDraft?.key !== keeps) setDiscarding(() => action);
    else action();
  };
  const closeProposal = () => {
    proposalLive.current = false;
    setAmending(null);
    setProposing(false);
    setAdrDraft(null);
  };
  const focusOn = (id: string | null) => {
    setFocus(id);
    remember('focus', id);
  };
  // The Charter is where the ledger of ADRs is, so it opens unless the map is all there is.
  const shown: Tab = TABS.some(([id]) => id === asked)
    ? (asked as Tab)
    : (architecture.data?.charter.length ?? 0) === 0 &&
        (architecture.data?.boundaries.length ?? 0) > 0
      ? 'map'
      : 'charter';
  useFill(card, Boolean(architecture.data) && desktop && shown !== 'charter');
  useBarHeight(card, Boolean(architecture.data) && desktop);
  // An ADR link from the Map lands on the ledger once the Charter tab is drawn.
  useEffect(() => {
    if (landOn && shown === 'charter') {
      document.getElementById(`adr-${landOn}`)?.scrollIntoView({ block: 'start' });
      setLandOn(null);
    }
  }, [landOn, shown]);
  const changed = useCallback(() => {
    void client.invalidateQueries({ queryKey: ['architecture', radar.id] });
    onChanged();
  }, [client, onChanged, radar.id]);
  const decide = async (id: string, decision: 'accept' | 'reject' | 'repeal') => {
    try {
      await api.blips.decide(id, decision);
      changed();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not record that decision.');
    }
  };

  const adrs = architecture.data?.adrs;
  const doc = architecture.data?.charter[0];
  const html = useMemo(() => {
    if (!doc) return null;
    const index = new Map((adrs ?? []).map((a) => [a.id, { label: a.label, lane: a.lane }]));
    // The same object across renders: React re-sets innerHTML for a new one, which
    // would collapse the reader's selection the moment the Amend bar appears.
    return { __html: renderMarkdown(doc.markdown ?? '', { amend: { view, adrs: index } }) };
  }, [adrs, doc, view]);
  // The charter's own words, with the amendments taken out: what the Outline reads.
  const writtenText = useMemo(
    () => replaceMarkers(doc?.markdown ?? '', (marker) => marker.quote),
    [doc?.markdown],
  );
  // History (versions, compare, restore) is for members; it draws its own parts, placed below.
  const history = useCharterHistory({
    radar,
    head: architecture.data,
    editing: editingCharter,
    desktop,
    showCharter: () => pick('charter'),
    onRestored: onChanged,
    beforeOpen: (open) =>
      unlessDraft(() => {
        closeProposal();
        open();
      }),
  });
  // The ADR panel and the history panel share the column: starting an ADR takes it.
  const writing = amending !== null || proposing;
  const closeHistoryPanel = history.closePanel;
  useEffect(() => {
    if (writing) closeHistoryPanel();
  }, [writing, closeHistoryPanel]);
  const outlineSource = useDeferredValue(
    history.text ?? (editingCharter ? editing.live : writtenText),
  );
  const links = useCharterLinks({
    radarId: radar.id,
    historyRadarId: history.available ? radar.id : undefined,
    data: architecture.data,
    canWrite: !readOnly,
    editing,
    pages,
    renderKey: html,
    onCharter: shown === 'charter',
    selected,
    written: view === 'written',
    toCharter: () => pick('charter'),
    toMap: (id) => {
      pick('map');
      focusOn(id);
    },
    onChanged: changed,
  });

  if (architecture.isError && !architecture.data)
    return <Retry what="this architecture" onRetry={() => void architecture.refetch()} />;
  if (!architecture.data) return <Spinner label="Reading the charter" />;
  const data = architecture.data;
  const canWrite = !readOnly;

  const ledger = (adrs ?? []).filter((a) => a.lane === 'accepted' || a.lane === 'repealed');
  // Every ADR comes from the architecture response, never from the paged stream.
  const inLane = (lane: string) => (adrs ?? []).filter((a) => a.lane === lane);
  const jump = (event: React.MouseEvent) => {
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#adr-"]');
    if (!link) return;
    event.preventDefault();
    document
      .getElementById(link.getAttribute('href')?.slice(1) ?? '')
      ?.scrollIntoView({ block: 'start' });
  };

  const toAdr = (id: string) => {
    pick('charter');
    setLandOn(id);
  };
  const keyOf = (next: MapForm) =>
    next.kind === 'boundary' ? boundaryDraftKey(next.id) : contractDraftKey(next.id, next.ends);
  const open = (next: MapForm | null) => {
    if (next) {
      pick('map');
      drafts.begin(keyOf(next));
    }
    setForm(next);
  };
  /** A contract's panel in the matrix, where the cell was pressed: the tab does not change. */
  const openHere = (next: MapForm) => {
    drafts.begin(keyOf(next));
    setForm(next);
    focusOn(next.id);
  };
  const formKey = form ? keyOf(form) : null;
  /** Close the open panel for good: what was typed in it goes with it. */
  const closeForm = () => {
    if (formKey) drafts.discard(formKey);
    setForm(null);
  };
  const saved = (id: string) => {
    if (formKey) drafts.discard(formKey);
    setForm(null);
    focusOn(id);
    changed();
  };
  const mapForm = form ? (
    form.kind === 'boundary' ? (
      <BoundaryForm
        key={form.id ?? 'new'}
        radarId={radar.id}
        data={data}
        boundaryId={form.id}
        drafts={drafts}
        onClose={closeForm}
        onSaved={saved}
        onRemove={canWrite ? setRemoving : undefined}
      />
    ) : (
      <ContractForm
        key={form.id ?? `new-${form.ends?.a ?? ''}-${form.ends?.b ?? ''}`}
        radarId={radar.id}
        data={data}
        contractId={form.id}
        ends={form.ends}
        drafts={drafts}
        onClose={closeForm}
        onSaved={saved}
        onRemove={canWrite ? setRemoving : undefined}
      />
    )
  ) : null;
  const edit = canWrite
    ? (id: string) =>
        open({ kind: data.contracts.some((c) => c.id === id) ? 'contract' : 'boundary', id })
    : undefined;
  const removable = removing
    ? ([...data.boundaries, ...data.contracts].find((e) => e.id === removing) ?? null)
    : null;
  const remove = async (id: string) => {
    try {
      await api.blips.remove(id);
      if (focus === id) focusOn(null);
      if (form?.id === id) closeForm();
      changed();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not remove that.', 'error');
    }
    setRemoving(null);
  };
  const share = { onEdit: edit, onRemove: canWrite ? setRemoving : undefined };
  const noCharter = html === null;
  // A cleared charter keeps its history: that is where it comes back from.
  const hasHistory = !noCharter || (data.charterVersion ?? 0) > 0;
  const orphans = data.orphans ?? [];
  /** Scroll the document (or the editor, while it is open) to its `index`th heading. */
  const jumpToHeading = (index: number) => {
    const root = history.active
      ? document.querySelector('.chist-doc-body .ProseMirror')
      : editingCharter
        ? document.querySelector('.charter-edit .ProseMirror')
        : pages.current;
    root?.querySelectorAll('h1, h2, h3, h4, h5, h6')[index]?.scrollIntoView({ block: 'start' });
  };
  const proposal = amending ?? (proposing ? { quote: undefined } : null);
  const proposalKey = proposal?.quote ?? 'free';
  const draft = adrDraft?.key === proposalKey ? adrDraft : emptyAdrDraft(proposalKey);
  const adrPanel =
    shown === 'charter' && proposal ? (
      <AdrPanel
        key={proposalKey}
        radarId={radar.id}
        quote={proposal.quote}
        pageId={amending?.pageId ?? null}
        prefix={amending?.prefix}
        suffix={amending?.suffix}
        context={
          amending?.occurrence === undefined || amending.seen === undefined
            ? undefined
            : { occurrence: amending.occurrence, seen: amending.seen }
        }
        architecture={data}
        draft={draft}
        onDraft={(patch) => {
          if (!proposalLive.current) return;
          setAdrDraft((current) => ({
            ...(current?.key === proposalKey ? current : emptyAdrDraft(proposalKey)),
            ...patch,
          }));
        }}
        onClose={() => unlessDraft(closeProposal)}
        onSaved={() => {
          closeProposal();
          window.getSelection()?.removeAllRanges();
          pick('charter');
          changed();
        }}
      />
    ) : null;
  // Where the open panel sits when it is a column of the card; drawn once, below, wherever that is.
  const panelOpen = shown === 'charter' ? adrPanel !== null || history.panelOpen : mapForm !== null;
  // The toolbar's selection: the one in the page, or the one the link picker was opened on.
  const barSelection: Selected | null = links.frozen ?? selected;
  const slot: PanelSlot = {
    open: panelOpen,
    show: panelHost.desktop && panelOpen,
    ref: panelHost.setSlot,
  };
  return (
    <PanelHostProvider value={panelHost.value}>
      <LinkActionsProvider value={links.actions}>
        <div
          ref={setCard}
          className="arch panel"
          data-tab={shown}
          data-editing={editingCharter && shown === 'charter' ? '' : undefined}
        >
          {editingCharter ? <CharterLeaveGuard editing={editing} /> : null}
          <div className="arch-bar">
            <div className="arch-bar-tabs">
              <div className="segmented arch-tabs" role="tablist" aria-label="Architecture views">
                {TABS.map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    className={`arch-tab ${shown === id ? 'is-on' : ''}`}
                    aria-selected={shown === id}
                    onClick={() => pick(id)}
                  >
                    {label}
                    {id === 'charter' && orphans.length > 0 ? (
                      <span
                        className="arch-tab-count"
                        aria-label={`${orphans.length} orphaned`}
                        title={`${orphans.length} orphaned`}
                      >
                        {orphans.length}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            </div>
            <div className="arch-bar-rest">
              {shown === 'charter' && history.active ? (
                <span className="chip-status is-edit">Reading history</span>
              ) : shown === 'charter' && editingCharter ? (
                <>
                  <span className="chip-status is-edit">Editing charter</span>
                  {/* Amendments are made on the written text, so it stays As written while editing. */}
                  <div className="segmented is-locked" role="group" aria-label="Charter text">
                    <button type="button" className="is-on" aria-pressed="true" disabled>
                      As written
                    </button>
                    <button type="button" aria-pressed="false" disabled>
                      As amended
                    </button>
                  </div>
                  <span className="charter-edit-hint">
                    You edit the plain text. ADRs show as underlines.
                  </span>
                </>
              ) : shown === 'charter' ? (
                <Segmented
                  label="Charter text"
                  value={view}
                  onChange={choose}
                  options={[
                    { value: 'written', label: 'As written' },
                    { value: 'amended', label: 'As amended' },
                  ]}
                />
              ) : (
                <div className="arch-bar-end">
                  {shown === 'map' && wide && data.boundaries.length > 0 ? <MapKey /> : null}
                  <span className="arch-count instrument">
                    {data.boundaries.length}{' '}
                    {data.boundaries.length === 1 ? 'boundary' : 'boundaries'}
                    {' · '}
                    {data.contracts.length} {data.contracts.length === 1 ? 'contract' : 'contracts'}
                  </span>
                </div>
              )}
              {canWrite ? (
                <div className="arch-actions">
                  {shown === 'charter' && !desktop && !noCharter ? (
                    <button type="button" className="btn" onClick={() => setOutlining(true)}>
                      Outline
                    </button>
                  ) : null}
                  {shown === 'charter' && hasHistory ? history.button : null}
                  {editingCharter ? (
                    <>
                      <SaveBadge snap={editing.snap} onRetry={editing.retry} />
                      <button
                        type="button"
                        className="btn btn-accent"
                        disabled={editing.finishing}
                        onClick={() => void editing.done()}
                      >
                        {editing.finishing ? 'Saving…' : 'Done'}
                      </button>
                    </>
                  ) : shown === 'charter' && !noCharter && !history.active ? (
                    <button
                      type="button"
                      className="btn"
                      disabled={editing.starting}
                      onClick={() => void editing.start()}
                    >
                      Edit charter
                    </button>
                  ) : null}
                  {shown === 'map' ? (
                    <>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => open({ kind: 'boundary', id: null })}
                      >
                        Add boundary
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={data.boundaries.length < 2}
                        title={
                          data.boundaries.length < 2
                            ? 'A contract joins two boundaries: add them first.'
                            : undefined
                        }
                        onClick={() => open({ kind: 'contract', id: null })}
                      >
                        Add contract
                      </button>
                    </>
                  ) : null}
                  {editingCharter || history.active ? null : (
                    <button
                      type="button"
                      className="btn btn-accent"
                      onClick={() => {
                        // An ADR is proposed in the charter's panel, wherever the button was pressed.
                        pick('charter');
                        unlessDraft(() => {
                          proposalLive.current = true;
                          setAmending(null);
                          setProposing(true);
                        }, 'free');
                      }}
                    >
                      Propose ADR
                    </button>
                  )}
                </div>
              ) : shown === 'charter' && hasHistory && history.button ? (
                <div className="arch-actions">{history.button}</div>
              ) : null}
            </div>
          </div>

          {shown === 'map' ? (
            <MapTab
              data={data}
              focus={focus}
              wide={wide}
              form={slot}
              canWrite={canWrite}
              onAdd={() => open({ kind: 'boundary', id: null })}
              onFocus={focusOn}
              onAdr={toAdr}
              {...share}
            />
          ) : null}
          {shown === 'matrix' ? (
            <MatrixTab
              data={data}
              focus={focus}
              wide={wide}
              panel={slot}
              openContract={canWrite ? openHere : undefined}
              canWrite={canWrite}
              onAdd={() => open({ kind: 'boundary', id: null })}
              onAdr={toAdr}
              onFocus={(id) => {
                focusOn(id);
                if (wide && id) pick('map');
              }}
              {...share}
            />
          ) : null}
          {shown === 'charter' ? (
            <div className={`arch-charter ${slot.show ? 'has-panel' : ''}`}>
              <div className="arch-doc">
                {links.banner}
                {noCharter && !editingCharter && !history.active ? (
                  <EmptyTab
                    title="No charter yet"
                    action={
                      canWrite ? (
                        <button
                          type="button"
                          className="btn btn-accent"
                          disabled={editing.starting}
                          onClick={() => void editing.start()}
                        >
                          Write the charter
                        </button>
                      ) : null
                    }
                  >
                    {canWrite
                      ? 'The charter is the document that says what this application is and the rules it keeps. Write it here; once it exists you change it by selecting text and proposing an ADR.'
                      : 'The charter is the document that says what this application is and the rules it keeps. Nobody has written it yet.'}
                  </EmptyTab>
                ) : null}
                {!editingCharter && !history.active ? (
                  <CharterDraftNotice editing={editing} />
                ) : null}
                {history.active ? (
                  <>
                    {history.banner}
                    {history.document}
                  </>
                ) : editingCharter ? (
                  <CharterEditor key={editing.session?.key} editing={editing} data={data} />
                ) : html ? (
                  <div ref={pages} className="arch-pages" onClick={jump}>
                    <article
                      data-page-id={doc?.id}
                      className="arch-page blip-body"
                      dangerouslySetInnerHTML={html}
                    />
                  </div>
                ) : (
                  <div ref={pages} className="arch-pages" />
                )}
              </div>

              {slot.show ? (
                <div ref={slot.ref} className="side-panel-slot" />
              ) : (
                <aside className="arch-rail" aria-label="Amendments and proposals">
                  <div className="arch-rail-inner">
                    <OrphanTray data={data} />
                    <div className="segmented arch-rail-tabs" role="group" aria-label="Rail">
                      {(['decisions', 'outline'] as const).map((id) => (
                        <button
                          key={id}
                          type="button"
                          aria-pressed={rail === id}
                          className={rail === id ? 'is-on' : ''}
                          onClick={() => setRail(id)}
                        >
                          {id === 'decisions' ? 'Decisions' : 'Outline'}
                        </button>
                      ))}
                    </div>
                    {rail === 'outline' ? (
                      <section className="arch-section" aria-label="Outline">
                        <h2 className="instrument">Outline</h2>
                        <Outline markdown={outlineSource} onJump={jumpToHeading} />
                      </section>
                    ) : (
                      <>
                        <section className="arch-section" aria-label="Amendments">
                          <h2 className="instrument">Amendments</h2>
                          {ledger.length === 0 ? (
                            <p className="note">No amendment has been accepted yet.</p>
                          ) : null}
                          {ledger.map((adr) => (
                            <LedgerRow
                              key={adr.id}
                              adr={adr}
                              adrs={adrs ?? []}
                              canDecide={!readOnly}
                              onRepeal={() => void decide(adr.id, 'repeal')}
                            />
                          ))}
                        </section>

                        {(['proposed', 'rejected'] as const).map((lane) => (
                          <section key={lane} className="arch-section" aria-label={lane}>
                            <h2 className="instrument">
                              {lane === 'proposed' ? 'Proposed' : 'Rejected'}
                            </h2>
                            {inLane(lane).length === 0 ? <p className="note">None.</p> : null}
                            {inLane(lane).map((adr) => (
                              <OpenAdr
                                key={adr.id}
                                adr={adr}
                                blip={blips.find((b) => b.id === adr.id)}
                                card={(blip) => (
                                  <BlipCard
                                    {...readingProps(props)}
                                    blip={blip}
                                    readOnly={readOnly}
                                    onChanged={changed}
                                    template={radar}
                                    commentsEnabled={radar.commentsEnabled}
                                    reactionsEnabled={radar.reactionsEnabled}
                                  />
                                )}
                                onDecide={
                                  lane === 'proposed' && !readOnly
                                    ? (decision) => void decide(adr.id, decision)
                                    : null
                                }
                              />
                            ))}
                          </section>
                        ))}
                      </>
                    )}
                  </div>
                </aside>
              )}
            </div>
          ) : null}
        </div>

        {shown === 'charter' && barSelection && !amending ? (
          <SelectionBar
            selected={barSelection}
            written={view === 'written'}
            extra={links.buttons}
            takeover={links.takeover}
            onPropose={() =>
              unlessDraft(() => {
                proposalLive.current = true;
                setAmending({
                  ...barSelection,
                  ...(barSelection.range ? selectionContext(barSelection.range) : {}),
                });
              }, barSelection.quote)
            }
            onShowWritten={() => choose('written')}
          />
        ) : null}
        {links.layer}
        {adrPanel}
        {shown === 'charter' && !adrPanel ? history.panel : null}
        {history.dialogs}
        {mapForm}
        {outlining && !desktop ? (
          <Modal title="Outline" onClose={() => setOutlining(false)}>
            <Outline
              markdown={outlineSource}
              onJump={(index) => {
                setOutlining(false);
                // After the sheet has gone, so the page is not held still under it.
                setTimeout(() => jumpToHeading(index), 50);
              }}
            />
          </Modal>
        ) : null}
        {discarding ? (
          <ConfirmDialog
            title="Discard draft?"
            body="The ADR you started writing is lost if you close it."
            confirmLabel="Discard"
            danger
            onConfirm={() => {
              const next = discarding;
              setDiscarding(null);
              setAdrDraft(null);
              next();
            }}
            onClose={() => setDiscarding(null)}
          />
        ) : null}
        {removable ? (
          <ConfirmDialog
            title={`Remove ${removable.title}?`}
            body="It is deleted from the map. A boundary that still has contracts, or anything an ADR amends, cannot be removed."
            confirmLabel="Remove"
            danger
            onConfirm={() => void remove(removable.id)}
            onClose={() => setRemoving(null)}
          />
        ) : null}
      </LinkActionsProvider>
    </PanelHostProvider>
  );
}

/** A failed read, with the way to try again. */
function Retry({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div role="alert" className="arch-error">
      <p>Couldn&apos;t read {what}.</p>
      <button type="button" className="btn btn-accent" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

/** What an ADR changes: the text it strikes, and what replaces it. */
function AdrChanges({ adr }: { adr: ArchitectureAdrDto }) {
  if (adr.anchors.length === 0) return null;
  return (
    <ul className="arch-changes" aria-label={`${adr.label} changes`}>
      {adr.anchors.map((anchor, index) => (
        <li key={index}>
          {anchor.state === 'orphaned' ? (
            <span className="chip-status is-orphan">Orphaned</span>
          ) : null}
          <del className="amend-struck">{anchor.quote}</del>
          <ins className="amend-with">{anchor.with}</ins>
        </li>
      ))}
    </ul>
  );
}

/** Why an ADR cannot be accepted yet, or null when it can. */
const acceptBlock = (adr: ArchitectureAdrDto): string | null =>
  adr.anchors.some((a) => a.state === 'orphaned') ? ORPHAN_ACCEPT : null;

/**
 * A Proposed or Rejected ADR. Its row comes from the architecture response, so it
 * is there however many blips the stream has paged in; the full card (its text,
 * comments and reactions) is the stream's blip when that has it, and is fetched
 * when the row is opened when not. What it changes and how to decide it show
 * without opening it.
 */
function OpenAdr({
  adr,
  blip,
  card,
  onDecide,
}: {
  adr: ArchitectureAdrDto;
  blip: BlipDto | undefined;
  card: (blip: BlipDto) => React.ReactNode;
  onDecide: ((decision: 'accept' | 'reject') => void) | null;
}) {
  // Open when the stream already holds the card (nothing to fetch); a row it does not hold waits
  // to be opened, so a long Proposed list is not a fetch per row.
  const [open, setOpen] = useState(Boolean(blip));
  const body = useQuery({
    queryKey: ['adr-body', adr.id],
    queryFn: () => api.blips.get(adr.id),
    enabled: open && !blip,
  });
  const shown = blip ?? body.data?.blip;
  const blocked = acceptBlock(adr);
  return (
    <div id={`adr-${adr.id}`} className="arch-open">
      {/* A row that can be closed, like the ledger's, since a rail of open cards is long. */}
      <button
        type="button"
        className="arch-adr-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="instrument">{adr.label}</span>
        <span className="arch-adr-title">{adr.title}</span>
      </button>
      {open && shown ? (
        card(shown)
      ) : open && body.isError ? (
        <Retry what="this ADR" onRetry={() => void body.refetch()} />
      ) : open ? (
        <Spinner label="Reading the ADR" />
      ) : null}
      <AdrChanges adr={adr} />
      {onDecide ? (
        <div className="arch-decide">
          {/* A disabled button shows no tooltip of its own, so the reason hangs on a wrapper. */}
          <span title={blocked ?? undefined}>
            <button
              type="button"
              className="btn btn-accent"
              disabled={blocked !== null}
              aria-describedby={blocked ? `${adr.id}-blocked` : undefined}
              onClick={() => onDecide('accept')}
            >
              Accept
            </button>
          </span>
          <button type="button" className="btn btn-ghost" onClick={() => onDecide('reject')}>
            Reject
          </button>
          {blocked ? (
            <p id={`${adr.id}-blocked`} className="note arch-decide-why">
              {blocked}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function LedgerRow({
  adr,
  adrs,
  canDecide,
  onRepeal,
}: {
  adr: ArchitectureAdrDto;
  adrs: readonly ArchitectureAdrDto[];
  canDecide: boolean;
  onRepeal: () => void;
}) {
  const [open, setOpen] = useState(false);
  const body = useQuery({
    queryKey: ['adr-body', adr.id],
    queryFn: () => api.blips.get(adr.id),
    enabled: open,
  });
  const by = adrs.find((a) => a.id === adr.supersededBy);
  const date = adr.ratifiedAt?.slice(0, 10);
  return (
    <div
      id={`adr-${adr.id}`}
      className={`arch-adr ${adr.lane === 'repealed' ? 'is-repealed' : ''}`}
    >
      <button
        type="button"
        className="arch-adr-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="instrument">{adr.label}</span>
        <span className="arch-adr-title">{adr.title}</span>
        <span className="instrument arch-adr-meta">
          {adr.lane === 'repealed' ? `repealed${by ? ` by ${by.label}` : ''}` : (date ?? '')}
          {adr.anchors.length > 0 ? ` · amends ${adr.anchors.length}` : ''}
        </span>
      </button>
      {adr.lane === 'accepted' && canDecide ? (
        <button type="button" className="btn btn-ghost" onClick={onRepeal}>
          Repeal
        </button>
      ) : null}
      {open ? (
        <div className="arch-adr-detail">
          <AdrChanges adr={adr} />
          {body.data ? (
            <div
              className="blip-body"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(body.data.blip.body) }}
            />
          ) : body.isError ? (
            <Retry what="this ADR" onRetry={() => void body.refetch()} />
          ) : (
            <Spinner label="Reading the ADR" />
          )}
        </div>
      ) : null}
    </div>
  );
}
