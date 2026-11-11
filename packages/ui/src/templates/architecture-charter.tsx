/**
 * The charter, edited where it is read.
 *
 * One document. "Edit charter" turns the page into Milkdown at the same width, and what is typed is
 * saved on its own (`CharterSaver`: one write in flight, the latest text behind it). Amendments are
 * drawn over the text as underlines and never written into it; a save that takes the words from
 * under one comes back with what it orphaned, and the toast says so with an Undo that puts the
 * previous text back, which heals them.
 *
 * Conflicts are whole-document. The server has one save, a full replace based on a revision, so
 * when somebody else saved first nothing is merged: the editor keeps what was typed, stops saving,
 * and offers the latest or a copy of the person's own.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useBlocker } from '@tanstack/react-router';
import { projectMarkdown } from '@onmyradar/contract';
import type { ArchitectureDto, WriteCharterResult } from '@onmyradar/contract';
import { MarkdownEditor, type MarkdownEditorApi } from '../components/markdown-editor';
import { ConfirmDialog, notify } from '../components/primitives';
import { ApiError, api } from '../lib/api';
import { anchorMap } from '../lib/charter-spans';
import { readDraft, writeDraft } from '../lib/drafts';
import { useSession } from '../lib/session';
import { CharterSaver, type SaveSnapshot, type SavedWrite } from '../lib/charter-save';
import type { AnchorDraw } from '../lib/milkdown';

interface Session {
  /** What the editor opened on. It is never replaced under a typing person: a new `key` remounts. */
  start: { markdown: string; revision: number };
  key: number;
}

const IDLE: SaveSnapshot = { state: 'saved', savedAt: null, message: null, headRevision: null };

/** "ADR-0029", "ADR-0029 and ADR-0031", "ADR-0029, ADR-0031 and 2 more". */
const nameThem = (names: readonly string[]): string =>
  names.length <= 2
    ? names.join(' and ')
    : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;

/** What a save did to the amendments, in the toast's words; null when it did nothing worth saying. */
export function savedMessage(result: WriteCharterResult): string | null {
  if (result.orphaned.length > 0)
    return `Saved. This orphaned ${nameThem(result.orphaned.map((o) => o.subject.label))}.`;
  if (result.healed.length > 0)
    return `Saved. ${nameThem(result.healed.map((o) => o.subject.label))} anchored again.`;
  return null;
}

/** An unsaved text kept in this browser, with the revision it was typed on, for one person. */
interface Draft {
  markdown: string;
  baseRevision: number;
  userId: string;
}
/** Keyed by person and radar: what one account left behind is never read by the next. */
const draftKey = (userId: string, radarId: string) => `charter-draft:${userId}:${radarId}`;
/** The person's own text, set aside when they chose the latest over it. */
const keptKey = (userId: string, radarId: string) => `charter-mine:${userId}:${radarId}`;

