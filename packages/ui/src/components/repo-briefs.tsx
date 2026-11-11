/**
 * The Briefs tab: the facts about the product an agent works on — how to run,
 * test and deploy it, its invariants and gotchas (docs/AGENT_REPO.md §V2.15,
 * §V2.16). An agent reads a brief when its task touches it; this is where a
 * person reads, writes and curates them.
 *
 * The shape is the Memory tab's — a list you can scan with the selected brief
 * beside it when there is room — but the selected brief is a document, so it
 * gets the wide column and the list the narrow one. On a phone it is one or
 * the other, and the brief has a way back.
 *
 * Access is the prompt's: reading needs what reading the prompt needs, editing
 * needs prompt edit, and a recipient reads each brief as it stood when they
 * accepted the agent, told plainly when the owner has moved on. Deleting is
 * the owner's alone and asks for the name typed back: it takes every revision
 * with it, for everyone.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowLeft, History, MoreHorizontal } from 'lucide-react';
import {
  AGENT_REPO,
  briefNameSchema,
  utf8Length,
  type BriefDto,
  type BriefIndexEntryDto,
  type RepoAgentDto,
} from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { renderMarkdown } from '../lib/markdown';
import { must } from '../lib/must';
import { queryKeys } from '../lib/session';
import { ConfirmDialog, Empty, Modal, Spinner, notify } from './primitives';
import { QueryError } from './query-error';
import { MarkdownEditor, type MarkdownEditorApi } from './markdown-editor';
import { DiffView, VersionCompare, compareView, type CompareView } from './repo-diff';
import {
  Cosigned,
  LeaveGuard,
  Segmented,
  ago,
  personName,
  plural,
  useInvalidateAgent,
  useWho,
  useWide,
  writerOf,
} from './repo-common';
import { useAgentPage } from './repo-context';
import { BindingDialog, BriefRepoStatus, RepoChip, useCanBind } from './repo-brief-repo';

const CAP = AGENT_REPO.briefBodyBytes;

/** "12.3 KB" — one decimal, so a few bytes over the cap never reads as exactly 16. */
const kb = (bytes: number) =>
  bytes < 1024 ? `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}` : `${(bytes / 1024).toFixed(1)} KB`;

/** "edited by you", "written by the agent in Claude Code (MacBook)", "imported". */
function byline(
  brief: Pick<
    BriefDto,
    'source' | 'harness' | 'clientLabel' | 'author' | 'harnessCheck' | 'client'
  >,
  who: Who,
): string {
  if (brief.source === 'import') return 'imported';
  if (brief.source === 'agent') return `written by ${writerOf(brief)}`;
  return `edited by ${who(brief.author)}`;
}

type Who = ReturnType<typeof useWho>;

/**
 * The conflict sheet's headline, naming who saved in between. When that was
 * the viewer — their own other tab — "someone" contradicts the byline below it
 * ("edited by you"), so it says where instead.
 */
function changedWhileEditing(theirs: BriefDto, who: Who): string {
  if (theirs.source === 'agent') return 'The agent changed this brief while you were editing';
  const name = who(theirs.author);
  if (name === 'you') return 'This brief changed in another tab or window';
  if (theirs.source === 'import' || name === 'someone')
    return 'Someone changed this brief while you were editing';
  return `${name} changed this brief while you were editing`;
}

/** Who may do what here — from the page's agent, decided once. */
function useBriefRights() {
  const { agent, canEditPrompt } = useAgentPage();
  return {
    canEdit: canEditPrompt && !agent.archived,
    canDelete: agent.access.canManage && !agent.archived,
  };
}

function useBriefs(agentId: string) {
  return useQuery({
    queryKey: queryKeys.repoAgentPart(agentId, 'briefs'),
    queryFn: () => api.agentRepo.briefs(agentId),
  });
}

export function BriefsTab() {
  const { agent } = useAgentPage();
  if (agent.awaitingAccept)
    return (
      <Empty
        title="Accept this agent to read its briefs"
        hint="Its briefs come with the prompt: they load once you accept it."
      />
    );
  return <BriefBrowser agent={agent} />;
}

