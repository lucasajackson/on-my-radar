/**
 * A brief bound to a repository (docs/AGENT_REPO.md §V2.17): how far the code
 * at the bound path has moved since the brief's revision, whether the
 * mirrored file was edited in the repository, and where the one-way mirror's
 * merge request stands — plus the owner's dialog that binds it.
 *
 * On My Radar is the source of truth. Everything here reads; nothing a
 * repository says is ever written into the brief, and the words say so where
 * a person might expect otherwise (drift).
 */
import { useState } from 'react';
import { ExternalLink, GitBranch } from 'lucide-react';
import {
  BRIEF_MIRROR_HEADER,
  BRIEF_REPO,
  briefBindingSchema,
  staleLabel,
  type BriefIndexEntryDto,
  type BriefStaleDto,
  type RepoAgentDto,
} from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { useSession } from '../lib/session';
import { Modal, notify } from './primitives';
import { ago, useInvalidateAgent } from './repo-common';

/** The owner may bind, on a server whose tokens they are allowed to point: an administrator. */
export function useCanBind(agent: RepoAgentDto): boolean {
  const user = useSession().user;
  return agent.access.canManage && !agent.archived && Boolean(user?.isAdmin);
}

/**
 * The list's short form: "3 behind", "drift", "not checked". Nothing for a
 * brief that is current — the list is for scanning what needs a look.
 */
export function RepoChip({ stale }: { stale: BriefStaleDto | null }) {
  if (!stale) return null;
  const parts: Array<{ text: string; tone: string }> = [];
  if (stale.state === 'behind') {
    const n = stale.commitsBehind ?? 0;
    parts.push({
      text: `${n}${stale.capped ? '+' : ''} ${n === 1 && !stale.capped ? 'commit' : 'commits'} behind`,
      tone: 'is-behind',
    });
  } else if (stale.state === 'failed') parts.push({ text: 'check failed', tone: 'is-failed' });
  else if (stale.state === 'not_checked') parts.push({ text: 'not checked', tone: 'is-quiet' });
  if (stale.drift) parts.push({ text: 'drift', tone: 'is-drift' });
  if (parts.length === 0) return null;
  return (
    <span className="brief-repo-chips instrument" aria-label={`Repository: ${staleLabel(stale)}`}>
      {parts.map((p) => (
        <span key={p.text} className={`brief-repo-chip ${p.tone}`}>
          {p.text}
        </span>
      ))}
    </span>
  );
}

/** The headline a person reads under a bound brief's byline. */
function headline(stale: BriefStaleDto): string {
  const label = staleLabel(stale);
  if ((stale.state === 'behind' || stale.state === 'current') && stale.revision !== null)
    return `${label} since r${stale.revision}`;
  return label;
}

function mirrorLine(
  stale: BriefStaleDto,
  current: number,
): { text: string; url: string | null } | null {
  const m = stale.mirror;
  if (!m) return null;
  switch (m.state) {
    case 'disabled':
      return { text: 'mirror: off on this server', url: null };
    case 'opened':
      return {
        text: `mirror: merge request open for r${m.revision ?? current}`,
        url: m.mergeRequestUrl,
      };
    case 'failed':
      return { text: `mirror failed: ${m.reason ?? 'no reason given'}`, url: m.mergeRequestUrl };
    default:
      return { text: `mirror: merge request for r${current} on its way`, url: null };
  }
}