function readSaved(key: string, userId: string): Draft | null {
  try {
    const raw = readDraft(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Draft>;
    // Whatever the key says, a text written for somebody else is not this person's.
    return typeof parsed.markdown === 'string' &&
      typeof parsed.baseRevision === 'number' &&
      parsed.userId === userId
      ? { markdown: parsed.markdown, baseRevision: parsed.baseRevision, userId }
      : null;
  } catch {
    return null;
  }
}

export interface CharterEditing {
  /** The editor is open. */
  active: boolean;
  starting: boolean;
  /** A draft kept in this browser is being brought back: loading, or the charter could not be read. */
  restoring: 'idle' | 'loading' | 'failed';
  retryRestore: () => void;
  /** The final save is running: the document is held still until it is done. */
  finishing: boolean;
  session: Session | null;
  snap: SaveSnapshot;
  /** The text as last typed, a moment behind the keys: what the outline is built from. */
  live: string;
  /** An unsaved draft from before the person left came back: Save or Discard it. */
  restored: boolean;
  /** The person's own text, set aside when they reloaded the latest; null when there is none. */
  kept: string | null;
  start: () => Promise<void>;
  /** Writes what is typed, seals it and closes the editor; stays open (and says why) when it cannot. */
  done: () => Promise<boolean>;
  push: (markdown: string) => void;
  /** What was typed last (what the editor must open on when it is mounted again). */
  latest: () => string;
  /** Typed and not yet in the server's hands, read from the editor itself and not from its report. */
  hasUnsaved: () => boolean;
  retry: () => void;
  /** The mounted editor, which can hand over what it has not reported yet. */
  editorApi: RefObject<MarkdownEditorApi | null>;
  reloadLatest: () => Promise<void>;
  copyMine: () => void;
  saveRestored: () => Promise<void>;
  discardRestored: () => void;
  copyKept: () => void;
  dismissKept: () => void;
}

/**
 * The editing session of a radar's charter. It lives in the radar view, not in the editor, so a
 * tab switch or a layout change that unmounts the editor takes neither the text nor the queue.
 * `onWritten` runs after each acknowledged write, and when the editor closes.
 *
 * The editor reports what was typed after a short pause, which is for scheduling an autosave and
 * nothing else. Everything that decides what happens to the text (Done, Copy mine, Reload latest,
 * Undo, leaving) reads the editor itself, now, through `sync`.
 */
export function useCharterEditing(radarId: string, onWritten: (closed: boolean) => void) {
  const [session, setSession] = useState<Session | null>(null);
  const [snap, setSnap] = useState<SaveSnapshot>(IDLE);
  const [live, setLive] = useState('');
  const [starting, setStarting] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [restored, setRestored] = useState(false);
  const [kept, setKept] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<'idle' | 'loading' | 'failed'>('idle');
  const userId = useSession().user?.id ?? null;
  const dKey = userId ? draftKey(userId, radarId) : null;
  const kKey = userId ? keptKey(userId, radarId) : null;
  /**
   * A stored draft that has not been restored yet. Its copy in this browser is the only one, so
   * nothing may clear it until it is restored, saved or discarded.
   */
  const pending = useRef(false);
  const alive = useRef(true);
  const saver = useRef<CharterSaver | null>(null);
  const keys = useRef(0);
  const editorApi = useRef<MarkdownEditorApi | null>(null);
  const written = useRef(onWritten);
  written.current = onWritten;

  /** Keep what the server does not have in this browser, so no way of leaving takes it. */
  const keep = useCallback(() => {
    const current = saver.current;
    if (!current || !dKey || !userId || !current.dirty) return;
    writeDraft(
      dKey,
      JSON.stringify({ markdown: current.latest, baseRevision: current.baseRevision, userId }),
    );
  }, [dKey, userId]);
  /**
   * Let the stored copy go, because the server has the text. Only the end of a save, a close or a
   * discard does this; the editor opening or reporting never does.
   */
  const release = useCallback(() => {
    if (dKey && !pending.current) writeDraft(dKey, '');
  }, [dKey]);

  /**
   * What is in the editor right now, put into the queue. It asks the editor, not the report that
   * trails the keys, so a word typed a moment ago is in. Without an editor (another tab is up) the
   * queue already has everything: the editor handed it over as it went.
   */
  const sync = useCallback((): string => {
    const current = saver.current;
    if (!current) return '';
    const api = editorApi.current;
    if (api) {
      const typed = api.markdown();
      api.takePending();
      if (typed !== current.latest) {
        current.push(typed);
        setLive(typed);
      }
    }
    keep();
    return current.latest;
  }, [keep]);

  /** Open the editor on `start` again (undo, reload): a new key, so the editor is made afresh. */
  const reopen = useCallback((markdown: string) => {
    keys.current += 1;
    const key = keys.current;
    setSession({ start: { markdown, revision: saver.current?.baseRevision ?? 0 }, key });
    setLive(markdown);
  }, []);

  const undo = useCallback(
    (before: string, sent: string, revision: number) => {
      const typed = saver.current ? sync() : '';
      const current = saver.current;
      if (!current) {
        // The editor was closed after that save: put the text back with one write of its own.
        api.radars
          .writeCharter(radarId, { markdown: before, baseRevision: revision, checkpoint: true })
          .then(
            (result) => {
              written.current(false);
              notify(savedMessage(result) ?? 'Undone.');
            },
            (error: unknown) =>
              notify(
                error instanceof ApiError ? error.message : 'Could not undo that save.',
                'error',
              ),
          );
        return;
      }
      if (typed !== sent) {
        notify(
          'You have typed since that save, so Undo would lose it. Put the words back by hand.',
          'error',
        );
        return;
      }
      // The saved text goes back on the server and into the editor together: left in the
      // editor, the next autosave would take the words away again.
      reopen(before);
      current.push(before);
      keep();
      void current.flush();
    },
    [radarId, reopen, sync, keep],
  );

  const saved = useCallback(
    ({ result, sent, before }: SavedWrite) => {
      written.current(false);
      setRestored(false);
      const message = savedMessage(result);
      if (!message) return;
      if (result.orphaned.length > 0)
        notify(message, 'ok', { label: 'Undo', run: () => undo(before, sent, result.revision) });
      else notify(message);
    },
    [undo],
  );

  /** The charter as stored, with the revision it is at: the one read an edit starts from. */
  const head = useCallback(async () => {
    const read = await api.radars.architecture(radarId, undefined, 'written');
    return { markdown: read.charter[0]?.markdown ?? '', revision: read.revision ?? 0 };
  }, [radarId]);

  const open = useCallback(
    (start: { markdown: string; revision: number }, typed?: string) => {
      saver.current?.stop();
      const next = new CharterSaver(start, {
        write: (input) => api.radars.writeCharter(radarId, input),
        head,
        onChange: (snapshot) => {
          setSnap(snapshot);
          if (saver.current !== next) return;
          if (next.dirty) keep();
          else if (snapshot.state === 'saved') release();
        },
        onSaved: saved,
      });
      saver.current = next;
      setSnap(next.snapshot);
      keys.current += 1;
      // Opened on what was typed, when a draft is coming back: the editor never opens on less.
      const shown = typed ?? start.markdown;
      setSession({ start: { ...start, markdown: shown }, key: keys.current });
      setLive(shown);
      if (typed !== undefined) next.push(typed);
    },
    [radarId, saved, head, keep, release],
  );

  const start = useCallback(async () => {
    if (saver.current || starting || pending.current) return;
    setStarting(true);
    try {
      open(await head());
    } catch (error) {
      notify(error instanceof ApiError ? error.message : 'Could not open the charter.', 'error');
    } finally {
      setStarting(false);
    }
  }, [head, open, starting]);

  // Back on a radar with a draft that never reached the server: it is restored, with the revision
  // it was typed on, so a save from it is refused (not merged over somebody's) if the charter moved.
  // Until the charter can be read it stays where it is, and the editor does not open on anything
  // else: opening on the server's text would be the first step of losing it.
  const restore = useCallback(() => {
    if (!userId || !dKey) return;
    const draft = readSaved(dKey, userId);
    if (!draft) {
      pending.current = false;
      setRestoring('idle');
      return;
    }
    pending.current = true;
    setRestoring('loading');
    void head().then(
      (latest) => {
        if (!alive.current || saver.current) return;
        pending.current = false;
        setRestoring('idle');
        if (draft.markdown === latest.markdown) {
          writeDraft(dKey, '');
          return;
        }
        open({ markdown: latest.markdown, revision: draft.baseRevision }, draft.markdown);
        setRestored(true);
      },
      () => {
        if (alive.current) setRestoring('failed');
      },
    );
  }, [userId, dKey, head, open]);
  useEffect(() => {
    alive.current = true;
    restore();
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- as the radar is opened by a person
  }, [dKey]);
  useEffect(() => {
    setKept(userId && kKey ? (readSaved(kKey, userId)?.markdown ?? null) : null);
  }, [userId, kKey]);

  const close = useCallback(() => {
    saver.current?.stop();
    saver.current = null;
    pending.current = false;
    if (dKey) writeDraft(dKey, '');
    setSession(null);
    setSnap(IDLE);
    setRestored(false);
  }, [dKey]);

  const done = useCallback(async () => {
    const current = saver.current;
    if (!current) return true;
    setFinishing(true);
    try {
      // The document is held still while it is written; whatever got in anyway (a paste, an
      // input method) is compared with what was sent, and goes round again instead of closing.
      for (let round = 0; round < 5; round += 1) {
        sync();
        const sealed = await current.finish();
        if (sealed === null) break;
        if (sync() === sealed) {
          close();
          written.current(true);
          return true;
        }
      }
      notify('The charter is not saved yet, so the editor stays open. Your text is kept.', 'error');
      return false;
    } finally {
      setFinishing(false);
    }
  }, [sync, close]);

  const push = useCallback(
    (markdown: string) => {
      setLive(markdown);
      saver.current?.push(markdown);
      keep();
    },
    [keep],
  );

  const latest = useCallback(() => saver.current?.latest ?? '', []);
  const hasUnsaved = useCallback(() => {
    const current = saver.current;
    if (!current) return false;
    const typed = editorApi.current?.markdown();
    return (
      current.dirty ||
      current.snapshot.state !== 'saved' ||
      (typed !== undefined && typed !== current.latest)
    );
  }, []);
  const retry = useCallback(() => {
    sync();
    void saver.current?.retry();
  }, [sync]);

  /** Put the person's own text aside, where a reload cannot reach it, and say so. */
  const setAside = useCallback(
    (markdown: string, baseRevision: number) => {
      if (!kKey || !userId) return;
      writeDraft(kKey, JSON.stringify({ markdown, baseRevision, userId }));
      setKept(markdown);
    },
    [kKey, userId],
  );

  const copyText = useCallback((text: string, said: string) => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard) {
      notify('This browser would not copy. Select the text and copy it.', 'error');
      return;
    }
    void clipboard.writeText(text).then(
      () => notify(said),
      () => notify('This browser would not copy. Select the text and copy it.', 'error'),
    );
  }, []);

  const reloadLatest = useCallback(async () => {
    const current = saver.current;
    if (!current) return;
    try {
      const latest = await head();
      // Read as late as can be: what was typed while the latest was on its way is set aside too.
      const mine = sync();
      const unsent = mine !== current.server;
      if (unsent) setAside(mine, current.baseRevision);
      current.adopt(latest);
      reopen(latest.markdown);
      release();
      notify(
        unsent
          ? 'Loaded the latest charter. Your version is kept, and you can copy it.'
          : 'Loaded the latest charter.',
        'ok',
      );
    } catch (error) {
      notify(error instanceof ApiError ? error.message : 'Could not load the latest.', 'error');
    }
  }, [head, reopen, sync, release, setAside]);

  const copyMine = useCallback(() => copyText(sync(), 'Copied your version.'), [copyText, sync]);
  const copyKept = useCallback(
    () => copyText(kept ?? '', 'Copied your earlier version.'),
    [copyText, kept],
  );
  const dismissKept = useCallback(() => {
    if (kKey) writeDraft(kKey, '');
    setKept(null);
  }, [kKey]);

  const saveRestored = useCallback(async () => {
    sync();
    await saver.current?.flush();
  }, [sync]);
  const discardRestored = useCallback(() => {
    close();
  }, [close]);

  // Leaving with text the server has not got: the browser asks, and the text is kept and sent as
  // the page goes. (Moving inside the app is asked by `CharterLeaveGuard`.)
  const unsaved = session !== null && snap.state !== 'saved';
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      sync();
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved, sync]);
  useEffect(() => {
    const send = () => {
      sync();
      void saver.current?.flush();
    };
    const hidden = () => {
      if (document.visibilityState === 'hidden') send();
    };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', send);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', send);
    };
  }, [sync]);
  // Leaving the radar mid-edit: what is typed is kept in this browser and sent to the server, and
  // it is still there, with its banner, when the radar is opened again.
  useEffect(
    () => () => {
      const current = saver.current;
      if (!current) return;
      sync();
      void current.flush().finally(() => {
        if (current.dirty) keep();
        else release();
        current.stop();
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on leaving
    [],
  );

  return {
    active: session !== null,
    // Not while a stored draft waits to be restored: opening on the server's text would bury it.
    starting: starting || restoring !== 'idle',
    restoring,
    retryRestore: restore,
    finishing,
    session,
    snap,
    live,
    restored,
    kept,
    start,
    done,
    push,
    latest,
    hasUnsaved,
    retry,
    editorApi,
    reloadLatest,
    copyMine,
    saveRestored,
    discardRestored,
    copyKept,
    dismissKept,
  } satisfies CharterEditing;
}

/** Says that unsaved text from before is kept, while the charter it belongs to is read again. */
export function CharterDraftNotice({ editing }: { editing: CharterEditing }) {
  if (editing.restoring === 'idle') return null;
  return (
    <div className="charter-alert is-note" role="status">
      <p>
        <strong>Unsaved changes from earlier are kept in this browser.</strong>{' '}
        {editing.restoring === 'loading'
          ? 'Reading the charter to bring them back.'
          : 'The charter could not be read to bring them back. Editing is off until it can, so nothing replaces them.'}
      </p>
      {editing.restoring === 'failed' ? (
        <div className="charter-alert-actions">
          <button type="button" className="btn" onClick={editing.retryRestore}>
            Retry
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Asks before moving inside the app with text the server does not have. */
export function CharterLeaveGuard({ editing }: { editing: CharterEditing }) {
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      next.pathname !== current.pathname && editing.hasUnsaved(),
    enableBeforeUnload: () => editing.hasUnsaved(),
    withResolver: true,
  });
  if (blocker.status !== 'blocked') return null;
  return (
    <ConfirmDialog
      title="Leave with unsaved changes?"
      body="What you typed is not saved to the charter yet. It is kept in this browser and comes back, to save or discard, when you open this charter again."
      confirmLabel="Leave"
      danger
      onClose={() => blocker.reset()}
      onConfirm={() => blocker.proceed()}
    />
  );
}

/* ---------------------------------- the badge --------------------------------- */

const FRESH_MS = 30_000;

function useTick(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** "Saved just now", "Saving…", and what to do when it cannot. */
export function SaveBadge({ snap, onRetry }: { snap: SaveSnapshot; onRetry: () => void }) {
  const now = useTick(15_000);
  let text: string;
  let tone = 'is-ok';
  switch (snap.state) {
    case 'saved':
      text =
        snap.savedAt === null
          ? 'Saved'
          : now - snap.savedAt < FRESH_MS
            ? 'Saved just now'
            : `Saved ${Math.max(1, Math.round((now - snap.savedAt) / 60_000))} min ago`;
      break;
    case 'dirty':
    case 'saving':
      text = 'Saving…';
      tone = 'is-wait';
      break;
    case 'paused':
      text = 'Saving paused';
      tone = 'is-warn';
      break;
    case 'conflict':
      text = 'Changed elsewhere';
      tone = 'is-warn';
      break;
    default:
      text = 'Not saved';
      tone = 'is-warn';
  }
  return (
    <span className="charter-save">
      <span className={`chip-status ${tone}`} role="status" aria-live="polite">
        {text}
      </span>
      {snap.state === 'paused' ? (
        <button type="button" className="btn btn-ghost" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </span>
  );
}

/* ---------------------------------- the editor -------------------------------- */

/** The editor in the document's place, at the document's width. */
export function CharterEditor({
  editing,
  data,
}: {
  editing: CharterEditing;
  data: ArchitectureDto;
}) {
  const session = editing.session;
  // Opens on what was typed last, not on what the session started with: the editor is mounted
  // again by a tab switch, and `value` must not move under a typing person.
  const [opened] = useState(() => editing.latest());
  const source = data.charter[0]?.markdown;
  const adrs = data.adrs;
  const links = data.links;
  const draw = useMemo<AnchorDraw | null>(() => {
    if (!source) return null;
    const map = anchorMap(source);
    const label = new Map(adrs.map((a) => [a.id, a.label]));
    const linked = (links ?? []).flatMap((l) =>
      l.state === 'anchored' && l.start !== undefined && l.end !== undefined
        ? [{ start: l.start, end: l.end, labels: [], link: { ids: [l.id], kind: l.element.kind } }]
        : [],
    );
    return {
      text: map.text,
      spans: [
        ...map.spans.map((s) => ({
          start: s.start,
          end: s.end,
          labels: s.adrs.map((id) => label.get(id) ?? 'ADR'),
        })),
        ...linked,
      ],
    };
  }, [source, adrs, links]);
  if (!session) return null;
  const { snap } = editing;
  return (
    <div className="charter-edit">
      {editing.restored ? (
        <div className="charter-alert is-note" role="status">
          <p>
            <strong>Unsaved changes restored.</strong> They were typed before you left, and the
            charter has not been saved with them.
          </p>
          <div className="charter-alert-actions">
            <button
              type="button"
              className="btn btn-accent"
              disabled={editing.finishing}
              onClick={() => void editing.saveRestored()}
            >
              Save
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={editing.finishing}
              onClick={editing.discardRestored}
            >
              Discard
            </button>
          </div>
        </div>
      ) : null}
      {editing.kept !== null ? (
        <div className="charter-alert is-note" role="status">
          <p>
            <strong>Your version from before the reload is kept.</strong> It is not in the charter.
          </p>
          <div className="charter-alert-actions">
            <button type="button" className="btn" onClick={editing.copyKept}>
              Copy it
            </button>
            <button type="button" className="btn btn-ghost" onClick={editing.dismissKept}>
              Dismiss
            </button>
          </div>
        </div>
      ) : null}
      {snap.state === 'conflict' ? (
        <div className="charter-alert" role="alert">
          <p>
            <strong>The charter was changed elsewhere</strong> while you were editing. What you
            typed is still here, and it is not saved.
          </p>
          <div className="charter-alert-actions">
            <button type="button" className="btn" onClick={() => void editing.reloadLatest()}>
              Reload latest
            </button>
            <button type="button" className="btn btn-ghost" onClick={editing.copyMine}>
              Copy mine
            </button>
          </div>
        </div>
      ) : snap.state === 'refused' ? (
        <div className="charter-alert" role="alert">
          <p>
            <strong>The charter was not saved.</strong> {snap.message}
          </p>
        </div>
      ) : null}
      <MarkdownEditor
        key={session.key}
        variant="charter"
        label="Charter"
        value={opened}
        apiRef={editing.editorApi}
        onDirtyChange={noop}
        onTextChange={editing.push}
        anchors={draw}
        locked={editing.finishing}
        autoFocus
      />
    </div>
  );
}
const noop = () => undefined;

/* ------------------------------------ the rail ------------------------------------ */

export interface OutlineItem {
  text: string;
  depth: number;
}

/** The headings of a charter, in order, with how deep each is. */
export function outlineOf(markdown: string): OutlineItem[] {
  if (markdown.trim() === '') return [];
  const projection = projectMarkdown(markdown);
  const first = Math.min(
    ...projection.blocks.map((b) => (b.kind === 'heading' ? b.headingPath.length : 99)),
  );
  return projection.blocks.flatMap((block) =>
    block.kind === 'heading'
      ? [
          {
            text: projection.text.slice(block.start, block.end),
            depth: Math.max(0, block.headingPath.length - first),
          },
        ]
      : [],
  );
}

/** The charter's headings; each one scrolls the document to it. */
export function Outline({
  markdown,
  onJump,
}: {
  markdown: string;
  /** The index of the heading in the document, 0-based. */
  onJump: (index: number) => void;
}) {
  const items = useMemo(() => outlineOf(markdown), [markdown]);
  if (items.length === 0) return <p className="note">No headings yet.</p>;
  return (
    <nav aria-label="Outline">
      <ul className="charter-outline">
        {items.map((item, index) => (
          <li key={index} data-depth={Math.min(item.depth, 3)}>
            <button type="button" onClick={() => onJump(index)}>
              {item.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
