/**
 * The capture box.
 *
 * Capture has to be cheaper than the thought — anything that makes you stop and
 * choose is friction. So there is one field, it is focused on arrival, and
 * everything else (tags, kind, title, link preview) is inferred server-side from
 * what you typed. Files can be dropped or pasted straight in.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Paperclip, Send, X } from 'lucide-react';
import { extractInlineTags, extractMentions, firstUrl, LIMITS, soleUrl } from '@onmyradar/contract';
import type { BlipDto } from '@onmyradar/contract';
import { ApiError, api, uploadFile } from '../lib/api';
import { fileSize, hostOf } from '../lib/format';
import { MentionHint, useMentionCandidates } from './mention-input';
import { notify } from './primitives';
import { draftsPersist, useDraft } from '../lib/drafts';
import { useSession } from '../lib/session';
import { UnsentGuard } from './unsent-guard';

/** The bit of a URL a person recognises, for the capture footer. */

interface PendingFile {
  id: string;
  file: File;
  key?: string;
  /** Measured in the browser at upload time; absent for anything not an image. */
  width?: number;
  height?: number;
  error?: string;
}

/** Whether a drag carries files, as opposed to a link or some text. */
export function carriesFiles(transfer: DataTransfer | null): boolean {
  return Boolean(transfer && Array.from(transfer.types).includes('Files'));
}

/**
 * A field the person can type into. Focus on a link or a button — where
 * arriving by clicking a radar in the sidebar leaves it — is fine to move; focus
 * in a field means keystrokes are already going somewhere on purpose.
 */
export function isEditable(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true;
  if (!(element instanceof HTMLInputElement)) return false;
  return ![
    'button',
    'checkbox',
    'radio',
    'submit',
    'reset',
    'file',
    'range',
    'color',
    'image',
  ].includes(element.type);
}