/** Under the byline of a bound brief: the readout, then drift and mirror if there is anything to say. */
export function BriefRepoStatus({
  entry,
  canBind,
  onBind,
}: {
  entry: BriefIndexEntryDto;
  canBind: boolean;
  onBind: () => void;
}) {
  const stale = entry.stale;
  if (!stale) return null;
  const { repo } = stale;
  const current = entry.newerRevision ?? entry.revision;
  const mirror = mirrorLine(stale, current);
  const where = `${repo.project} · ${repo.path} @ ${repo.ref}`;
  return (
    <div className="brief-repo" aria-label="Repository">
      <p className="brief-repo-line instrument">
        <GitBranch className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className={`brief-repo-state is-${stale.state}`}>{headline(stale)}</span>
        {stale.checkedAt ? (
          <span className="brief-repo-when">checked {ago(stale.checkedAt)}</span>
        ) : null}
      </p>
      {stale.reason ? <p className="note brief-repo-reason">{stale.reason}</p> : null}
      <p className="brief-repo-line instrument">
        <span className="brief-repo-where">
          {repo.url ? (
            <a href={repo.url} target="_blank" rel="noreferrer">
              {where}
            </a>
          ) : (
            where
          )}
        </span>
        {canBind ? (
          <button type="button" className="btn brief-repo-edit" onClick={onBind}>
            Change…
          </button>
        ) : null}
      </p>
      {stale.drift ? (
        <div className="agent-banner brief-drift" role="status">
          <span>
            <strong>Drift: {stale.drift.kind} in repo.</strong>{' '}
            {stale.drift.title ? (
              <>
                Latest: “{stale.drift.title}”
                {stale.drift.commit ? <> ({stale.drift.commit})</> : null}.{' '}
              </>
            ) : null}
            The change stays in the repository and is not imported: this brief is the source of
            truth{repo.mirror ? ', and its next mirror merge request writes it over that file' : ''}
            . If the change was right, make it here.
          </span>
          {stale.drift.url ? (
            <span className="agent-banner-actions">
              <a className="btn" href={stale.drift.url} target="_blank" rel="noreferrer">
                View commit
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </a>
            </span>
          ) : null}
        </div>
      ) : null}
      {mirror ? (
        <p
          className={`brief-repo-line instrument ${stale.mirror?.state === 'failed' ? 'is-failed' : ''}`}
        >
          <span>{mirror.text}</span>
          {mirror.url ? (
            <a href={mirror.url} target="_blank" rel="noreferrer">
              merge request
              <ExternalLink className="ml-1 inline h-3 w-3" aria-hidden />
            </a>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

/** The first problem with each field, in the schema's own words. */
function fieldErrors(input: unknown): Record<string, string> {
  const parsed = briefBindingSchema.safeParse(input);
  if (parsed.success) return {};
  const out: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const key = String(issue.path[0] ?? 'form');
    out[key] ??= issue.message;
  }
  return out;
}

/** Bind a brief to a repository path, change the binding, or unbind it. The owner's, an admin's. */
export function BindingDialog({
  agent,
  entry,
  onClose,
}: {
  agent: RepoAgentDto;
  entry: BriefIndexEntryDto;
  onClose: () => void;
}) {
  const invalidate = useInvalidateAgent(agent.id);
  const bound = entry.stale?.repo ?? null;
  const [project, setProject] = useState(bound?.project ?? '');
  const [path, setPath] = useState(bound?.path ?? 'docs/AGENT-BRIEF.md');
  const [ref, setRef] = useState(bound?.ref ?? 'main');
  const [mirror, setMirror] = useState(bound?.mirror ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const folder = path.trim().endsWith('/');
  const input = { project, path, ref, mirror: mirror && !folder };
  const errors = fieldErrors(input);
  const valid = Object.keys(errors).length === 0;
  const shown = (key: string) => (touched ? errors[key] : undefined);

  const run = (fn: () => Promise<void>) =>
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await invalidate();
        onClose();
      } catch (err) {
        setError(
          err instanceof ApiError && err.status === 403
            ? 'Only this server’s administrators can bind a brief to a repository, and only for an agent they own.'
            : err instanceof ApiError && err.status === 404
              ? 'This brief was renamed or deleted just now. Close this and look again.'
              : err instanceof ApiError && err.status === 400
                ? 'Check the project, path and branch.'
                : 'Could not save the binding.',
        );
        setBusy(false);
      }
    })();

  const save = () => {
    setTouched(true);
    if (!valid || busy) return;
    run(async () => {
      const { stale } = await api.agentRepo.bindBrief(agent.id, entry.name, input);
      notify(`Bound ${entry.name} to ${stale.repo.project}`);
    });
  };
  const unbind = () =>
    run(async () => {
      await api.agentRepo.unbindBrief(agent.id, entry.name);
      notify(`${entry.name} is no longer bound`);
    });

  const field = (
    id: string,
    label: string,
    value: string,
    set: (v: string) => void,
    hint: string,
    key: string,
    placeholder?: string,
  ) => (
    <div className="flex flex-col gap-1.5">
      <label className="form-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="field font-mono text-[13.5px]"
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={Boolean(shown(key))}
        aria-describedby={`${id}-hint`}
        onChange={(event) => set(event.target.value)}
      />
      <span id={`${id}-hint`} className={`note ${shown(key) ? 'text-[color:var(--danger)]' : ''}`}>
        {shown(key) ?? hint}
      </span>
    </div>
  );

  return (
    <Modal
      title={bound ? `Repository for ${entry.name}` : `Bind ${entry.name} to a repository`}
      size="sm"
      onClose={onClose}
      footer={
        <>
          {bound ? (
            <button className="btn btn-danger-quiet mr-auto" disabled={busy} onClick={unbind}>
              Stop checking the repository
            </button>
          ) : null}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-accent" disabled={busy || (touched && !valid)} onClick={save}>
            {bound ? 'Save' : 'Bind'}
          </button>
        </>
      }
    >
      <form
        className="brief-binding flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <p className="note">
          The brief stays here; the repository is checked against it. Its page says how many commits
          have touched this path since the brief was last revised.
        </p>
        {field(
          'binding-project',
          'GitLab project',
          project,
          setProject,
          'Like group/project.',
          'project',
          'lucas/on-my-radar',
        )}
        {field(
          'binding-path',
          'File or folder',
          path,
          setPath,
          'A file, or a folder ending in / to watch everything under it.',
          'path',
        )}
        {field('binding-ref', 'Branch', ref, setRef, 'Usually main.', 'ref')}
        <label className="brief-binding-mirror">
          <input
            type="checkbox"
            checked={mirror && !folder}
            disabled={folder}
            onChange={(event) => setMirror(event.target.checked)}
          />
          <span>
            <strong>Mirror this brief into the repository</strong>
            <span className="note block">
              {folder
                ? 'A mirror writes one file: bind a file to mirror into it.'
                : `Each change opens or updates a merge request from ${BRIEF_REPO.branchPrefix}… that writes the brief to this file under a header saying “${BRIEF_MIRROR_HEADER}”. Nothing is pushed straight to ${ref || 'the branch'}, and an edit made to the file in the repository is flagged as drift, never imported.`}
            </span>
          </span>
        </label>
        {error ? (
          <p className="note text-[color:var(--danger)]" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