function BriefBrowser({ agent }: { agent: RepoAgentDto }) {
  const search = useSearch({ from: '/_app/repo/$agentId' });
  const navigate = useNavigate();
  const { canEdit } = useBriefRights();
  const list = useBriefs(agent.id);
  const briefs = list.data?.briefs ?? [];
  const [editing, setEditing] = useState<BriefIndexEntryDto | 'new' | null>(null);
  const { ref, wide, measured } = useWide(820);
  // With room for both, the first brief is open rather than an empty column —
  // decided on the measured width, so a phone never fetches a brief it hides.
  const selected =
    briefs.find((b) => b.name === search.b) ??
    (measured && wide && !search.b ? briefs[0] : undefined) ??
    null;

  const select = (name: string | null) =>
    void navigate({
      to: '.',
      search: (previous) => {
        const rest = { ...previous };
        delete rest['b'];
        delete rest['history'];
        return name ? { ...rest, b: name } : rest;
      },
      replace: true,
    });

  const full = briefs.length >= AGENT_REPO.briefsPerAgent;
  const newButton = canEdit ? (
    <button className="btn btn-accent" disabled={full} onClick={() => setEditing('new')}>
      New brief
    </button>
  ) : null;
  const showList = wide || !selected;

  // One wrapper in every state: it is what the width is measured on.
  return (
    <div className="briefs-tab" ref={ref}>
      {list.isLoading ? (
        <Spinner label="Reading the briefs" />
      ) : list.error ? (
        <QueryError error={list.error} resource="The briefs" retry={() => list.refetch()} />
      ) : editing ? (
        <BriefEditor
          agent={agent}
          entry={editing === 'new' ? null : editing}
          onDone={(saved) => {
            setEditing(null);
            if (saved) select(saved);
          }}
        />
      ) : briefs.length === 0 ? (
        <Empty
          title="No briefs yet"
          hint={
            canEdit
              ? 'A brief holds the facts about the product this agent works on — how to run, test and deploy it, and what not to break. Agents read one when their task touches it.'
              : `${personName(agent.owner)} hasn’t written any briefs for this agent.`
          }
          action={newButton}
        />
      ) : (
        <div className={`briefs-layout ${wide ? 'is-wide' : ''}`}>
          {showList ? (
            <div className="briefs-index">
              <div className="briefs-countline">
                <span className="instrument">{plural(briefs.length, 'brief')}</span>
                <span className="ml-auto">{newButton}</span>
              </div>
              {full && canEdit ? (
                <p className="note">
                  {AGENT_REPO.briefsPerAgent} is the most an agent can have — fold one into another
                  to make room.
                </p>
              ) : null}
              <ul className="memory-list" aria-label="Briefs">
                {briefs.map((b) => (
                  <li key={b.name}>
                    <button
                      type="button"
                      className={`memory-row ${b.name === selected?.name ? 'is-on' : ''}`}
                      aria-current={b.name === selected?.name ? 'true' : undefined}
                      onClick={() => select(b.name)}
                    >
                      <span className="memory-row-head">
                        <span className="memory-name">{b.name}</span>
                        <span className="memory-who">
                          r{b.revision} · {ago(b.updatedAt)}
                        </span>
                      </span>
                      <span className="memory-description">{b.description}</span>
                      {b.newerRevision ? (
                        <span className="brief-newer-chip instrument">
                          r{b.newerRevision} is newer
                        </span>
                      ) : null}
                      <RepoChip stale={b.stale} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {selected ? (
            <BriefView
              key={selected.name}
              agent={agent}
              entry={selected}
              onBack={wide ? null : () => select(null)}
              onEdit={() => setEditing(selected)}
              onRenamed={(name) => select(name)}
              onDeleted={() => select(null)}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

/** One brief, read: what it is, who last wrote it and why, and the document. */
function BriefView({
  agent,
  entry,
  onBack,
  onEdit,
  onRenamed,
  onDeleted,
}: {
  agent: RepoAgentDto;
  entry: BriefIndexEntryDto;
  onBack: (() => void) | null;
  onEdit: () => void;
  onRenamed: (name: string) => void;
  onDeleted: () => void;
}) {
  const search = useSearch({ from: '/_app/repo/$agentId' });
  const navigate = useNavigate();
  const { canEdit, canDelete } = useBriefRights();
  const who = useWho();
  const brief = useQuery({
    queryKey: queryKeys.repoAgentPart(agent.id, 'brief', entry.name, entry.revision),
    queryFn: () => api.agentRepo.brief(agent.id, entry.name, entry.revision),
  });
  const canBind = useCanBind(agent);
  const [more, setMore] = useState(false);
  const [binding, setBinding] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const html = useMemo(
    () => (brief.data ? renderMarkdown(brief.data.brief.body, { tagLinks: false }) : ''),
    [brief.data],
  );
  const setHistory = (at: number | null) =>
    void navigate({
      to: '.',
      search: (previous) => {
        const rest = { ...previous };
        delete rest['history'];
        return at === null ? rest : { ...rest, history: at };
      },
    });
  const current = brief.data?.brief;

  return (
    <section className="brief-view" aria-labelledby="brief-title">
      {onBack ? (
        <button type="button" className="btn btn-ghost brief-back" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
          All briefs
        </button>
      ) : null}
      <header className="brief-head">
        <div className="min-w-0">
          <h2 id="brief-title" className="brief-title">
            {entry.name}
          </h2>
          <p className="memory-description">{entry.description}</p>
        </div>
        <span className="brief-actions">
          <button className="btn" onClick={() => setHistory(entry.revision)}>
            <History className="h-4 w-4" />
            History
          </button>
          {canEdit ? (
            <button className="btn btn-accent" onClick={onEdit}>
              Edit
            </button>
          ) : null}
          {canEdit || canDelete ? (
            <button
              className="btn"
              aria-label={`More actions for ${entry.name}`}
              onClick={() => setMore(true)}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          ) : null}
        </span>
      </header>
      {current ? (
        <p className="brief-meta instrument">
          r{current.revision} · {byline(current, who)}
          {current.source === 'agent' && current.author ? (
            <>
              {' · '}
              <Cosigned name={who(current.author)} />
            </>
          ) : null}
          {' · '}
          {ago(current.updatedAt)}
          {current.note ? <span className="brief-note"> · “{current.note}”</span> : null}
        </p>
      ) : null}
      <BriefRepoStatus entry={entry} canBind={canBind} onBind={() => setBinding(true)} />
      {entry.newerRevision ? (
        <div className="agent-banner is-accent brief-newer" role="status">
          <span>
            <strong>{personName(agent.owner)}</strong> has changed this brief since you accepted the
            agent. You run r{entry.revision}; the latest is r{entry.newerRevision}. Take the update
            at the top of the page to run it.
          </span>
          <span className="agent-banner-actions">
            <button className="btn" onClick={() => setHistory(entry.revision)}>
              Review changes
            </button>
          </span>
        </div>
      ) : null}

      {brief.isLoading ? (
        <Spinner label="Reading the brief" />
      ) : brief.error ? (
        <QueryError error={brief.error} resource="This brief" retry={() => brief.refetch()} />
      ) : (
        <article
          className="md-doc prompt-doc"
          aria-label={`The brief ${entry.name}`}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}

      {search.history !== undefined ? (
        <BriefHistory
          agent={agent}
          entry={entry}
          initial={search.history}
          onClose={() => setHistory(null)}
        />
      ) : null}
      {more ? (
        <Modal title={entry.name} size="sm" onClose={() => setMore(false)}>
          <div className="flex flex-col gap-2">
            {canEdit ? (
              <button
                className="btn justify-start"
                onClick={() => {
                  setMore(false);
                  setRenaming(true);
                }}
              >
                Rename…
              </button>
            ) : null}
            {canBind ? (
              <button
                className="btn justify-start"
                onClick={() => {
                  setMore(false);
                  setBinding(true);
                }}
              >
                {entry.stale ? 'Repository…' : 'Bind to a repository…'}
              </button>
            ) : null}
            {canDelete ? (
              <button
                className="btn btn-danger-quiet justify-start"
                onClick={() => {
                  setMore(false);
                  setDeleting(true);
                }}
              >
                Delete…
              </button>
            ) : null}
          </div>
        </Modal>
      ) : null}
      {binding ? (
        <BindingDialog agent={agent} entry={entry} onClose={() => setBinding(false)} />
      ) : null}
      {renaming ? (
        <RenameDialog
          agent={agent}
          entry={entry}
          onClose={() => setRenaming(false)}
          onRenamed={onRenamed}
        />
      ) : null}
      {deleting ? (
        <DeleteDialog
          agent={agent}
          entry={entry}
          onClose={() => setDeleting(false)}
          onDeleted={onDeleted}
        />
      ) : null}
    </section>
  );
}

function RenameDialog({
  agent,
  entry,
  onClose,
  onRenamed,
}: {
  agent: RepoAgentDto;
  entry: BriefIndexEntryDto;
  onClose: () => void;
  onRenamed: (name: string) => void;
}) {
  const invalidate = useInvalidateAgent(agent.id);
  const [name, setName] = useState(entry.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = briefNameSchema.safeParse(name).success;
  const changed = name.trim() !== entry.name;
  const submit = () =>
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        const { brief } = await api.agentRepo.renameBrief(agent.id, entry.name, name.trim());
        await invalidate();
        notify(`Renamed to ${brief.name}`);
        onClose();
        onRenamed(brief.name);
      } catch (err) {
        setError(
          err instanceof ApiError && err.status === 409
            ? `There’s already a brief called ${name.trim()}. Choose another name.`
            : briefFailure(err, 'Could not rename it.'),
        );
        setBusy(false);
      }
    })();
  return (
    <Modal
      title="Rename brief"
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-accent" disabled={!valid || !changed || busy} onClick={submit}>
            Rename
          </button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && changed && !busy) submit();
        }}
      >
        <label className="form-label" htmlFor="brief-rename">
          New name
        </label>
        <input
          id="brief-rename"
          className="field font-mono text-[13.5px]"
          value={name}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          maxLength={AGENT_REPO.briefNameLength}
          aria-invalid={!valid}
          onChange={(event) => setName(asBriefName(event.target.value))}
        />
        <p className="note">
          Lower-case letters, digits and hyphens. Its history comes with it. Agents find a brief by
          its name, so a workspace or note that names <strong>{entry.name}</strong> will need the
          new one.
        </p>
        {error ? (
          <p className="note text-[color:var(--danger)]" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

function DeleteDialog({
  agent,
  entry,
  onClose,
  onDeleted,
}: {
  agent: RepoAgentDto;
  entry: BriefIndexEntryDto;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const invalidate = useInvalidateAgent(agent.id);
  const [busy, setBusy] = useState(false);
  const revisions = entry.newerRevision ?? entry.revision;
  return (
    <ConfirmDialog
      title={`Delete ${entry.name}?`}
      body={
        <>
          This deletes the brief and{' '}
          {revisions === 1 ? 'its only revision' : `all ${revisions} of its revisions`}. It goes for
          everyone this agent is shared with, straight away — including anyone who hasn’t taken your
          latest update. This can’t be undone.
        </>
      }
      phrase={entry.name}
      confirmLabel="Delete brief"
      danger
      busy={busy}
      onClose={onClose}
      onConfirm={() =>
        void (async () => {
          setBusy(true);
          try {
            await api.agentRepo.deleteBrief(agent.id, entry.name);
            await invalidate();
            notify(`Deleted ${entry.name}`);
            onClose();
            onDeleted();
          } catch (err) {
            notify(
              err instanceof ApiError && err.status === 404
                ? 'It was already deleted or renamed.'
                : 'Could not delete it.',
              'error',
            );
            setBusy(false);
          }
        })()
      }
    />
  );
}

/** Typing "Site Delivery" gives "site-delivery": lower case, spaces to hyphens. */
function asBriefName(raw: string): string {
  return raw.toLowerCase().replace(/[\s_]+/g, '-');
}

interface Conflict {
  mine: string;
  base: BriefDto;
  theirs: BriefDto;
  /** Set when the brief was renamed under the edit: theirs is the brief by its new name. */
  renamedTo?: string;
}

/** The newest revision of a brief, whatever the caller runs: what a save must be based on. */
async function latestBrief(agentId: string, name: string): Promise<BriefDto> {
  const { revisions } = await api.agentRepo.briefRevisions(agentId, name);
  const newest = revisions[0]?.revision;
  return (await api.agentRepo.brief(agentId, name, newest)).brief;
}

/**
 * What a brief that vanished under an edit is called now, if it was renamed
 * rather than deleted — read from Activity, newest first, following a chain
 * of renames a few links deep. Null when it was deleted, or cannot be told.
 */
async function renamedTo(agentId: string, name: string): Promise<string | null> {
  const [{ items }, { briefs }] = await Promise.all([
    api.agentRepo.activity(agentId, { kind: 'briefs' }),
    api.agentRepo.briefs(agentId),
  ]);
  let current = name;
  for (let hop = 0; hop < 5; hop += 1) {
    const rename = items.find(
      (item) => item.brief?.op === 'rename' && item.brief.previousName === current,
    );
    if (!rename?.brief) return null;
    current = rename.brief.name;
    if (briefs.some((b) => b.name === current)) return current;
  }
  return null;
}

/** "Brief" errors in words a person can act on; the server's are written for agents. */
function briefFailure(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.status === 404)
    return 'This brief was renamed or deleted just now. Close this and look again.';
  if (error instanceof ApiError && error.status === 409)
    return 'This brief changed just now. Close this and look again.';
  return fallback;
}

/**
 * Write a new brief, or edit one in place. Save is optimistic against the
 * revision editing started from; a 409 opens a sheet that says plainly that
 * someone changed it, shows theirs, and lets the person start again from it or
 * put their own on top. If the brief was renamed or deleted under the edit, the
 * text stays in the editor and the person can save it into the renamed brief
 * or as a new one.
 */
function BriefEditor({
  agent,
  entry,
  onDone,
}: {
  agent: RepoAgentDto;
  entry: BriefIndexEntryDto | null;
  onDone: (saved: string | null) => void;
}) {
  const invalidate = useInvalidateAgent(agent.id);
  const who = useWho();
  const list = useBriefs(agent.id);
  const taken = list.data?.briefs.map((b) => b.name) ?? [];
  const [creating, setCreating] = useState(entry === null);
  /** The brief this edit saves into; it moves if the brief is renamed under the edit. */
  const [target, setTarget] = useState(entry?.name ?? '');
  const [base, setBase] = useState<BriefDto | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  useEffect(() => {
    if (!entry) return;
    let live = true;
    latestBrief(agent.id, entry.name).then(
      (latest) => live && setBase(latest),
      (error: unknown) => live && setLoadError(error),
    );
    return () => {
      live = false;
    };
  }, [agent.id, entry]);

  const editor = useRef<MarkdownEditorApi | null>(null);
  const [generation, setGeneration] = useState(0);
  const [dirty, setDirty] = useState(false);
  /** Text carried over from a brief that vanished: a change even if untouched since. */
  const [carried, setCarried] = useState(false);
  /** What the editor last reported; until it does, the size of what it opened. */
  const [measured, setMeasured] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lost, setLost] = useState<{ mine: string; renamedTo: string | null } | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [conflictView, setConflictView] = useState<'changes' | 'theirs' | 'source'>('changes');
  const [discarding, setDiscarding] = useState(false);

  if (loadError)
    return (
      <QueryError
        error={loadError}
        resource="This brief"
        retry={() => {
          setLoadError(null);
          onDone(null);
        }}
      />
    );
  if (entry && !base) return <Spinner label="Opening the editor" />;

  const bytes = measured ?? utf8Length(base?.body ?? '');
  const shownDescription = description ?? base?.description ?? '';
  const descriptionChanged = description !== null && description.trim() !== base?.description;
  const nameValid = !creating || briefNameSchema.safeParse(name).success;
  const nameTaken = creating && taken.includes(name);
  const over = bytes > CAP;
  const near = !over && bytes > CAP * 0.9;
  const changed = creating
    ? (dirty || carried) && Boolean(name)
    : dirty || carried || descriptionChanged;
  const ready =
    changed &&
    !lost &&
    !over &&
    bytes > 0 &&
    shownDescription.trim().length > 0 &&
    nameValid &&
    !nameTaken &&
    !saving;

  const save = async (body: string, expectedRevision: number | undefined, into = target) => {
    if (!body.trim()) {
      setError('A brief cannot be empty.');
      return;
    }
    setSaving(true);
    setError(null);
    const saveTo = creating ? name : into;
    try {
      const trimmedNote = note.trim();
      const { brief } = await api.agentRepo.saveBrief(agent.id, saveTo, {
        body,
        ...(creating || descriptionChanged ? { description: shownDescription.trim() } : {}),
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
        ...(trimmedNote ? { note: trimmedNote } : {}),
      });
      setDirty(false);
      setCarried(false);
      await invalidate();
      notify(creating ? `Added ${brief.name}` : `Saved as r${brief.revision}`);
      onDone(brief.name);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : null;
      if (creating && status === 409) {
        // A name taken since the list was read, or the agent is full.
        const { briefs } = await api.agentRepo.briefs(agent.id).catch(() => ({ briefs: [] }));
        void invalidate();
        setError(
          briefs.some((b) => b.name === saveTo)
            ? `There’s already a brief called ${saveTo}. Choose another name.`
            : `This agent already has ${AGENT_REPO.briefsPerAgent} briefs, the most it can hold. Fold this into one of them.`,
        );
      } else if (!creating && status === 404) {
        void invalidate();
        setLost({ mine: body, renamedTo: await renamedTo(agent.id, saveTo).catch(() => null) });
      } else if (!creating && status === 409 && base) {
        const theirs = await latestBrief(agent.id, saveTo).catch(() => null);
        if (theirs) {
          setConflictView('changes');
          setConflict({ mine: body, base, theirs });
        } else setError(briefFailure(err, 'Could not save the brief.'));
      } else {
        setError(briefFailure(err, 'Could not save the brief.'));
      }
    } finally {
      setSaving(false);
    }
  };

  /** Save the kept text into the brief under its new name, through the conflict sheet. */
  const intoRenamed = async (mine: string, newName: string) => {
    try {
      const theirs = await latestBrief(agent.id, newName);
      setTarget(newName);
      setLost(null);
      setConflictView('changes');
      setConflict({ mine, base: base ?? theirs, theirs, renamedTo: newName });
    } catch {
      setLost({ mine, renamedTo: null });
    }
  };

  /** Keep the text and turn this edit into a new brief, under the old name if it is free. */
  const asNewBrief = () => {
    setCreating(true);
    setCarried(true);
    setName(target);
    setLost(null);
  };

  const nextRevision = (conflict?.theirs.revision ?? base?.revision ?? 0) + 1;
  return (
    <div className="prompt-tab is-editing brief-editor">
      <div className="brief-fields">
        {creating ? (
          <div className="flex flex-col gap-1.5">
            <label className="form-label" htmlFor="brief-name">
              Name
            </label>
            <input
              id="brief-name"
              className="field font-mono text-[13.5px]"
              placeholder="site-delivery"
              value={name}
              autoComplete="off"
              spellCheck={false}
              maxLength={AGENT_REPO.briefNameLength}
              aria-invalid={Boolean(name) && (!nameValid || nameTaken)}
              aria-describedby="brief-name-hint"
              onChange={(event) => setName(asBriefName(event.target.value))}
            />
            <span id="brief-name-hint" className="note">
              {nameTaken
                ? `There’s already a brief called ${name}.`
                : name && !nameValid
                  ? 'Lower-case letters, digits and hyphens, not starting or ending with a hyphen.'
                  : 'How agents ask for it: lower-case words joined by hyphens.'}
            </span>
          </div>
        ) : (
          <p className="brief-title">{target}</p>
        )}
        <div className="flex flex-col gap-1.5">
          <label className="form-label" htmlFor="brief-description">
            What it covers
          </label>
          <input
            id="brief-description"
            className="field"
            placeholder="One line — what an agent will find in it"
            maxLength={AGENT_REPO.briefDescriptionLength}
            value={shownDescription}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
      </div>
      {lost ? (
        <div className="agent-banner is-accent brief-lost" role="alert">
          <span>
            This brief was renamed or deleted while you were editing. Your text is kept below.
            {lost.renamedTo ? (
              <>
                {' '}
                It’s now called <strong>{lost.renamedTo}</strong>.
              </>
            ) : null}
          </span>
          <span className="agent-banner-actions">
            {lost.renamedTo ? (
              <button
                className="btn btn-accent"
                onClick={() => void intoRenamed(lost.mine, must(lost.renamedTo))}
              >
                Save it into {lost.renamedTo}
              </button>
            ) : null}
            <button className="btn" onClick={asNewBrief}>
              Save as a new brief
            </button>
          </span>
        </div>
      ) : null}
      <MarkdownEditor
        key={`${base?.revision ?? 0}:${generation}`}
        value={base?.body ?? ''}
        label={creating ? 'The new brief' : `The brief ${target}`}
        meta={creating ? 'New brief · saves as Markdown' : `Editing r${base?.revision ?? ''}`}
        apiRef={editor}
        autoFocus={!creating}
        onDirtyChange={setDirty}
        onTextChange={(markdown) => setMeasured(utf8Length(markdown))}
        onNormalised={() => setNote((current) => current || 'formatting normalised by the editor')}
      />
      <div className="md-savebar">
        <span
          className={`brief-size instrument ${over ? 'is-over' : near ? 'is-near' : ''}`}
          aria-live="polite"
        >
          {kb(bytes)} of {CAP / 1024} KB
        </span>
        <input
          className="field"
          aria-label="Why — kept with this revision"
          placeholder="Why — kept with this revision (optional)"
          maxLength={AGENT_REPO.promptNoteLength}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <button
          className="btn"
          disabled={saving}
          onClick={() => (changed ? setDiscarding(true) : onDone(null))}
        >
          Cancel
        </button>
        <button
          className="btn btn-accent"
          disabled={!ready}
          onClick={() =>
            void save(editor.current?.markdown() ?? '', creating ? undefined : base?.revision)
          }
        >
          {creating ? 'Add brief' : `Save as r${nextRevision}`}
        </button>
        {over ? (
          <p className="brief-size-help" role="alert">
            Too long by {kb(bytes - CAP)}. A brief is at most 16 KB — move some of it into another
            brief.
          </p>
        ) : null}
        {error ? (
          <p className="brief-size-help" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      {changed ? <LeaveGuard what="this brief" /> : null}
      {discarding ? (
        <ConfirmDialog
          title="Discard your changes?"
          body="Nothing you changed in this edit will be kept."
          confirmLabel="Discard"
          danger
          onClose={() => setDiscarding(false)}
          onConfirm={() => {
            setDiscarding(false);
            setDirty(false);
            setCarried(false);
            onDone(null);
          }}
        />
      ) : null}
      {conflict ? (
        <Modal
          title={
            conflict.renamedTo
              ? `This brief is now called ${conflict.renamedTo}`
              : changedWhileEditing(conflict.theirs, who)
          }
          description={`It is now r${conflict.theirs.revision}, ${byline(conflict.theirs, who)} ${ago(conflict.theirs.updatedAt)}. Your edit started from r${conflict.base.revision}. Nothing of yours is lost.`}
          size="lg"
          onClose={() => setConflict(null)}
          footer={
            <>
              <button className="btn" onClick={() => setConflict(null)}>
                Keep editing
              </button>
              <button
                className="btn"
                onClick={() => {
                  setBase(conflict.theirs);
                  setDescription(null);
                  setGeneration((g) => g + 1);
                  setDirty(false);
                  setCarried(false);
                  setConflict(null);
                  void invalidate();
                }}
              >
                Start again from theirs
              </button>
              <button
                className="btn btn-accent"
                disabled={saving}
                onClick={() => {
                  const theirs = conflict.theirs;
                  setConflict(null);
                  void save(conflict.mine, theirs.revision, theirs.name);
                }}
              >
                Save mine on top
              </button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <Segmented
              label="Show"
              value={conflictView}
              onChange={setConflictView}
              options={[
                { value: 'changes', label: 'What changed' },
                { value: 'theirs', label: 'Theirs' },
                { value: 'source', label: 'Markdown' },
              ]}
            />
            {conflictView === 'theirs' ? (
              <div
                className="md-doc prompt-doc is-small"
                dangerouslySetInnerHTML={{
                  __html: renderMarkdown(conflict.theirs.body, { tagLinks: false }),
                }}
              />
            ) : (
              <DiffView
                before={conflict.base.body}
                after={conflict.theirs.body}
                beforeLabel={`r${conflict.base.revision}, where you started`}
                afterLabel={`r${conflict.theirs.revision}, theirs`}
                ignoreFormatting={conflictView === 'changes'}
              />
            )}
            <p className="note">
              Saving yours on top makes it r{conflict.theirs.revision + 1}. Theirs stays in History.
            </p>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/**
 * Every revision of one brief, newest first. Selecting one reads it; it can be
 * compared with the one before it or with the latest, and restored as the
 * next revision — history is only ever added to.
 */
function BriefHistory({
  agent,
  entry,
  initial,
  onClose,
}: {
  agent: RepoAgentDto;
  entry: BriefIndexEntryDto;
  initial: number;
  onClose: () => void;
}) {
  const { canEdit } = useBriefRights();
  const invalidate = useInvalidateAgent(agent.id);
  const pages = useInfiniteQuery({
    queryKey: queryKeys.repoAgentPart(agent.id, 'brief-revisions', entry.name),
    queryFn: ({ pageParam }) =>
      api.agentRepo.briefRevisions(agent.id, entry.name, pageParam ? { cursor: pageParam } : {}),
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const revisions = pages.data?.pages.flatMap((page) => page.revisions) ?? [];
  const latest = entry.newerRevision ?? entry.revision;
  const [selected, setSelected] = useState(initial);
  const navigate = useNavigate();
  const who = useWho();
  // The address follows the selection, so a link copied from here opens it.
  const choose = (revision: number) => {
    setSelected(revision);
    void navigate({
      to: '.',
      search: (previous) => ({ ...previous, history: revision }),
      replace: true,
    });
  };
  // A recipient reviewing what they would update to.
  const reviewing = entry.newerRevision !== null && initial === entry.revision;
  const [view, setView] = useState<CompareView>(
    reviewing ? 'current' : initial > 1 ? 'changes' : 'read',
  );
  const [restoring, setRestoring] = useState(false);
  const isCurrent = selected === latest;
  const previousRevision = selected - 1;
  const shown = compareView(view, previousRevision, isCurrent);
  const read = (revision: number, enabled = true) => ({
    queryKey: queryKeys.repoAgentPart(agent.id, 'brief', entry.name, revision),
    queryFn: () => api.agentRepo.brief(agent.id, entry.name, revision),
    enabled,
  });
  const chosen = useQuery(read(selected));
  const previous = useQuery(read(previousRevision, shown === 'changes' && previousRevision > 0));
  const newest = useQuery(read(latest, shown === 'current'));
  const body = chosen.data?.brief.body ?? '';

  return (
    <Modal title={`History · ${entry.name}`} side size="md" onClose={onClose}>
      <div className="flex flex-col gap-4">
        {pages.isLoading ? <Spinner label="Reading the history" /> : null}
        {pages.error ? (
          <QueryError error={pages.error} resource="History" retry={() => pages.refetch()} />
        ) : null}
        <ol className="history-list" aria-label="Revisions, newest first">
          {revisions.map((revision) => (
            <li key={revision.revision}>
              <button
                type="button"
                className={`history-row ${revision.revision === selected ? 'is-on' : ''}`}
                aria-pressed={revision.revision === selected}
                onClick={() => choose(revision.revision)}
              >
                <span>
                  <strong>r{revision.revision}</strong>{' '}
                  <span className="text-[color:var(--paper-dim)]">· {byline(revision, who)}</span>
                  {revision.source === 'agent' && revision.author ? (
                    <span className="text-[color:var(--paper-dim)]">
                      {' · '}
                      <Cosigned name={who(revision.author)} />
                    </span>
                  ) : null}
                </span>
                <span className="note">
                  {ago(revision.createdAt)}
                  {revision.note ? ` · “${revision.note}”` : ''}
                  {revision.revision === entry.revision && entry.newerRevision
                    ? ' · the one you run'
                    : ''}
                  {entry.newerRevision && revision.revision > entry.revision
                    ? ' · newer than yours'
                    : ''}
                </span>
              </button>
            </li>
          ))}
        </ol>
        {pages.hasNextPage ? (
          <button
            className="btn self-start"
            disabled={pages.isFetchingNextPage}
            onClick={() => void pages.fetchNextPage()}
          >
            Older revisions
          </button>
        ) : null}

        <div className="flex flex-col gap-3 border-t border-[color:var(--line-soft)] pt-4">
          <VersionCompare
            name={`r${selected}`}
            isCurrent={isCurrent}
            shown={shown}
            onView={setView}
            hasPrevious={previousRevision > 0}
            currentLabel={reviewing ? `Changes since r${selected}` : 'Compare with current'}
            loading={chosen.isLoading}
            changes={
              chosen.data && previous.data
                ? {
                    before: previous.data.brief.body,
                    after: body,
                    beforeLabel: `r${previousRevision}`,
                    afterLabel: `r${selected}`,
                  }
                : null
            }
            current={
              chosen.data && newest.data
                ? {
                    before: body,
                    after: newest.data.brief.body,
                    beforeLabel: `r${selected}`,
                    afterLabel: `r${latest}, current`,
                  }
                : null
            }
            body={chosen.data ? body : null}
          />
          {canEdit && !isCurrent && chosen.data ? (
            <button
              className="btn btn-accent self-start"
              disabled={restoring}
              onClick={() =>
                void (async () => {
                  setRestoring(true);
                  try {
                    const { brief } = await api.agentRepo.saveBrief(agent.id, entry.name, {
                      body,
                      description: must(chosen.data).brief.description,
                      expectedRevision: latest,
                      note: `Restored r${selected}`,
                    });
                    await invalidate();
                    notify(`Restored as r${brief.revision}`);
                    onClose();
                  } catch (error) {
                    notify(briefFailure(error, 'Could not restore it.'), 'error');
                    setRestoring(false);
                  }
                })()
              }
            >
              Restore as r{latest + 1}
            </button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
