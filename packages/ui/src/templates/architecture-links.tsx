/**
 * Linking the charter to the map.
 *
 * Select words in the charter (reading or editing) and tie them to a boundary or a contract. The
 * link is a stand-off anchor on the server: nothing enters the document. Here it is drawn as an
 * underline (the CSS Custom Highlight API on the reading view, decorations in the editor), a
 * popover on the passage says what it is linked to, and the Map and Matrix list the passages an
 * element is linked to, each with a way back to the words.
 *
 * `useCharterLinks` is the whole flow in one place so the radar view only has to hand it the
 * data and draw what it returns: the buttons for the selection toolbar, what takes the toolbar's
 * place (the picker, or re-anchoring), the popover, and the actions the lists use.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import type { ArchitectureDto, CharterLinkDto } from '@onmyradar/contract';
import { notify } from '../components/primitives';
import { ApiError, api } from '../lib/api';
import { anchorMap } from '../lib/charter-spans';
import { SeeInVersion } from './architecture-history';
import { linksAt, placeLinks } from '../lib/charter-links';
import type { CharterEditing } from './architecture-charter';
import { around, ADR_SIZE, type LinkSelection } from './architecture-link-selection';
import {
  LinkPicker,
  linkProblem,
  type LinkElement,
  type LinkKind,
} from './architecture-link-picker';
import type { Selected } from './architecture-selection';
import './architecture-links.css';

/* ------------------------------- the lists' side ------------------------------- */

/** An anchor that lost its words, and is waiting to be pointed at new ones. */
export interface ReanchorTarget {
  anchorId: string;
  kind: 'amend' | 'link';
  /** What the banner calls it: "ADR-0031", "M6 Credentials". */
  label: string;
}

export interface LinkActions {
  canWrite: boolean;
  /** Given to members: an orphan then links to the version that last had its words. */
  historyRadarId?: string | undefined;
  /** Scroll the charter to a link's passage and flash it. */
  show: (linkId: string) => void;
  /** Start re-anchoring: the charter opens, and the next passage selected is the anchor's new place. */
  reanchor: (target: ReanchorTarget) => void;
  /** The anchor being re-anchored now (its card says to select the passage); null when none is. */
  reanchoring: string | null;
  cancelReanchor: () => void;
  /** Let an orphaned amendment go, or unlink a link. */
  dismiss: (target: ReanchorTarget) => void;
  /** Unlink an anchored passage (undoable). */
  unlink: (link: CharterLinkDto) => void;
}

const LinkActionsContext = createContext<LinkActions | null>(null);
export const LinkActionsProvider = LinkActionsContext.Provider;
export const useLinkActions = () => useContext(LinkActionsContext);

/**
 * The charter passages linked to one boundary or contract, quoted and short. An orphan (its words
 * were removed) is muted and offers the ways out: point it at new words, unlink it, or see it in
 * the last version that had it.
 */
export function LinkedSections({ data, id }: { data: ArchitectureDto; id: string }) {
  const actions = useLinkActions();
  const element =
    data.boundaries.find((b) => b.id === id) ?? data.contracts.find((c) => c.id === id);
  const links = (data.links ?? []).filter((l) => element?.charter?.links.includes(l.id));
  return (
    <section className="linked-sections" aria-label="Linked charter text">
      <h4 className="instrument">
        Linked charter text{links.length > 0 ? ` · ${links.length}` : ''}
      </h4>
      {links.length === 0 ? (
        <p className="note">
          Nothing in the charter is linked to this yet.
          {actions?.canWrite ? ' Select text in the charter and choose Link.' : ''}
        </p>
      ) : null}
      {links.map((link) =>
        link.state === 'orphaned' ? (
          <div key={link.id} className="linked-section is-orphan">
            <span className="chip-status is-orphan">Text removed from charter</span>
            <blockquote>{link.excerpt}</blockquote>
            <div className="linked-section-actions">
              {actions?.canWrite ? (
                <>
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      actions.reanchor({
                        anchorId: link.id,
                        kind: 'link',
                        label: link.element.title,
                      })
                    }
                  >
                    Re-anchor
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() =>
                      actions.dismiss({
                        anchorId: link.id,
                        kind: 'link',
                        label: link.element.title,
                      })
                    }
                  >
                    Unlink
                  </button>
                </>
              ) : null}
              {actions?.historyRadarId ? (
                <SeeInVersion
                  radarId={actions.historyRadarId}
                  version={link.resolvedVersion}
                  anchorId={link.id}
                />
              ) : null}
            </div>
          </div>
        ) : (
          <div key={link.id} className="linked-section">
            <blockquote>{link.excerpt}</blockquote>
            <div className="linked-section-actions">
              {link.section && link.section.length > 0 ? (
                <span className="linked-section-where">
                  {link.section[link.section.length - 1]}
                </span>
              ) : null}
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => actions?.show(link.id)}
              >
                Show in charter
              </button>
            </div>
          </div>
        ),
      )}
    </section>
  );
}

