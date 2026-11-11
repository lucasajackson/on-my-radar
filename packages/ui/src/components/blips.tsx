import { DueControl } from './blip-due';
import { AssignControl, AssigneeChip } from './assign';
import { DueChip } from './due-chip';
import { Select } from './select';
import { EmailContent } from './email-content';
import { ReadingBody } from './reading-body';
import { DecisionReplacement } from './decision-replacement';
/** The stream: filter bar, blip cards, and the infinite list that holds them. */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  Image as ImageIcon,
  Link2,
  ListTodo,
  MessageSquare,
  MoreHorizontal,
  Maximize2,
  Paperclip,
  Pencil,
  Pin,
  Quote,
  ScrollText,
  StickyNote,
  Trash2,
  ArrowUpRight,
  Clock,
  CheckCheck,
  RotateCcw,
  Undo2,
  X,
} from 'lucide-react';
import {
  BLIP_STATE_LABELS,
  BLIP_STATES,
  bodyWithoutLeadUrl,
  bodyWithoutTitleHeading,
  extractInlineTags,
  hasFacet,
  photosFor,
  readStateFor,
  LIMITS,
  statusesFor,
  templateFor,
  type BlipDto,
  type BlipKind,
  type BlipState,
  type TemplateSource,
  type UpdateBlipRequest,
  advanceTarget,
  allowsTriageGesture,
  deferTarget,
  type TriageTarget,
} from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { fullTime, hostOf } from '../lib/format';
import { RelativeTime } from './relative-time';
import { plainText, renderMarkdown, tagHref } from '../lib/markdown';
import { BlipAttachments } from './attachments';
import { Conversation } from './conversation';
import { DecisionRequests } from './decision-requests';
import { ConfirmDialog, Empty, Modal, Spinner, notify } from './primitives';
import { SwipeRow, type SwipeAction } from './swipe';
import { Byline } from './byline';
import { entry } from '../lib/registry';
import { useBlipRoute } from '../lib/blip-route';
import {
  AFTER_REFETCH,
  afterLaneMove,
  cardSelector,
  focusWhenPresent,
  neighbourCard,
} from '../lib/focus';

const KIND_ICONS: Record<BlipKind, typeof StickyNote> = {
  note: StickyNote,
  link: Link2,
  image: ImageIcon,
  file: Paperclip,
  essay: ScrollText,
  quote: Quote,
  task: ListTodo,
};

/* ------------------------------- filter bar ------------------------------ */

/** A filter set to `undefined` is a filter cleared; the query string drops it. */
export interface StreamFilters {
  q: string;
  state?: BlipState | undefined;
  tag?: string | undefined;
  /** The radar template's own lane, when it has one. */
  status?: string | undefined;
}