export function Composer({
  radarId,
  onCaptured,
  storageEnabled = true,
  placeholder = 'Drop a blip…  #tag it, paste a link, or drag a file in',
  linkFirst = false,
}: {
  radarId: string;
  /** Handed the blip the server made, so the caller need not go looking for it. */
  onCaptured: (blip: BlipDto) => void;
  storageEnabled?: boolean;
  /** The radar template's own voice — a board says "add a card", a microblog asks what's happening. */
  placeholder?: string;
  /**
   * Whether this radar's template pulls a link out of a body that also carries
   * text (`capture.linkFirst`). Passed in rather than looked up, so the composer
   * stays a dumb box that is told what it is doing — but it has to *know*,
   * because the whole point of the footer is that nothing the server infers is a
   * surprise.
   */
  linkFirst?: boolean;
}) {
  // Kept per radar until sent: leaving the radar, or the tab, loses nothing.
  const [body, setBody] = useDraft(`radar:${radarId}`);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);

  // Grow with the content rather than scrolling inside a fixed box: a long
  // thought should not be typed through a letterbox.
  useEffect(() => {
    const node = textarea.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 420)}px`;
  }, [body]);

  // Switching radars should leave the caret ready in the new one — unless the
  // person is already typing somewhere else. This runs when the composer mounts,
  // which is when the radar's data arrives, and that can be mid-word: somebody
  // typing "Workflow" into the sidebar filter got "Workf" there and "low" here.
  useEffect(() => {
    setFiles([]);
    if (!window.matchMedia('(min-width: 768px)').matches) return;
    if (isEditable(document.activeElement)) return;
    textarea.current?.focus();
  }, [radarId]);

  const addFiles = useCallback(
    async (incoming: File[]) => {
      if (!storageEnabled) {
        notify('File storage is not configured on this server', 'error');
        return;
      }
      const accepted = incoming.slice(0, LIMITS.attachmentsPerBlip - files.length);
      const pending: PendingFile[] = accepted.map((file) => ({
        id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`,
        file,
      }));
      setFiles((current) => [...current, ...pending]);

      for (const entry of pending) {
        try {
          const uploaded = await uploadFile(radarId, entry.file);
          setFiles((current) =>
            current.map((f) =>
              f.id === entry.id
                ? {
                    ...f,
                    key: uploaded.key,
                    ...(uploaded.width ? { width: uploaded.width } : {}),
                    ...(uploaded.height ? { height: uploaded.height } : {}),
                  }
                : f,
            ),
          );
        } catch (err) {
          const message = err instanceof ApiError ? err.message : 'Upload failed';
          setFiles((current) =>
            current.map((f) => (f.id === entry.id ? { ...f, error: message } : f)),
          );
        }
      }
    },
    [files.length, radarId, storageEnabled],
  );

  const uploading = files.some((f) => !f.key && !f.error);
  const ready = (body.trim().length > 0 || files.some((f) => f.key)) && !uploading && !saving;

  const submit = useCallback(async () => {
    if (!ready) return;
    setSaving(true);
    try {
      const { blip } = await api.radars.createBlip(radarId, {
        body: body.trim(),
        attachments: files
          .filter((f) => f.key)
          .map((f) => ({
            key: f.key as string,
            filename: f.file.name,
            contentType: f.file.type || 'application/octet-stream',
            size: f.file.size,
            // Sent so the card can honour the picture's own shape instead of
            // cropping it to a fixed box.
            ...(f.width ? { width: f.width } : {}),
            ...(f.height ? { height: f.height } : {}),
          })),
      });
      setBody('');
      setFiles([]);
      onCaptured(blip);
      textarea.current?.focus();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not save that blip', 'error');
    } finally {
      setSaving(false);
    }
  }, [body, files, onCaptured, radarId, ready, setBody]);

  const inferredTags = extractInlineTags(body);

  /*
    Mentions in the capture box.

    The textarea itself is deliberately left alone — it carries the autosize, the
    paste and drop handlers, the caret repair and the visual-viewport fix, and
    threading a different component through it to gain an autocomplete would put
    all four at risk for a convenience. The *consequences* are still shown: who
    this will notify, and which handles name nobody. A discussion's replies are
    where addressing people actually happens, and the reply box does complete.
  */
  const candidates = useMentionCandidates(radarId);
  const me = useSession().user?.id ?? null;
  const mentioned = useMemo(() => {
    if (!body.includes('@')) return [];
    const typed = new Set(extractMentions(body));
    // Never yourself: the server does not notify the author about their own
    // mention, so listing them here would promise an interruption that never comes.
    return candidates.filter(
      (candidate) => candidate.key !== me && candidate.handles.some((handle) => typed.has(handle)),
    );
  }, [body, candidates, me]);
  const bareUrl = soleUrl(body);
  // Exactly the rule the server will apply, in the same order, from the same
  // helpers. Two copies of an inference rule eventually disagree, and the
  // symptom is a footer that promises one thing and a card that shows another.
  const link = bareUrl ?? (linkFirst ? firstUrl(body) : null);

  /*
    One line at rest.

    Measured, this box was ~150px of a 270px band of chrome standing between a
    radar's header and its first blip — 32% of a 900px viewport, worse on a
    768px laptop, and empty almost all of the time. Capture being the cheapest
    thing in the product is the thesis and this does not touch it: the caret
    still arrives here, ⌘↵ still captures, the paperclip is still on the row, and
    drop and paste are unchanged.

    Expansion is driven by **content**, not by focus. Focus was the obvious rule
    and it is the wrong one: the composer takes focus on arrival on a desktop, so
    a focus-driven box is expanded exactly as often as the old one was and saves
    nothing. Content-driven, it grows under your fingers as you type — which the
    autosize above was already doing — and the toolbar arrives with the first
    thing there is to capture.
  */
  const expanded = body.trim().length > 0 || files.length > 0 || dragging;

  return (
    <div
      className={`panel composer-panel relative transition-colors ${dragging ? 'border-[color:var(--accent-from)]' : ''}`}
      // Files only. Taking every drag made dragging a link or a sentence in from
      // another page drop nothing at all — and, with storage off, say "File
      // storage is not configured" about a URL. Anything else is left to the
      // browser, which puts it into the box as text.
      onDragOver={(event) => {
        if (!carriesFiles(event.dataTransfer)) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        setDragging(false);
        if (!carriesFiles(event.dataTransfer)) return;
        event.preventDefault();
        void addFiles([...event.dataTransfer.files]);
      }}
    >
      <label className="sr-only" htmlFor="composer">
        Drop a blip
      </label>
      <div className="flex items-start gap-1">
        <textarea
          id="composer"
          ref={textarea}
          value={body}
          rows={1}
          placeholder={placeholder}
          className="min-w-0 flex-1 resize-none bg-transparent px-4 pt-3 pb-2.5 text-[15.5px] leading-relaxed text-[color:var(--paper)] outline-none placeholder:text-[color:var(--paper-faint)]"
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              void submit();
            }
          }}
          onPaste={(event) => {
            const pasted = [...event.clipboardData.files];
            if (pasted.length > 0) {
              event.preventDefault();
              void addFiles(pasted);
            }
          }}
        />
        {/* At rest the attach control rides the same row, so the whole box is
            one line and there is still a way to capture a photo without typing
            anything — adding a file expands the box and brings Capture with it. */}
        {!expanded ? (
          <label
            className="btn btn-ghost mt-1 mr-1 shrink-0 cursor-pointer p-2"
            title="Attach a file"
          >
            <Paperclip className="h-4 w-4" />
            <span className="sr-only">Attach a file</span>
            <input
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                void addFiles([...(event.target.files ?? [])]);
                event.target.value = '';
              }}
            />
          </label>
        ) : null}
      </div>

      {files.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 px-4 pb-2">
          {files.map((entry) => (
            <span
              key={entry.id}
              className="flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[12px]"
              style={{
                borderColor: entry.error ? 'var(--danger)' : 'var(--line)',
                background: 'var(--ink-850)',
              }}
            >
              {!entry.key && !entry.error ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Paperclip className="h-3 w-3 opacity-60" />
              )}
              <span className="max-w-[10rem] truncate">{entry.file.name}</span>
              <span className="instrument !tracking-normal">
                {entry.error ?? fileSize(entry.file.size)}
              </span>
              <button
                className="opacity-60 hover:opacity-100"
                aria-label={`Remove ${entry.file.name}`}
                onClick={() => setFiles((current) => current.filter((f) => f.id !== entry.id))}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div
        className={`${expanded ? 'flex' : 'hidden'} items-center justify-between gap-3 border-t border-[color:var(--line-soft)] px-3 py-2`}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <label className="btn btn-ghost cursor-pointer p-1.5" title="Attach a file">
            <Paperclip className="h-4 w-4" />
            <span className="sr-only">Attach a file</span>
            <input
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                void addFiles([...(event.target.files ?? [])]);
                event.target.value = '';
              }}
            />
          </label>
          {/* Show what the server is about to infer, so nothing is a surprise.
              The fallback line is split by breakpoint rather than by JS: a phone
              has no Cmd key, and telling somebody to press one is worse than
              saying nothing. */}
          <span className="instrument truncate">
            {mentioned.length > 0 ? (
              // The composer previews everything else it is about to infer, and
              // who gets interrupted is the inference most worth previewing.
              `will notify · ${mentioned.map((person) => person.name).join(' · ')}`
            ) : link ? (
              // Named rather than "will save as a link" when the body is more
              // than the URL: on a reading list you are usually writing a note
              // around it, and the reassurance you want is *which* link it took.
              bareUrl ? (
                'will save as a link'
              ) : (
                `link · ${hostOf(link)}`
              )
            ) : inferredTags.length > 0 ? (
              `tags · ${inferredTags.join(' · ')}`
            ) : (
              <>
                {/* Both halves: somebody used to chat boxes presses Enter to send,
                    gets a new line, and wonders whether it worked. */}
                <span className="hidden sm:inline">enter adds a line · cmd + enter captures</span>
                <span className="sm:hidden">#tags are inferred</span>
              </>
            )}
          </span>
        </div>
        <button className="btn btn-accent" disabled={!ready} onClick={() => void submit()}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          Capture
        </button>
      </div>
      {/* A handle naming nobody on this radar posts as plain text. Said here,
          before the capture, rather than discovered by its silence after.
          Nothing to say about an empty box, so it costs no height at rest. */}
      {expanded ? (
        <div className="px-4 pb-2">
          <MentionHint body={body} candidates={candidates} />
        </div>
      ) : null}
      {/* Only where the draft cannot outlive this page (storage blocked):
          elsewhere it is simply there when you come back. */}
      {body.trim() && !draftsPersist() ? <UnsentGuard /> : null}
    </div>
  );
}