/* ----------------------------------- the popover ----------------------------------- */

interface Open {
  ids: string[];
  /** The line of the passage it hangs from, read again as the page scrolls. */
  rect: () => DOMRect | null;
  /** Opened by a click or tap (stays until dismissed) rather than a hover (leaves with the pointer). */
  pinned: boolean;
  /** Take the keyboard (opened from "Show in charter"). */
  focus: boolean;
}

function PassagePopover({
  open,
  links,
  canWrite,
  onMap,
  onUnlink,
  onClose,
  onEnter,
  onLeave,
}: {
  open: Open;
  links: readonly CharterLinkDto[];
  canWrite: boolean;
  onMap: (elementId: string) => void;
  onUnlink: (link: CharterLinkDto) => void;
  onClose: () => void;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const node = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const measure = useCallback(() => {
    const box = node.current;
    const line = open.rect();
    // Gone from the screen with the scroll: it goes too.
    if (!box || !line || line.bottom < 0 || line.top > window.innerHeight) {
      onClose();
      return;
    }
    const { height, width } = box.getBoundingClientRect();
    const below = line.bottom + 6;
    const top =
      below + height > window.innerHeight - 8 ? Math.max(8, line.top - height - 6) : below;
    const left = Math.min(Math.max(8, line.left), window.innerWidth - width - 8);
    setPlace({ top: Math.round(top), left: Math.round(left) });
  }, [open, onClose]);
  useLayoutEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    document.addEventListener('scroll', measure, { capture: true, passive: true });
    return () => {
      window.removeEventListener('resize', measure);
      document.removeEventListener('scroll', measure, { capture: true });
    };
  }, [measure, links.length]);
  useEffect(() => {
    if (open.focus) node.current?.querySelector<HTMLElement>('button, a')?.focus();
  }, [open.focus]);
  useEffect(() => {
    const away = (event: PointerEvent) => {
      if (!open.pinned) return;
      const target = event.target;
      if (target instanceof Node && node.current?.contains(target)) return;
      onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', escape);
    };
  }, [open.pinned, onClose]);
  return (
    <div
      ref={node}
      className="passage-pop"
      role="group"
      aria-label="Linked passage"
      data-placed={place ? '' : undefined}
      style={place ? { top: place.top, left: place.left } : undefined}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
    >
      {links.map((link) => (
        <div key={link.id} className="passage-pop-row">
          <span className={`passage-pop-kind is-${link.element.kind}`} aria-hidden="true">
            {link.element.kind === 'boundary' ? 'B' : 'C'}
          </span>
          <span className="passage-pop-name">
            <span className="instrument">Linked to {link.element.kind}</span>
            <strong>{link.element.title}</strong>
          </span>
          <button type="button" className="btn btn-ghost" onClick={() => onMap(link.element.id)}>
            Open in Map
          </button>
          {canWrite ? (
            <button type="button" className="btn btn-ghost" onClick={() => onUnlink(link)}>
              Unlink
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------- the flow ------------------------------------- */

const EMPTY: ReadonlyMap<string, Range> = new Map();
const FLASH_MS = 1700;
const HOVER_MS = 140;
const LEAVE_MS = 260;

const supportsHighlights = () =>
  typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

/** Paints `ranges` under a highlight name until the effect is cleaned up. */
function useHighlight(name: string, ranges: readonly Range[]) {
  useEffect(() => {
    if (!supportsHighlights() || ranges.length === 0) return;
    CSS.highlights.set(name, new Highlight(...ranges));
    return () => void CSS.highlights.delete(name);
  }, [name, ranges]);
}

/** What the picker is open on: the selection as it was when the button was pressed. */
interface Picking {
  kind: LinkKind;
  selected: Selected;
  link: LinkSelection;
  prefix?: string | undefined;
  suffix?: string | undefined;
}

const newKey = () => globalThis.crypto.randomUUID();

export interface CharterLinks {
  /** The Link buttons for the selection toolbar; nothing for a reader who cannot write. */
  buttons: ReactNode;
  /** What stands in for the toolbar's buttons: the picker, or the re-anchor button. */
  takeover: ReactNode;
  /** The selection the picker was opened on: the toolbar stays there while the field has the focus. */
  frozen: Selected | null;
  /** Re-anchoring is on: the banner says so. */
  banner: ReactNode;
  /** The popover on a linked passage. */
  layer: ReactNode;
  actions: LinkActions;
}

export function useCharterLinks(o: {
  radarId: string;
  data: ArchitectureDto | undefined;
  canWrite: boolean;
  editing: CharterEditing;
  /** The reading view's container, and what to redraw the underlines on when its HTML changes. */
  pages: RefObject<HTMLElement | null>;
  renderKey: unknown;
  /** The Charter tab is the one showing. */
  onCharter: boolean;
  selected: Selected | null;
  /** The charter is shown As written (what a link to replaced text needs). */
  written: boolean;
  toCharter: () => void;
  toMap: (elementId: string) => void;
  onChanged: () => void;
  /** The radar's id when the viewer can read its history (members); orphans then offer "See it in version N". */
  historyRadarId?: string | undefined;
}): CharterLinks {
  const { radarId, data, canWrite, editing, pages, onCharter, selected, onChanged } = o;
  const historyRadarId = o.historyRadarId;
  // The view hands over fresh closures every render; what runs later reads the latest.
  const live = useRef(o);
  live.current = o;
  const [picking, setPicking] = useState<Picking | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<ReanchorTarget | null>(null);
  const [reveal, setReveal] = useState<string | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const [ranges, setRanges] = useState<ReadonlyMap<string, Range>>(EMPTY);
  const timers = useRef<{ hover?: number; leave?: number; flash?: number }>({});

  const links = data?.links;
  const byId = useMemo(() => new Map((links ?? []).map((l) => [l.id, l])), [links]);
  const source = data?.charter[0]?.markdown;
  /** The charter's own words, which each link's offsets were measured on. */
  const text = useMemo(() => (source ? anchorMap(source).text : ''), [source]);
  const reading = onCharter && !editing.active;

  /* ---- the underlines on the reading view ---- */
  useLayoutEffect(() => {
    const root = pages.current?.querySelector<HTMLElement>('[data-page-id]');
    const placed = (links ?? []).flatMap((l) =>
      l.state === 'anchored' && l.start !== undefined && l.end !== undefined
        ? [{ id: l.id, start: l.start, end: l.end }]
        : [],
    );
    setRanges(reading && root && placed.length > 0 ? placeLinks(root, text, placed) : EMPTY);
    // The reading view is redrawn from `renderKey`; a range from before it points at nothing.
  }, [reading, links, text, pages, o.renderKey]);
  const drawn = useMemo(() => {
    const kinds: Record<LinkKind, Range[]> = { boundary: [], contract: [] };
    for (const [id, range] of ranges) {
      const kind = byId.get(id)?.element.kind;
      if (kind) kinds[kind].push(range);
    }
    return kinds;
  }, [ranges, byId]);
  useHighlight('charter-link-boundary', drawn.boundary);
  useHighlight('charter-link-contract', drawn.contract);
  const chosen = useMemo(() => (picking ? [picking.link.range] : []), [picking]);
  useHighlight('link-selection', chosen);

  /* ---- the popover: hover on the reading view, a click on either ---- */
  const clearTimers = () => {
    window.clearTimeout(timers.current.hover);
    window.clearTimeout(timers.current.leave);
  };
  const close = useCallback(() => {
    clearTimers();
    setOpen(null);
  }, []);
  useEffect(
    () => () => {
      clearTimers();
      window.clearTimeout(timers.current.flash);
    },
    [],
  );
  useEffect(() => {
    if (!onCharter || !data) return;
    const root = editing.active
      ? document.querySelector<HTMLElement>('.charter-edit')
      : pages.current;
    if (!root) return;
    const idsOf = (element: Element | null): string[] =>
      (element?.closest('.charter-link')?.getAttribute('data-links') ?? '')
        .split(' ')
        .filter(Boolean);
    const at = (
      event: PointerEvent | MouseEvent,
    ): { ids: string[]; rect: () => DOMRect | null } | null => {
      if (editing.active) {
        const found =
          event.target instanceof Element ? event.target.closest('.charter-link') : null;
        const ids = idsOf(found);
        return found && ids.length > 0 ? { ids, rect: () => found.getBoundingClientRect() } : null;
      }
      const hit = linksAt(ranges, event.clientX, event.clientY);
      if (!hit) return null;
      // The line is read again on scroll from the first range it belongs to.
      const range = ranges.get(hit.ids[0] as string);
      const line = Math.max(
        0,
        Array.from(range?.getClientRects() ?? []).findIndex(
          (r) => r.left === hit.rect.left && r.top === hit.rect.top,
        ),
      );
      return { ids: hit.ids, rect: () => range?.getClientRects()[line] ?? null };
    };
    let frame = 0;
    const move = (event: PointerEvent) => {
      if (editing.active || event.pointerType !== 'mouse') return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const hit = at(event);
        window.clearTimeout(timers.current.hover);
        if (hit) {
          window.clearTimeout(timers.current.leave);
          timers.current.hover = window.setTimeout(
            () => setOpen((now) => (now?.pinned ? now : { ...hit, pinned: false, focus: false })),
            HOVER_MS,
          );
        } else {
          window.clearTimeout(timers.current.leave);
          timers.current.leave = window.setTimeout(
            () => setOpen((now) => (now && !now.pinned ? null : now)),
            LEAVE_MS,
          );
        }
      });
    };
    const click = (event: MouseEvent) => {
      // A selection is the reader choosing words, not asking about a passage.
      if (!window.getSelection()?.isCollapsed) return;
      const hit = at(event);
      if (hit) setOpen({ ...hit, pinned: true, focus: false });
    };
    root.addEventListener('pointermove', move);
    root.addEventListener('click', click);
    return () => {
      cancelAnimationFrame(frame);
      root.removeEventListener('pointermove', move);
      root.removeEventListener('click', click);
    };
  }, [onCharter, data, editing.active, ranges, pages]);
  // Leaving the Charter takes the popover with it.
  useEffect(() => {
    if (!onCharter) close();
  }, [onCharter, close]);

  /* ---- Show in charter ---- */
  const show = useCallback((linkId: string) => {
    live.current.toCharter();
    setReveal(linkId);
  }, []);
  useEffect(() => {
    if (!reveal || !onCharter) return;
    const flash = (element: Element, range?: Range) => {
      element.scrollIntoView({ block: 'center' });
      if (range && supportsHighlights()) {
        CSS.highlights.set('charter-flash', new Highlight(range));
        window.clearTimeout(timers.current.flash);
        timers.current.flash = window.setTimeout(
          () => CSS.highlights.delete('charter-flash'),
          FLASH_MS,
        );
      } else {
        element.classList.add('is-flash');
        window.setTimeout(() => element.classList.remove('is-flash'), FLASH_MS);
      }
      const line = () => {
        const box = range ? (range.getClientRects()[0] ?? null) : element.getBoundingClientRect();
        return box ?? null;
      };
      setOpen({ ids: [reveal], rect: line, pinned: true, focus: true });
      setReveal(null);
    };
    const range = ranges.get(reveal);
    if (range) {
      const holder =
        range.startContainer instanceof Element
          ? range.startContainer
          : range.startContainer.parentElement;
      if (holder) {
        flash(holder, range);
        return;
      }
    }
    const mark = editing.active
      ? document.querySelector(`.charter-edit .charter-link[data-links~="${CSS.escape(reveal)}"]`)
      : null;
    if (mark) {
      flash(mark);
      return;
    }
    // The page may not be drawn yet (the tab was just switched to); give it a moment, then say so.
    const giveUp = window.setTimeout(() => {
      notify("Couldn't find that passage in the charter.", 'error');
      setReveal(null);
    }, 2500);
    return () => window.clearTimeout(giveUp);
  }, [reveal, onCharter, ranges, editing.active]);

  /* ---- making sure the server has what the person sees ---- */
  const settle = useCallback(async (): Promise<string | null> => {
    if (!editing.active) return null;
    await editing.saveRestored();
    return editing.hasUnsaved()
      ? 'The charter is not saved yet, so this could land on the wrong words. Let it save, then try again.'
      : null;
  }, [editing]);

  /* ---- linking ---- */
  const cancelPicking = useCallback(() => {
    setPicking((now) => {
      // Esc gives the selection back.
      if (now) {
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(now.link.range);
      }
      return null;
    });
    setProblem(null);
  }, []);
  const pick = async (element: LinkElement) => {
    if (!picking || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const blocked = await settle();
      if (blocked) {
        setProblem(blocked);
        return;
      }
      const made = await api.radars.linkCharter(radarId, {
        quote: picking.link.quote,
        ...(picking.prefix ? { prefix: picking.prefix } : {}),
        ...(picking.suffix ? { suffix: picking.suffix } : {}),
        element,
        idempotencyKey: newKey(),
      });
      setPicking(null);
      window.getSelection()?.removeAllRanges();
      onChanged();
      notify(`Linked to ${made.element.title}`, 'ok', {
        label: 'Undo',
        run: () => {
          // A link made with its boundary takes the boundary back: it was made for this.
          void api.anchors
            .dismiss(made.link.id, { idempotencyKey: newKey() })
            .then(() => (made.element.created ? api.blips.remove(made.element.id) : undefined))
            .then(
              () => {
                onChanged();
                notify('Link undone.');
              },
              (error: unknown) => notify(linkProblem(error), 'error'),
            );
        },
      });
    } catch (error) {
      setProblem(linkProblem(error));
    } finally {
      setBusy(false);
    }
  };
  const start = (kind: LinkKind) => {
    const link = selected?.link;
    if (!selected || !link || link.refusal) return;
    setProblem(null);
    setPicking({ kind, selected, link, ...around(link) });
  };
  // Esc from anywhere ends the picker (the field handles it when it has the focus).
  useEffect(() => {
    if (!picking) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancelPicking();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [picking, cancelPicking]);
  // The toolbar stays against the words while the page scrolls under it.
  useEffect(() => {
    if (!picking) return;
    let frame = 0;
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const box = picking.link.range.getBoundingClientRect();
        setPicking((now) =>
          now
            ? { ...now, selected: { ...now.selected, x: box.left, y: box.top, bottom: box.bottom } }
            : now,
        );
      });
    };
    document.addEventListener('scroll', follow, { capture: true, passive: true });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('scroll', follow, { capture: true });
    };
  }, [picking?.link.range]); // eslint-disable-line react-hooks/exhaustive-deps -- only the range matters
  // A click out in the page, away from the picker, is a cancel too.
  useEffect(() => {
    if (!picking) return;
    const away = (event: PointerEvent) => {
      const inside = event.target instanceof Element && event.target.closest('.amend-bar');
      if (!inside) cancelPicking();
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [picking, cancelPicking]);
  useEffect(() => {
    if (!onCharter) setPicking(null);
  }, [onCharter]);

  /* ---- re-anchoring and unlinking ---- */
  const reanchor = useCallback((next: ReanchorTarget) => {
    live.current.toCharter();
    setTarget(next);
    setProblem(null);
    setPicking(null);
    window.getSelection()?.removeAllRanges();
  }, []);
  /* Re-anchoring starts at the banner that says so, not wherever the charter was last scrolled. */
  const reanchoring = target !== null;
  useEffect(() => {
    if (!reanchoring || !onCharter) return;
    const frame = requestAnimationFrame(() => {
      const banner = document.querySelector('.reanchor-banner');
      // jsdom has no layout, and so no scrollIntoView.
      if (banner && 'scrollIntoView' in banner) banner.scrollIntoView({ block: 'center' });
    });
    return () => cancelAnimationFrame(frame);
  }, [reanchoring, onCharter]);
  const cancelReanchor = useCallback(() => {
    setTarget(null);
    setProblem(null);
  }, []);
  useEffect(() => {
    if (!target) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancelReanchor();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [target, cancelReanchor]);
  const reanchorHere = async () => {
    const link = selected?.link;
    if (!target || !link || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const blocked = await settle();
      if (blocked) {
        setProblem(blocked);
        return;
      }
      const result = await api.anchors.reanchor(target.anchorId, {
        quote: link.quote,
        ...around(link),
        idempotencyKey: newKey(),
      });
      window.getSelection()?.removeAllRanges();
      setTarget(null);
      onChanged();
      notify(`${result.subject.label} is anchored to the new text.`);
      if (target.kind === 'link') setReveal(target.anchorId);
    } catch (error) {
      setProblem(linkProblem(error));
    } finally {
      setBusy(false);
    }
  };
  const dismiss = useCallback(
    async (item: ReanchorTarget) => {
      try {
        await api.anchors.dismiss(item.anchorId, { idempotencyKey: newKey() });
        onChanged();
        notify(
          item.kind === 'link'
            ? `Unlinked from ${item.label}.`
            : `${item.label} no longer points at any text.`,
        );
      } catch (error) {
        notify(
          error instanceof ApiError ? error.message : 'Could not do that. Try again.',
          'error',
        );
      }
    },
    [onChanged],
  );
  const unlink = useCallback(
    async (link: CharterLinkDto) => {
      close();
      try {
        await api.anchors.dismiss(link.id, { idempotencyKey: newKey() });
        onChanged();
        const quote =
          link.start !== undefined && link.end !== undefined
            ? text.slice(link.start, link.end)
            : '';
        notify(`Unlinked from ${link.element.title}.`, 'ok', {
          label: 'Undo',
          run: () => {
            if (!quote) return;
            void api.radars
              .linkCharter(radarId, {
                quote,
                prefix: text.slice(Math.max(0, (link.start ?? 0) - 64), link.start),
                suffix: text.slice(link.end, (link.end ?? 0) + 64),
                element: link.element.id,
                idempotencyKey: newKey(),
              })
              .then(
                () => {
                  onChanged();
                  notify(`Linked to ${link.element.title} again.`);
                },
                (error: unknown) => notify(linkProblem(error), 'error'),
              );
          },
        });
      } catch (error) {
        notify(
          error instanceof ApiError ? error.message : 'Could not unlink that. Try again.',
          'error',
        );
      }
    },
    [close, onChanged, radarId, text],
  );

  const actions = useMemo<LinkActions>(
    () => ({
      canWrite,
      historyRadarId,
      show,
      reanchor,
      reanchoring: target?.anchorId ?? null,
      cancelReanchor,
      dismiss: (item) => void dismiss(item),
      unlink: (link) => void unlink(link),
    }),
    [canWrite, historyRadarId, show, reanchor, target, cancelReanchor, dismiss, unlink],
  );

  /* ---- what the view draws ---- */
  const link = selected?.link;
  const unavailable = !link || Boolean(link.refusal);
  const buttons = canWrite ? (
    <>
      <span className="amend-bar-divider" aria-hidden="true" />
      <button
        type="button"
        className="btn"
        disabled={unavailable}
        onClick={() => start('boundary')}
      >
        Link to boundary…
      </button>
      <button
        type="button"
        className="btn"
        disabled={unavailable}
        onClick={() => start('contract')}
      >
        Link to contract…
      </button>
    </>
  ) : null;

  let takeover: ReactNode = null;
  if (picking && data) {
    takeover = (
      <LinkPicker
        kind={picking.kind}
        data={data}
        busy={busy}
        problem={problem}
        onPick={(element) => void pick(element)}
        onCancel={cancelPicking}
      />
    );
  } else if (target && link) {
    const tooBig =
      target.kind === 'amend' && (link.quote.includes('\n\n') || link.quote.length > 400);
    const why = link.refusal ?? (tooBig ? ADR_SIZE : null) ?? problem;
    takeover = (
      <>
        <div className="amend-bar-actions">
          <button
            type="button"
            className="btn btn-accent"
            disabled={Boolean(link.refusal) || tooBig || busy}
            onClick={() => void reanchorHere()}
          >
            Re-anchor here
          </button>
          <button type="button" className="btn btn-ghost" onClick={cancelReanchor}>
            Cancel
          </button>
        </div>
        {why ? (
          <p className="amend-bar-note" role="alert">
            {why}
          </p>
        ) : null}
      </>
    );
  }

  const banner = target ? (
    <div className="charter-alert is-note reanchor-banner" role="status">
      <p>
        <strong>Re-anchoring {target.label}.</strong> Select the passage that now says this.
      </p>
      <div className="charter-alert-actions">
        <button type="button" className="btn btn-ghost" onClick={cancelReanchor}>
          Cancel
        </button>
      </div>
    </div>
  ) : null;

  const here = open ? open.ids.flatMap((id) => byId.get(id) ?? []) : [];
  const layer =
    open && here.length > 0 ? (
      <PassagePopover
        open={open}
        links={here}
        canWrite={canWrite}
        onMap={(id) => {
          close();
          live.current.toMap(id);
        }}
        onUnlink={(l) => void unlink(l)}
        onClose={close}
        onEnter={() => window.clearTimeout(timers.current.leave)}
        onLeave={() => {
          if (open.pinned) return;
          window.clearTimeout(timers.current.leave);
          timers.current.leave = window.setTimeout(close, LEAVE_MS);
        }}
      />
    ) : null;

  return { buttons, takeover, frozen: picking?.selected ?? null, banner, layer, actions };
}