export function FilterBar({
  filters,
  onChange,
  states,
  statuses = {},
  tags,
  template,
  showTriage = true,
}: {
  filters: StreamFilters;
  onChange: (next: StreamFilters) => void;
  states: Record<string, number>;
  /** Per-lane counts, for the lane rail. */
  statuses?: Record<string, number>;
  tags: Array<{ tag: string; count: number }>;
  /**
   * The radar, for its template *and* its own lane vocabulary — decides whether
   * the lane rail belongs here at all, and which lanes it draws. The pair rather
   * than a template id, so a radar with custom lanes cannot be rendered in the
   * registry's by a call site that forgot the second half.
   */
  template?: TemplateSource;
  /** A board already shows its lanes; the triage chips would say it twice. */
  showTriage?: boolean;
}) {
  const definition = templateFor(template?.template, template?.templateConfig);
  // Read off the registry, never off a template id. A stream has no lanes; a
  // board draws its own as columns and a rail here would say it twice; a reading
  // list and a decision log have four each and, before this, nowhere at all to
  // show them — reachable only through a dropdown on each card, which is a lane
  // axis that is declared and invisible.
  const lanes = definition.laneFilter ? definition.statuses : [];
  // A reader's filter is mail's Unread / All, not its lanes: the read state is a lane, but "read" is
  // not a place to browse.
  const readState = readStateFor(template?.template, template?.templateConfig);
  // Keep the rail compact; the active tag is always visible.
  const [allTags, setAllTags] = useState(false);
  const TAG_CAP = 8;
  /*
    The active tag is always in the visible set, whatever the cap says. A filter
    that is on and cannot be seen is a filter people conclude is broken — they
    are looking at a short list and nothing on screen says why.
  */
  const visibleTags = tags.slice(0, TAG_CAP);
  if (filters.tag && !visibleTags.some((t) => t.tag === filters.tag)) {
    const active = tags.find((t) => t.tag === filters.tag);
    if (active) visibleTags[TAG_CAP - 1] = active;
  }
  const hiddenTagCount = Math.max(tags.length - TAG_CAP, 0);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="filter-rail">
        {showTriage ? (
          <>
            <Chip
              label="All"
              count={Object.values(states).reduce((sum, n) => sum + n, 0)}
              active={!filters.state}
              onClick={() => onChange({ ...filters, state: undefined })}
            />
            {BLIP_STATES.map((state) => (
              <Chip
                key={state}
                label={BLIP_STATE_LABELS[state]}
                count={states[state] ?? 0}
                active={filters.state === state}
                onClick={() =>
                  onChange({ ...filters, state: filters.state === state ? undefined : state })
                }
              />
            ))}
          </>
        ) : null}

        {readState ? (
          <>
            <Chip
              label="Unread"
              count={statuses[readState.unread] ?? 0}
              active={filters.status === readState.unread}
              onClick={() => onChange({ ...filters, status: readState.unread })}
            />
            <Chip
              label="All"
              count={Object.values(statuses).reduce((sum, n) => sum + n, 0)}
              active={!filters.status}
              onClick={() => onChange({ ...filters, status: undefined })}
            />
          </>
        ) : null}

        {lanes.length > 0 ? (
          <>
            {/* A hairline between the two axes, so a triage chip and a lane chip
                are not read as one set of eleven. Only drawn when both are
                present — a separator with nothing on one side of it is noise. */}
            {showTriage ? <span className="filter-split" aria-hidden="true" /> : null}
            <Chip
              label="All"
              count={lanes.reduce((sum, lane) => sum + (statuses[lane.id] ?? 0), 0)}
              active={!filters.status}
              onClick={() => onChange({ ...filters, status: undefined })}
            />
            {lanes.map((lane) => (
              <Chip
                key={lane.id}
                label={lane.label}
                count={statuses[lane.id] ?? 0}
                active={filters.status === lane.id}
                onClick={() =>
                  onChange({
                    ...filters,
                    status: filters.status === lane.id ? undefined : lane.id,
                  })
                }
              />
            ))}
          </>
        ) : null}

        {tags.length > 0 ? (
          <>
            {showTriage || lanes.length > 0 || readState ? (
              <span className="filter-split" aria-hidden="true" />
            ) : null}
            {(allTags ? tags : visibleTags).map(({ tag, count }) => (
              <Chip
                key={tag}
                label={`#${tag}`}
                count={count}
                active={filters.tag === tag}
                onClick={() => onChange({ ...filters, tag: filters.tag === tag ? undefined : tag })}
              />
            ))}
            {hiddenTagCount > 0 ? (
              <button
                className="filter-more"
                aria-expanded={allTags}
                onClick={() => setAllTags((open) => !open)}
              >
                {allTags ? 'fewer tags' : `+${hiddenTagCount} more`}
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function Chip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className="flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px] transition-colors"
      style={{
        borderColor: active ? 'transparent' : 'var(--line)',
        background: active ? 'var(--accent-fill)' : 'var(--ink-800)',
        color: active ? 'color-mix(in srgb, var(--accent-ink) 85%, black)' : 'var(--paper-dim)',
      }}
    >
      {label}
      <span className="font-mono text-[10.5px] opacity-70">{count}</span>
    </button>
  );
}

/* ------------------------------- blip card ------------------------------- */

/** What to call a blip in a label or a dialog title: its title, or the start of it. */
/** A template's `dropped` lane, for choosing the icon a defer wears. */
function deferDroppedLane(source: {
  template: string | null;
  templateConfig: TemplateSource['templateConfig'] | null;
}): string | undefined {
  return statusesFor(source.template, source.templateConfig).find(
    (lane) => lane.state === 'dropped',
  )?.id;
}

export function cardLabel(blip: BlipDto): string {
  return blip.email?.subject || blip.title || plainText(blip.body, 60) || 'Untitled blip';
}

/**
 * Whether the viewer owns the radar a card sits on, read off the radar the
 * layouts hand down as `template` (a `RadarDto` everywhere a radar is known; a
 * bare template source on mixed lists, where it is simply false). Only the
 * helpdesk composer's hint uses it — the server decides what a reply becomes.
 */
function ownsRadarOf(source: TemplateSource | undefined): boolean {
  const access = (source as { access?: { via?: string | null } } | undefined)?.access;
  return access?.via === 'owner';
}

export function BlipCard({
  blip,
  readOnly,
  isNew,
  onChanged,
  template,
  linkTags = true,
  compact = false,
  inLane = false,
  conversation = true,
  commentsEnabled = true,
  reactionsEnabled = true,
  publicSlug,
  swipe = false,
  threadOpen = false,
  decisions = false,
  onOpenDetail,
  onDeleted,
  startEditing = false,
  keepConversationWhileEditing = false,
  compactPreview = false,
}: {
  blip: BlipDto;
  readOnly: boolean;
  /** A board-owned popup keeps its identity across lane moves and refetches. */
  onOpenDetail?: (editing: boolean) => void;
  /** Only a successful deletion initiated here closes an owning detail popup. */
  onDeleted?: (id: string) => void;
  startEditing?: boolean;
  keepConversationWhileEditing?: boolean;
  /** Explicitly set only by in-lane board cards, never by their full detail popup. */
  compactPreview?: boolean;
  isNew?: boolean;
  onChanged: (deletedId?: string) => void;
  /** The owning radar, so the lane control offers the lanes this radar has. */
  template?: TemplateSource;
  /** False on a public page, where the tag pages are behind sign-in. */
  linkTags?: boolean;
  /** Board cards are dense: no meta row chrome beyond what a column needs. */
  compact?: boolean;
  /**
   * The card is inside a board lane, and therefore inside a column whose width
   * was decided by how many lanes fit rather than by what the card wants.
   *
   * Separate from `compact` because a microblog post is compact too, and the two
   * want opposite things here. A board card's controls have to leave the meta row
   * or the lane will push them outside the card. A timeline post has all the
   * width it needs, and a floating control box in the middle of a reading column
   * is precisely the chrome that template is defined by removing — which is what
   * happened when this keyed on `compact` and a screenshot showed it.
   */
  inLane?: boolean;
  /**
   * Whether the reactions row and comment thread are carried. Separate from
   * `compact` because a microblog post is compact *and* the surface where a
   * reaction belongs most; only a board card, which lives inside a column,
   * genuinely cannot hold a thread.
   */
  conversation?: boolean;
  /** Open the thread at once: the card was opened in order to reply to it. */
  threadOpen?: boolean;
  /** Questions put to the person, above the thread: only where the card is opened, not in a list. */
  decisions?: boolean;
  /**
   * The owning radar's participation switches. Defaulted true so a caller that
   * has no radar to hand — the tag page's mixed list — still shows a thread that
   * already exists rather than hiding it on a technicality.
   */
  commentsEnabled?: boolean;
  reactionsEnabled?: boolean;
  /** Set on a public page: the thread is readable, nothing can be added to it. */
  publicSlug?: string;
  /**
   * Whether the card can be triaged by pushing it sideways.
   *
   * Set by the list views and never by the board: a lane full of horizontally
   * swipeable cards inside a horizontally paged board is two gestures competing
   * for one axis, and no threshold resolves that. See `components/swipe.tsx`.
   */
  swipe?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(startEditing && !readOnly);
  const [confirming, setConfirming] = useState(false);
  const [discussing, setDiscussing] = useState(false);
  // On an app radar the dialog has an address; `routed` is set when this card pushed it.
  const blipRoute = useBlipRoute();
  const hasRoute = Boolean(blipRoute);
  const routeOpen = blipRoute?.openId === blip.id;
  const routed = useRef(false);
  useEffect(() => {
    if (hasRoute && !routeOpen) setDiscussing(false);
  }, [hasRoute, routeOpen]);
  const closeDiscussion = () => {
    setDiscussing(false);
    if (routed.current) blipRoute?.close();
    routed.current = false;
  };
  const currentBlipId = useRef(blip.id);
  currentBlipId.current = blip.id;
  // A card that carries no thread still belongs to a radar that may have
  // comments and reactions on; it offers them in a dialog rather than not at all.
  const cardRef = useRef<HTMLElement>(null);
  // Back to the card that was edited, not to the page title: the editor that
  // had focus is gone the moment it saves or cancels.
  const backToCard = () => {
    // The dialog this card is open in, if any: its twin on the page behind is
    // not where the person is working.
    const dialog = cardRef.current?.closest('[role="dialog"]') ?? null;
    focusWhenPresent(
      [`${cardSelector(blip.id)} button[aria-label^="Edit "]`, cardSelector(blip.id)],
      { ...AFTER_REFETCH, within: () => (dialog?.isConnected ? dialog : document) },
    );
  };
  const canDiscuss = !conversation && (commentsEnabled || reactionsEnabled);
  const [replacing, setReplacing] = useState(false);
  const Icon = entry(KIND_ICONS, blip.kind) ?? StickyNote;
  const lanes = statusesFor(template?.template, template?.templateConfig);
  // The facets this template's cards lead with. Asked as "what does my template
  // want", never "which template am I on" — the difference between an
  // abstraction and a switch statement with extra steps.
  const showSource = !blip.email && hasFacet(template?.template, 'source');
  const showSupersession = hasFacet(template?.template, 'supersession');
  const showAssignee = hasFacet(template?.template, 'assignee');
  // A card that leads with its requester names no owner, editor or mover.
  const showMoved = hasFacet(template?.template, 'moved');
  const boardTemplate = templateFor(template?.template).layout === 'board';
  const detailSurface = boardTemplate && keepConversationWhileEditing;
  // inLane is a desktop width treatment, not the identity of a phone board card.
  const boardSurface = boardTemplate && compactPreview && Boolean(onOpenDetail);
  // The client's waiting clock has its own row on compact cards: unlike the
  // requester, it must not compete with the board's nowrap metadata controls.
  const awaitingClientFacet = blip.awaitingClientSince ? (
    <span
      className="instrument awaiting-client shrink-0"
      data-facet="awaiting-client"
      title={`Waiting on the client since ${fullTime(blip.awaitingClientSince)}`}
    >
      waiting on client · <RelativeTime iso={blip.awaitingClientSince} />
    </span>
  ) : null;
  // Two things the card has already hoisted out of the body must not then be
  // printed again underneath it: the heading it took the title from, and — on a
  // template that leads with its source — the URL, which by then is in the meta
  // row and in the preview card as well. Three copies of a raw URL, and the raw
  // one is the ugliest.
  const body = useMemo(() => {
    if (blip.email) return '';
    const withoutHeading = bodyWithoutTitleHeading(blip.body, blip.title);
    return showSource ? bodyWithoutLeadUrl(withoutHeading, blip.url) : withoutHeading;
  }, [blip.body, blip.title, blip.url, blip.email, showSource]);
  const html = useMemo(
    // The blip's own body can address people too — a thread's opening post is
    // where a discussion usually names who it is for.
    () => renderMarkdown(body, { tagLinks: linkTags, mentions: blip.mentions ?? [] }),
    [body, linkTags, blip.mentions],
  );
  // Keep the rendered inline search link; only its duplicate metadata chip goes.
  // Code blocks and unrendered hashtags do not hide a tag's navigation control.
  const visibleTags =
    detailSurface && !editing && linkTags
      ? blip.tags.filter((tag) => !html.includes(`class="tag-link" href="${tagHref(tag)}"`))
      : blip.tags;

  /** Whether it saved, so a caller never acknowledges a change that did not happen. */
  const mutate = async (patch: UpdateBlipRequest): Promise<boolean> => {
    setBusy(true);
    try {
      await api.blips.update(blip.id, patch);
      onChanged();
      return true;
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not update that blip', 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  /** A lane change from the card's own control: said, undoable, and focus stays with the card. */
  const moveTo = async (status: string) => {
    const from = blip.status;
    // Read before the move: afterwards this card's old place is already gone.
    const neighbour = neighbourCard(blip.id);
    if (!(await mutate({ status }))) return;
    // The card may remount in another lane; its lane control is where focus was.
    // On a phone the board shows one lane, so a moved card can leave the screen.
    if (!keepConversationWhileEditing)
      focusWhenPresent(afterLaneMove(blip.id, neighbour), AFTER_REFETCH);
    if (!from || from === status) return;
    const label = lanes.find((lane) => lane.id === status)?.label ?? 'another lane';
    notify(`Moved to ${label}`, 'ok', {
      label: 'Undo',
      run: () => {
        void mutate({ status: from });
      },
    });
  };

  const remove = async () => {
    setConfirming(false);
    setBusy(true);
    // Where focus goes once this card is gone: the next card, else the one
    // before, else the capture box — never the body.
    const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-blip-id]')).filter(
      (card) => !card.closest('[role="dialog"]'),
    );
    const at = cards.findIndex((card) => card.dataset['blipId'] === blip.id);
    const neighbour = cards[at + 1] ?? cards[at - 1];
    const neighbourId = neighbour?.dataset['blipId'];
    try {
      await api.blips.remove(blip.id);
      notify('Blip deleted');
      onDeleted?.(blip.id);
      onChanged(onDeleted ? blip.id : undefined);
      focusWhenPresent(
        [...(neighbourId ? [cardSelector(neighbourId)] : []), 'main h1'],
        AFTER_REFETCH,
      );
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not delete that blip', 'error');
      setBusy(false);
    }
  };

  /*
    Triage by gesture: what each direction does is the contract's
    (`advanceTarget` / `deferTarget` in packages/contract/src/triage.ts), the
    same answer the iOS app renders — lanes by their own names, reopening to
    work rather than the inbox, deferring as a gradient, and no gesture at all
    where the template has no triage to show (`allowsTriageGesture`).

    Both directions write the same field the card's own lane or state control
    writes: the gesture is a second way to do a thing that already has a
    control, never the only way. Undo restores the lane as well as the state,
    because on a template with lanes the server derives one from the other and
    putting back only half of it would leave the card in the right lane with
    the wrong state, or the reverse.
  */
  const run = (target: TriageTarget) => () => {
    const wasState = blip.state;
    const wasStatus = blip.status;
    void (async () => {
      // A failed swipe used to show its error and then "Marked done" with an
      // Undo on top of it — the second toast contradicting the first.
      const patch: UpdateBlipRequest = target.status
        ? { status: target.status }
        : target.state
          ? { state: target.state }
          : {};
      if (!(await mutate(patch))) return;
      notify(target.acknowledgement, 'ok', {
        label: 'Undo',
        run: () => {
          void mutate(wasStatus ? { status: wasStatus } : { state: wasState });
        },
      });
    })();
  };
  const triageSource = {
    template: template?.template ?? null,
    templateConfig: template?.templateConfig ?? null,
  };
  const gestures = allowsTriageGesture(triageSource);
  const advanceTo = gestures ? advanceTarget(triageSource, blip) : null;
  const deferTo = gestures ? deferTarget(triageSource, blip) : null;
  const advance: SwipeAction | undefined = advanceTo
    ? {
        label: advanceTo.label,
        icon: advanceTo.reopens ? (
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
        ) : (
          <CheckCheck className="h-4 w-4" aria-hidden="true" />
        ),
        run: run(advanceTo),
      }
    : undefined;
  const defer: SwipeAction | undefined = deferTo
    ? {
        label: deferTo.label,
        icon: deferTo.reopens ? (
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
        ) : deferTo.state === 'dropped' || deferTo.status === deferDroppedLane(triageSource) ? (
          // Dropped is a triage state, not a deletion: reversible with one tap,
          // which is the only reason a gesture is allowed to do it.
          <X className="h-4 w-4" aria-hidden="true" />
        ) : (
          <Clock className="h-4 w-4" aria-hidden="true" />
        ),
        tone: 'quiet',
        run: run(deferTo),
      }
    : undefined;

  const dueControl = !publicSlug ? (
    detailSurface || boardSurface ? (
      <span className="kanban-due-control">
        <DueControl blip={blip} canWrite showLabel={detailSurface} />
      </span>
    ) : (
      <DueControl blip={blip} canWrite />
    )
  ) : null;

  const primaryControls = (
    <>
      {lanes.length > 0 || templateFor(template?.template).showTriage ? (
        <label className="sr-only" htmlFor={`state-${blip.id}`}>
          {lanes.length > 0 ? 'Lane' : 'Triage state'} for {cardLabel(blip)}
        </label>
      ) : null}
      {lanes.length > 0 ? (
        /* The template's own lanes. Moving between them also moves the
                 blip's triage state, which the server does — so there is only
                 one control here, not two that could disagree.

                 Capped on a compact card: the widest lane label is what sets
                 this control's intrinsic width, and on a board that made a
                 five-lane template's cards wider than a five-lane board can
                 afford. The trigger truncates while the menu shows the full list. */
        <Select
          id={`state-${blip.id}`}
          className={`instrument rounded border border-[color:var(--line)] bg-[color:var(--ink-850)] px-1.5 py-1 ${
            inLane ? 'max-w-[6.5rem] min-w-0' : ''
          }`}
          value={blip.status ?? ''}
          disabled={busy}
          aria-label={`Lane for ${cardLabel(blip)}`}
          onValueChange={(value) => void moveTo(value)}
          options={lanes.map((lane) => ({ value: lane.id, label: lane.label }))}
        />
      ) : !templateFor(template?.template).showTriage ? (
        <PostActions state={blip.state} busy={busy} onChange={(state) => void mutate({ state })} />
      ) : (
        <Select
          id={`state-${blip.id}`}
          className={`instrument rounded border border-[color:var(--line)] bg-[color:var(--ink-850)] px-1.5 py-1 ${
            inLane ? 'max-w-[6.5rem] min-w-0' : ''
          }`}
          value={blip.state}
          disabled={busy}
          onValueChange={(value) => {
            const state = BLIP_STATES.find((known) => known === value);
            if (state) void mutate({ state });
          }}
          options={BLIP_STATES.map((state) => ({
            value: state,
            label: BLIP_STATE_LABELS[state],
          }))}
        />
      )}
      <button
        className={`btn btn-ghost ${detailSurface ? 'py-1.5' : 'p-1.5'}`}
        title="Edit"
        aria-label={`Edit ${cardLabel(blip)}`}
        disabled={busy}
        onClick={() => (onOpenDetail ? onOpenDetail(true) : setEditing(true))}
      >
        <Pencil className="h-3.5 w-3.5" />
        {detailSurface ? <span>Edit</span> : null}
      </button>
    </>
  );
  const secondaryControls = (
    <>
      <button
        className="btn btn-ghost p-1.5"
        title={blip.pinned ? 'Unpin' : 'Pin to the top'}
        aria-label={`Pin ${cardLabel(blip)} to the top`}
        aria-pressed={blip.pinned}
        disabled={busy}
        onClick={() => void mutate({ pinned: !blip.pinned })}
      >
        <Pin className="h-3.5 w-3.5" />
      </button>
      <button
        className="btn btn-ghost p-1.5"
        title="Delete"
        aria-label={`Delete ${cardLabel(blip)}`}
        disabled={busy}
        onClick={() => setConfirming(true)}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </>
  );
  const toolbar = !readOnly ? (
    <div
      className={`blip-actions flex shrink-0 items-center ${detailSurface ? 'kanban-detail-actions' : boardSurface ? 'kanban-card-actions' : 'ml-auto gap-1'}`}
    >
      {detailSurface || boardSurface ? null : dueControl}
      {detailSurface || boardSurface ? (
        <>
          <div className="kanban-primary-actions">{primaryControls}</div>
          <div className="kanban-secondary-actions">
            {dueControl}
            {secondaryControls}
          </div>
        </>
      ) : (
        <>
          {primaryControls}
          {secondaryControls}
        </>
      )}
    </div>
  ) : null;

  return (
    <SwipeRow
      disabled={!swipe || readOnly || busy}
      {...(advance ? { left: advance } : {})}
      {...(defer ? { right: defer } : {})}
    >
      <article
        ref={cardRef}
        // The anchor a notification deep-links to. An id attribute would collide
        // with anything else on the page using the same uuid; a data attribute
        // scoped to blips cannot.
        data-blip-id={blip.id}
        className={`blip-card group relative ${detailSurface ? 'kanban-detail' : boardSurface ? 'kanban-compact pl-4' : 'pl-4'} ${isNew ? 'ping-in' : ''} ${
          busy ? 'opacity-60' : ''
        }`}
        style={{ opacity: blip.state === 'dropped' ? 0.55 : undefined }}
      >
        {/* The accent rule and marker: the instrument edge of the card. */}
        <span
          className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-full"
          style={{ background: 'var(--accent-from)', opacity: blip.pinned ? 0.9 : 0.28 }}
          aria-hidden="true"
        />

        <div
          className={`blip-meta flex items-center gap-x-2.5 gap-y-1.5 ${detailSurface || boardSurface ? '' : 'pt-3'} ${inLane && !boardSurface ? 'flex-wrap' : ''}`}
        >
          <Icon
            className="h-3.5 w-3.5 shrink-0 text-[color:var(--paper-faint)]"
            aria-hidden="true"
          />
          <span className="instrument shrink-0" title={fullTime(blip.createdAt)}>
            <RelativeTime iso={blip.createdAt} />
          </span>
          {/* On a reading list the URL is the object, so where it came from is
            worth more than the word "link" — and it is the only bit of the card
            you can read at a glance to decide whether to open it. */}
          {(showSource || compactPreview) && blip.url ? (
            <a
              className="instrument source-link shrink-0"
              href={blip.url}
              target="_blank"
              rel="noreferrer noopener"
              title={blip.url}
            >
              {hostOf(blip.url)}
              <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
            </a>
          ) : compact ? null : (
            <span className="instrument shrink-0">{blip.kind}</span>
          )}
          {blip.pinned ? (
            <Pin className="h-3 w-3 shrink-0 text-[color:var(--accent-from)]" />
          ) : null}
          {/* A board card sits inside a lane that already declares the triage
            state — every lane maps to one. Printing it again on the card is the
            same "says it twice" failure the title rule exists to avoid. */}
          {blip.state !== 'inbox' &&
          lanes.length === 0 &&
          templateFor(template?.template).showTriage ? (
            /* Hidden by the stylesheet wherever the action cluster is painted at
               rest — on a touch device the select beside it already says the
               same word, and two copies of the state cost the row about 60px it
               does not have at 390px. The delete control was what got pushed out
               of the card for it. */
            <span
              className="instrument blip-state-badge shrink-0 rounded px-1.5 py-0.5"
              style={{ background: 'var(--ink-700)', color: 'var(--paper-dim)' }}
            >
              {BLIP_STATE_LABELS[blip.state]}
            </span>
          ) : null}
          {/*
          `min-w-0` is not cosmetic. Without it a flex child that truncates still
          contributes its *whole* text to the row's min-content width, so on a
          board card a long author name was part of why the row could not fit —
          and the thing that got pushed out of view was the actions cluster on
          the other end. Whose blip it is may shorten to an ellipsis; the control
          that edits it may not disappear.
        */}
          {blip.external ? (
            /* A client's request through the portal: who asked, as the portal
               asserted it — untrusted text, never linked (HELPDESK §6). The
               owner is the blip's author only for authorization, so their name
               would be the wrong one to lead with. */
            <span className="instrument requester-facet min-w-0 truncate" data-facet="requester">
              from {blip.external.requesterName} · via {blip.external.via}
            </span>
          ) : blip.author?.name || blip.author?.email ? (
            <Byline
              className="min-w-0 truncate"
              authorName={blip.author.name ?? blip.author.email.split('@')[0] ?? blip.author.email}
              agent={blip.agent}
              voice={blip.voice}
            />
          ) : null}
          {/* The creator's byline never changes; whoever edited last is named beside it. */}
          {blip.lastEditedBy && !blip.external ? (
            <span className="instrument min-w-0 truncate" data-facet="edited-by">
              · edited by {blip.lastEditedBy.name ?? 'someone'}
            </span>
          ) : null}
          {/* Computed from the thread, never a separately stored clock. */}
          {boardSurface ? null : awaitingClientFacet}
          {/* A board card carries no thread inline: a column cannot hold one.
            It used to show only a count, so on a radar with comments and
            reactions switched on a board card could not be answered at all.
            The count is now the way in — the same card, with its thread and
            reactions, in a dialog. */}
          {onOpenDetail ? (
            <button
              type="button"
              className="btn btn-ghost p-1.5"
              data-open-blip
              aria-label={`Open ${cardLabel(blip)}`}
              onClick={() => onOpenDetail(false)}
            >
              <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null}
          {canDiscuss ? (
            <button
              type="button"
              className="card-discuss instrument flex shrink-0 items-center gap-1 !tracking-normal"
              aria-label={`${commentsEnabled ? 'Comments' : 'Reactions'} on ${cardLabel(blip)}${
                blip.commentCount > 0 ? `, ${blip.commentCount}` : ''
              }`}
              onClick={() => {
                if (onOpenDetail) {
                  onOpenDetail(false);
                  return;
                }
                routed.current = blipRoute?.open(blip.id) ?? false;
                setDiscussing(true);
              }}
            >
              <MessageSquare className="h-3 w-3" aria-hidden="true" />
              {blip.commentCount > 0 ? blip.commentCount : null}
            </button>
          ) : !conversation && blip.commentCount > 0 ? (
            <span className="instrument flex shrink-0 items-center gap-1 !tracking-normal">
              <MessageSquare className="h-3 w-3" aria-hidden="true" />
              {blip.commentCount}
            </span>
          ) : null}

          {/*
          Two layouts for one cluster, and the difference is not cosmetic.

          Inline (`ml-auto`) is right on a full-width card: the row has more
          width than it needs and the controls read as the end of a readout.

          Inside a **lane** it was the bug. A board card's meta row wanted 283px
          of min-content and its column could only give it 169px at a 1366
          laptop, so the row overflowed, the column clipped it, and edit, pin and
          delete ended up outside the card — present, focusable and invisible.
          That is the "I don't see the button to edit" report, and shrinking the
          parts until they fit only moves the width at which it comes back.

          Lifting the cluster out of the flow removes the arithmetic instead of
          tuning it: it no longer competes for the row's width at all, so no lane
          width can push it out. `shrink-0` still applies to the inline case, so
          that even there the controls are the last thing given up.
        */}
          {boardSurface ? null : toolbar}
        </div>
        {boardSurface && awaitingClientFacet ? (
          <div className="mt-1.5">{awaitingClientFacet}</div>
        ) : null}

        {blip.dueAt || (!publicSlug && readOnly && blip.reminder) ? (
          <div className="blip-due-row">
            <DueChip blip={blip} personal={!publicSlug} />
            {!blip.dueAt && blip.reminder ? <span className="note">Reminder paused</span> : null}
            {!publicSlug && readOnly ? <DueControl blip={blip} /> : null}
          </div>
        ) : null}

        {editing && !readOnly ? (
          <BlipEditor
            blip={blip}
            containEscape={keepConversationWhileEditing}
            onCancel={() => {
              setEditing(false);
              backToCard();
            }}
            onSaved={() => {
              setEditing(false);
              onChanged();
              backToCard();
            }}
          />
        ) : compactPreview && !blip.email ? (
          <>
            {blip.title ? (
              <h3 className="mt-1.5 line-clamp-2 text-[15.5px] font-semibold tracking-tight">
                {blip.title}
              </h3>
            ) : null}
            {body ? (
              <p className="blip-body mt-1.5 line-clamp-4 max-h-24 overflow-hidden">
                {plainText(body, 300)}
              </p>
            ) : null}
          </>
        ) : blip.email ? (
          <>
            <EmailContent
              blip={blip}
              compact={compactPreview}
              {...(publicSlug ? { publicSlug } : {})}
            />
            {blip.email.notes ? (
              <div className="mt-3 border-l-2 border-[color:var(--line)] pl-3">
                <p className="instrument mb-1">Notes</p>
                <p
                  className={`text-[13.5px] whitespace-pre-wrap break-words ${compactPreview ? 'line-clamp-4 max-h-24 overflow-hidden' : ''}`}
                >
                  {blip.email.notes}
                </p>
              </div>
            ) : null}
          </>
        ) : (
          <>
            {blip.title && !detailSurface ? (
              <h3 className="mt-1.5 text-[15.5px] font-semibold tracking-tight">{blip.title}</h3>
            ) : null}

            {body ? (
              <ReadingBody
                body={body}
                html={html}
                collapsible={showSource && !keepConversationWhileEditing}
              />
            ) : null}
          </>
        )}

        {/* Everywhere else a preview belongs to a link blip. On a template whose
          cards lead with their source, a blip with a URL leads with it whatever
          the kind heuristic decided — the link is the object, and a note written
          around it does not demote it to an aside. */}
        {!editing &&
        !compactPreview &&
        !blip.email &&
        blip.url &&
        (blip.kind === 'link' || showSource) ? (
          // Not on a public page: the anonymous reader has no blip route to ask.
          <LinkPreview blip={blip} poll={!publicSlug} />
        ) : null}

        {!editing && showSupersession ? <Supersession blip={blip} /> : null}
        {!editing && showAssignee ? (
          <Holders blip={blip} assignable={detailSurface && !readOnly && !publicSlug} />
        ) : null}
        {!editing && showMoved && blip.lastMovedBy && !blip.external ? (
          <div className="supersession">
            <span className="instrument" data-facet="moved-by">
              moved by {blip.lastMovedBy.name ?? 'someone'}
            </span>
          </div>
        ) : null}
        {!editing && !readOnly && showSupersession && !blip.supersededBy ? (
          <button type="button" className="btn btn-ghost mt-2" onClick={() => setReplacing(true)}>
            <RotateCcw className="h-4 w-4" /> Replace decision
          </button>
        ) : null}
        {replacing ? (
          <DecisionReplacement
            blip={blip}
            onClose={() => setReplacing(false)}
            onCreated={() => {
              setReplacing(false);
              notify('Replacement saved. The original decision is linked below it.');
              onChanged();
            }}
          />
        ) : null}

        {/* The treatment is read off the template, never off `compact`. `compact`
          means "this card is dense, drop the kind badge" and nothing more —
          conflating the two is what made a microblog photo an 11rem thumbnail
          hanging off the left margin. */}
        {!editing && compactPreview && blip.attachments.length > 0 ? (
          <p className="instrument mt-2 flex items-center gap-1.5">
            <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
            {blip.attachments.length} {blip.attachments.length === 1 ? 'attachment' : 'attachments'}
          </p>
        ) : !editing && !blip.email ? (
          <BlipAttachments
            attachments={blip.attachments}
            treatment={photosFor(template?.template)}
          />
        ) : null}

        {boardSurface ? toolbar : null}
        <div className="mt-2.5 pb-3">
          {visibleTags.length > 0 ? (
            <div className="blip-tags flex flex-wrap gap-1.5">
              {visibleTags.map((tag) =>
                linkTags ? (
                  /* Every tag is a way out of this blip and into every other one
                   carrying it — across all radars, not just this one. */
                  <Link
                    key={tag}
                    to="/t/$tag"
                    params={{ tag }}
                    className="instrument tag-link !tracking-[0.08em]"
                  >
                    #{tag}
                  </Link>
                ) : (
                  <span key={tag} className="instrument !tracking-[0.08em]">
                    #{tag}
                  </span>
                ),
              )}
            </div>
          ) : null}

          {/* A board card is a card in a column: a thread would turn the column
            into a page. The count is still visible in its meta row, and the blip
            carries its conversation everywhere else. */}
          {(!editing || keepConversationWhileEditing) && conversation ? (
            <div className={detailSurface ? 'kanban-detail-conversation' : undefined}>
              {detailSurface && (commentsEnabled || blip.commentCount > 0) ? (
                <h3 className="kanban-detail-section-title">Comments</h3>
              ) : null}
              {decisions && commentsEnabled && !publicSlug ? (
                <DecisionRequests blipId={blip.id} onChanged={onChanged} />
              ) : null}
              <Conversation
                blip={blip}
                // The conversation's shape is a template property, not a lane one:
                // whether the thread is the content, threaded, and what a reply is
                // called. The id is the whole of what it needs.
                template={template?.template ?? undefined}
                commentsEnabled={commentsEnabled}
                reactionsEnabled={reactionsEnabled}
                readOnly={Boolean(publicSlug)}
                onChanged={onChanged}
                startOpen={threadOpen}
                focusOnOpen={!detailSurface && threadOpen}
                ownsRadar={ownsRadarOf(template)}
                // `decisions` is set on exactly the open card (modal / deep link), never on a list row.
                poll={decisions}
                {...(publicSlug ? { publicSlug } : {})}
              />
            </div>
          ) : null}
        </div>

        {discussing ? (
          <Modal
            title={cardLabel(blip)}
            onClose={closeDiscussion}
            size={boardTemplate ? 'kanban' : 'md'}
            fill={boardTemplate}
          >
            <BlipCard
              blip={blip}
              readOnly={readOnly}
              onChanged={onChanged}
              {...(template ? { template } : {})}
              linkTags={linkTags}
              commentsEnabled={commentsEnabled}
              reactionsEnabled={reactionsEnabled}
              {...(publicSlug ? { publicSlug } : {})}
              threadOpen={commentsEnabled}
              decisions
              keepConversationWhileEditing={boardTemplate}
              {...(boardTemplate
                ? {
                    onDeleted: (id: string) => {
                      if (id === currentBlipId.current) closeDiscussion();
                      onDeleted?.(id);
                    },
                  }
                : {})}
            />
          </Modal>
        ) : null}

        {confirming ? (
          <ConfirmDialog
            title="Delete this blip?"
            confirmLabel="Delete blip"
            danger
            busy={busy}
            body={
              <>
                This removes the blip and anything attached to it. It cannot be undone.
                {blip.commentCount > 0 ? (
                  <>
                    {' '}
                    Its {blip.commentCount}{' '}
                    {blip.commentCount === 1 ? 'comment goes' : 'comments go'} with it.
                  </>
                ) : null}
              </>
            }
            onClose={() => setConfirming(false)}
            onConfirm={() => void remove()}
          />
        ) : null}
      </article>
    </SwipeRow>
  );
}

/**
 * Editing a blip in place.
 *
 * The same voice as the composer — one box, grow with the content, ⌘+Enter to
 * commit — because editing a thought should not feel more ceremonious than
 * having it. Tags follow the text unless they were set by hand, which is the
 * server's rule, so the footer previews what the edit is about to infer for
 * exactly the same reason the composer does.
 */
export function BlipEditor({
  blip,
  containEscape = false,
  onCancel,
  onSaved,
}: {
  blip: BlipDto;
  containEscape?: boolean;
  onCancel: () => void;
  onSaved: () => void;
}) {
  /*
    What was on screen when the editor opened, frozen at mount. The open card is refetched every
    15 s, so `blip` moves while you type; saving against it would send the newest revision and
    overwrite whoever wrote in between (an agent's update_blip) without a word.
  */
  const opened = (b: BlipDto) => ({
    revision: b.revision,
    body: b.email ? b.email.notes : b.body,
    title: b.title ?? '',
  });
  const base = useRef(opened(blip));
  const [body, setBody] = useState(base.current.body);
  const [title, setTitle] = useState(base.current.title);
  const [saving, setSaving] = useState(false);
  /** Set when the card changed under us: their version, shown beside the draft we keep. */
  const [theirs, setTheirs] = useState<BlipDto | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  // Height has to follow the content, so this re-runs on every keystroke. Note
  // what is deliberately NOT in here: see below.
  useEffect(() => {
    const node = textarea.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 520)}px`;
  }, [body]);

  // Opening the editor puts the caret at the end — you are almost always adding
  // to a thought rather than correcting its first word. This is a *mount*
  // concern and must stay in its own effect: sharing the autosize effect above
  // re-ran it on every keystroke, so typing anywhere but the end threw the caret
  // back to the end after each character. Once the box is open the caret belongs
  // to the person typing, and React keeps it where they put it.
  useEffect(() => {
    const node = textarea.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }, []);

  const dirty = body !== base.current.body || title !== base.current.title;

  // `seen` is their version when the person chose to save over it.
  const save = async (seen?: BlipDto) => {
    // An explicit overwrite always sends: `dirty` compares with what was opened, not with theirs.
    if (!dirty && !seen) {
      onCancel();
      return;
    }
    if (seen) base.current = opened(seen);
    setSaving(true);
    setTheirs(null);
    try {
      for (let tries = 0; ; tries++) {
        try {
          await api.blips.update(blip.id, {
            ...(blip.email ? { emailNotes: body } : { body }),
            title: title.trim(),
            expectedRevision: base.current.revision,
          });
          break;
        } catch (err) {
          const current = err instanceof ApiError && err.code === 'stale_revision' && err.current;
          if (!current || tries >= 2) throw err;
          const now = opened(current);
          if (now.body !== base.current.body || now.title !== base.current.title) {
            setTheirs(current); // the words changed: the person decides, the draft stays
            setSaving(false);
            return;
          }
          // Only metadata moved (a claim renewal, a lane move): same words, newer revision.
          base.current = { ...base.current, revision: current.revision };
        }
      }
      notify('Blip updated');
      onSaved();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not save that edit', 'error');
      setSaving(false);
    }
  };

  const inferred = blip.email ? [] : extractInlineTags(body);

  return (
    <div className="panel mt-2 overflow-hidden">
      {blip.email ? (
        <p className="note px-3.5 pt-3">
          Edit the label and your notes. The original email stays unchanged.
        </p>
      ) : null}
      <label className="sr-only" htmlFor={`title-${blip.id}`}>
        Title
      </label>
      <input
        id={`title-${blip.id}`}
        value={title}
        placeholder="Title — optional"
        className="w-full bg-transparent px-3.5 pt-3 text-[15.5px] font-semibold tracking-tight outline-none placeholder:font-normal placeholder:text-[color:var(--paper-faint)]"
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            if (containEscape) {
              event.preventDefault();
              event.stopPropagation();
            }
            onCancel();
          }
        }}
      />
      <label className="sr-only" htmlFor={`body-${blip.id}`}>
        {blip.email ? 'Notes on this email' : 'Blip text'}
      </label>
      <textarea
        id={`body-${blip.id}`}
        ref={textarea}
        value={body}
        maxLength={blip.email ? 10_000 : LIMITS.blipBody}
        placeholder={blip.email ? 'Add notes. The original email stays unchanged.' : undefined}
        className="blip-body w-full resize-none bg-transparent px-3.5 pt-2 pb-2 outline-none"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            void save();
          }
          if (event.key === 'Escape') {
            if (containEscape) {
              event.preventDefault();
              event.stopPropagation();
            }
            onCancel();
          }
        }}
      />
      {theirs ? (
        <div role="alert" className="conflict border-t border-[color:var(--line-soft)] px-3.5 py-2">
          <p className="instrument">
            Changed since you opened it
            {theirs.lastEditedBy?.name ? ` · by ${theirs.lastEditedBy.name}` : ''}
          </p>
          {opened(theirs).title ? (
            <p className="text-[15px] font-semibold">{opened(theirs).title}</p>
          ) : null}
          <p className="blip-body max-h-40 overflow-auto whitespace-pre-wrap">
            {opened(theirs).body}
          </p>
          <div className="mt-2 flex gap-2">
            <button
              className="btn btn-ghost"
              onClick={() => {
                base.current = opened(theirs);
                setBody(base.current.body);
                setTitle(base.current.title);
                setTheirs(null);
              }}
            >
              Use theirs
            </button>
            <button className="btn btn-accent" onClick={() => void save(theirs)}>
              Save mine over it
            </button>
          </div>
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-3 border-t border-[color:var(--line-soft)] px-3 py-2">
        <span className="instrument truncate">
          {inferred.length > 0 ? `tags · ${inferred.join(' · ')}` : 'esc to cancel'}
        </span>
        <div className="flex gap-2">
          <button className="btn btn-ghost" onClick={onCancel} disabled={saving}>
            <X className="h-4 w-4" />
            Cancel
          </button>
          <button
            className="btn btn-accent"
            onClick={() => void save()}
            disabled={saving || !dirty || theirs !== null}
          >
            <Check className="h-4 w-4" />
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/** The bit of a URL a person recognises. Falls back to the whole thing. */

/**
 * The line that makes a log a log.
 *
 * Both ends are rendered, because they answer different questions: on a live
 * entry, *what did this overturn*; on a settled one, *what replaced it, and
 * where do I go to read the current position*. Both titles are resolved
 * server-side — on a chronicle-ordered log the two ends sit in different lanes
 * by construction, so they are routinely on different pages and a lookup in the
 * loaded list would come up empty exactly when the link matters.
 *
 * Each is a link into the radar with the other end as the deep-link target, so
 * following a chain of supersessions is one click per hop — the same `?blip=`
 * parameter a notification uses, and the same scroll-and-ping behaviour.
 */
/** Who holds the card, and whether an agent has it claimed. A claim is display-only; the facet is declared, not branched on. */
function Holders({ blip, assignable }: { blip: BlipDto; assignable: boolean }) {
  if (!blip.assignee && !blip.claim && !assignable) return null;
  return (
    <div className="supersession">
      {blip.assignee ? <AssigneeChip holder={blip.assignee} /> : null}
      {assignable ? <AssignControl blip={blip} /> : null}
      {blip.claim ? (
        <span className="instrument">
          claimed by {blip.claim.name ?? 'someone'} until{' '}
          {new Date(blip.claim.until).toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
          })}
        </span>
      ) : null}
    </div>
  );
}

function Supersession({ blip }: { blip: BlipDto }) {
  if (!blip.supersedes && !blip.supersededBy) return null;
  return (
    <div className="supersession">
      {blip.supersedes ? (
        <Link
          className="instrument supersession-link"
          to="/radar/$radarId"
          params={{ radarId: blip.radarId }}
          search={{ blip: blip.supersedes }}
        >
          <Undo2 className="h-3 w-3" aria-hidden="true" />
          replaces {blip.supersedesTitle ?? 'an earlier entry'}
        </Link>
      ) : null}
      {blip.supersededBy ? (
        <Link
          className="instrument supersession-link is-replaced"
          to="/radar/$radarId"
          params={{ radarId: blip.radarId }}
          search={{ blip: blip.supersededBy.id }}
        >
          <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
          superseded by {blip.supersededBy.title ?? 'a later entry'}
        </Link>
      ) : null}
    </div>
  );
}

/**
 * How a pending preview is asked after: 1.5s, doubling to 30s, eight times —
 * about two and a quarter minutes in all. Fast while an unfurl is most likely
 * to land, and bounded, because a fetch the server has given up on must not
 * become a poll that never ends.
 */
const PREVIEW_POLL_MS = 1_500;
const PREVIEW_POLL_CEILING_MS = 30_000;
const PREVIEW_POLLS = 8;

function LinkPreview({ blip: listed, poll }: { blip: BlipDto; poll: boolean }) {
  /*
    The unfurl runs after the capture commits, so a new link arrives with no
    preview and `previewPending`. Asked after briefly, on this blip alone, until
    the server says it is done — found or not — rather than leaving an empty
    frame until something else happens to refetch the list. Bounded, because a
    fetch the server has given up on must not become a poll that never ends.
  */
  const fresh = useQuery({
    queryKey: ['blip-preview', listed.id],
    queryFn: () => api.blips.get(listed.id),
    enabled: poll && listed.previewPending === true,
    refetchInterval: (query) =>
      query.state.data && !query.state.data.blip.previewPending
        ? false
        : query.state.dataUpdateCount >= PREVIEW_POLLS
          ? false
          : Math.min(PREVIEW_POLL_MS * 2 ** query.state.dataUpdateCount, PREVIEW_POLL_CEILING_MS),
    /*
      Polling pauses in a hidden tab (TanStack's default, and right), and the
      app turns focus refetching off globally — so coming back to the tab asked
      nothing, and the preview that had landed meanwhile stayed hidden. While
      one is still pending, returning to the tab asks once more.
    */
    refetchOnWindowFocus: (query) =>
      !query.state.data || query.state.data.blip.previewPending === true ? 'always' : false,
  });
  const blip = listed.previewPending ? (fresh.data?.blip ?? listed) : listed;
  // Stops saying so when it stops asking: past the last poll it is not "coming".
  // `dataUpdatedAt` is read so this re-renders on every answer — an answer
  // identical to the last is structurally shared and would not otherwise.
  const answeredAt = fresh.dataUpdatedAt;
  const client = useQueryClient();
  const polls = answeredAt
    ? (client.getQueryState(['blip-preview', listed.id])?.dataUpdateCount ?? 0)
    : 0;
  const pending = poll && blip.previewPending === true && polls < PREVIEW_POLLS;
  const host = hostOf(blip.url ?? '');

  return (
    <a
      href={blip.url ?? '#'}
      target="_blank"
      rel="noreferrer noopener"
      className="mt-2 flex gap-3 overflow-hidden rounded-[10px] border border-[color:var(--line-soft)] transition-colors hover:border-[color:var(--accent-from)]"
      style={{ background: 'var(--ink-850)' }}
    >
      {blip.preview?.imageUrl ? (
        <img
          src={blip.preview.imageUrl}
          alt=""
          loading="lazy"
          className="h-[86px] w-[86px] shrink-0 object-cover"
        />
      ) : (
        <span className="flex h-[86px] w-[86px] shrink-0 items-center justify-center">
          <Link2 className="h-5 w-5 text-[color:var(--paper-faint)]" />
        </span>
      )}
      <span className="min-w-0 flex-1 py-2.5 pr-3">
        {/* Not a live region: every card on the page would be announced as its
            preview landed, which is noise about something nobody asked for. */}
        <span className="instrument block truncate">
          {blip.preview?.siteName ?? host}
          {pending ? ' · fetching preview…' : ''}
        </span>
        <span className="mt-0.5 block truncate text-[14px] font-medium">
          {blip.preview?.title ?? blip.url}
        </span>
        {blip.preview?.description ? (
          <span className="mt-0.5 line-clamp-2 block text-[12.5px] text-[color:var(--paper-dim)]">
            {blip.preview.description}
          </span>
        ) : null}
      </span>
    </a>
  );
}

/* -------------------------------- the list ------------------------------- */

export function BlipStream({
  blips,
  readOnly,
  loading,
  loadingMore,
  hasMore,
  onLoadMore,
  onChanged,
  emptyTitle,
  emptyHint,
  newestId,
  template,
  linkTags = true,
  commentsEnabled = true,
  reactionsEnabled = true,
  publicSlug,
  grid = false,
}: {
  /** A ruled list that becomes a card grid when the radar pane is wide (`.blip-grid`). */
  grid?: boolean;
  blips: BlipDto[];
  readOnly: boolean;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  onChanged: () => void;
  emptyTitle: string;
  emptyHint: string;
  newestId?: string | null;
  template?: TemplateSource;
  linkTags?: boolean;
  commentsEnabled?: boolean;
  reactionsEnabled?: boolean;
  publicSlug?: string;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  /*
    Held in refs so the observer outlives renders.

    Every caller passes `onLoadMore` inline, so depending on it recreated the
    observer on every render — and a new observer reports a sentinel that is
    already in view straight away. Mid-fetch that called `fetchNextPage` again,
    which by default cancels the request in flight and starts it over.
  */
  const loadMore = useRef(onLoadMore);
  loadMore.current = onLoadMore;
  const busy = useRef(loadingMore);
  busy.current = loadingMore;

  // Load the next page when the end of the list comes into view.
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!busy.current && entries.some((entry) => entry.isIntersecting)) loadMore.current();
      },
      { rootMargin: '400px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
    // Re-observed when a page lands, so a sentinel still in view (a short page
    // on a tall screen) asks for the next one instead of stopping there.
  }, [hasMore, loadingMore]);

  if (loading && blips.length === 0) return <Spinner label="Reading the radar" />;
  if (blips.length === 0) return <Empty title={emptyTitle} hint={emptyHint} />;

  return (
    <div className={grid ? 'blip-grid' : 'divide-y divide-[color:var(--line-soft)]'}>
      {blips.map((blip) => (
        <BlipCard
          key={blip.id}
          blip={blip}
          readOnly={readOnly}
          isNew={blip.id === newestId}
          onChanged={onChanged}
          // The stream, the reading list and the drop box are all this list, and
          // all three are places you triage rather than read once. See
          // `components/swipe.tsx` for why the board is not.
          swipe
          {...(template ? { template } : {})}
          linkTags={linkTags}
          commentsEnabled={commentsEnabled}
          reactionsEnabled={reactionsEnabled}
          {...(publicSlug ? { publicSlug } : {})}
        />
      ))}
      <div ref={sentinel} className="blip-grid-end h-1" />
      {loadingMore ? (
        <div className="blip-grid-end">
          <Spinner label="More" />
        </div>
      ) : null}
    </div>
  );
}

/** Native popovers escape swipe clipping and supply light dismissal and Escape. */
function PostActions({
  state,
  busy,
  onChange,
}: {
  state: BlipState;
  busy: boolean;
  onChange: (state: BlipState) => void;
}) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  return (
    <>
      <button
        type="button"
        className="btn btn-ghost p-1.5"
        aria-label="Post actions"
        title="Post actions"
        popoverTarget={id}
        onClick={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          if (panel.current) {
            panel.current.style.left = `${Math.max(8, Math.min(bounds.right - 220, window.innerWidth - 228))}px`;
            panel.current.style.top = `${Math.max(8, Math.min(bounds.bottom + 6, window.innerHeight - 160))}px`;
          }
        }}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      <div
        ref={panel}
        id={id}
        popover="auto"
        className="post-actions-popover"
        onToggle={(event) => {
          if (event.newState === 'open')
            panel.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus();
        }}
      >
        <label className="flex flex-col gap-2">
          <span className="instrument">Triage state</span>
          <Select
            className="field"
            value={state}
            disabled={busy}
            onValueChange={(value) => {
              onChange(value as BlipState);
              panel.current?.hidePopover();
            }}
            options={BLIP_STATES.map((state) => ({
              value: state,
              label: BLIP_STATE_LABELS[state],
            }))}
          />
        </label>
        <p className="note mt-2">Organize this post without changing its content.</p>
      </div>
    </>
  );
}
