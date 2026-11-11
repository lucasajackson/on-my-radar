/**
 * The Prompt tab: the prompt as a page (docs/AGENT_REPO.md §V2.4).
 *
 * **Read** is the Markdown rendered as a document — the same escape-first
 * renderer as a blip (`lib/markdown.ts`), hashtags and mentions off — with an
 * outline of its headings beside it when there is room, and below it what each
 * tool also receives (the profiles' addenda), so what a tool actually gets is
 * visible here and nowhere else has to be opened to find out.
 *
 * **Edit** makes the same page editable in place: Milkdown, loaded only now.
 * Save stays disabled until the document actually changed, is optimistic
 * against the version editing started from, and a 409 opens the conflict sheet
 * rather than overwriting whoever saved in between.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { History, Lock } from 'lucide-react';
import {
  AGENT_REPO,
  HARNESSES,
  type PromptProposalDto,
  type PromptVersionDto,
  type RepoAgentDto,
} from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { renderMarkdown } from '../lib/markdown';
import { prefersReducedMotion } from '../lib/motion';
import { queryKeys } from '../lib/session';
import { ConfirmDialog, Modal, Spinner, notify } from './primitives';
import { QueryError } from './query-error';
import { MarkdownEditor, type MarkdownEditorApi } from './markdown-editor';
import { DiffView, VersionCompare, compareView, type CompareView } from './repo-diff';
import { LeaveGuard, ago, toolLabel, toolName, useInvalidateAgent, useWho } from './repo-common';

type Who = ReturnType<typeof useWho>;
import { useAgentPage } from './repo-context';

/** The agent that wrote a version, in the tool it said it ran in: "Lulu in Claude Code", "the agent". */
function agentWho(version: PromptVersionDto): string {
  const name = version.editorAgent?.name ?? 'the agent';
  return version.harness ? `${name} in ${toolLabel(version.harness, version)}` : name;
}

/** "changed by Lulu in Claude Code", "edited by you", "imported". */
function changedBy(version: PromptVersionDto, who: Who): string {
  if (version.source === 'import') return 'imported';
  if (version.source === 'agent') return `changed by ${agentWho(version)}`;
  return `edited by ${who(version.author)}`;
}

/** The history row's first line: "the agent · Claude Code · MacBook", "Ada", "imported". */
function authoredAs(version: PromptVersionDto, who: Who): string {
  if (version.source === 'import') return 'imported';
  if (version.source === 'agent')
    return [
      version.editorAgent?.name ?? 'the agent',
      version.harness ? toolLabel(version.harness, version) : null,
      version.clientLabel,
    ]
      .filter(Boolean)
      .join(' · ');
  return who(version.author);
}

/** The version a person reads here: a recipient's accepted one, unless they follow. */
export function shownVersion(agent: RepoAgentDto): number {
  if (agent.role === 'shared' && !agent.followUpdates && agent.acceptedVersion)
    return agent.acceptedVersion;
  return agent.promptVersion;
}

function usePrompt(agentId: string, version: number | 'live', enabled = true) {
  return useQuery({
    queryKey: queryKeys.repoAgentPart(agentId, 'prompt', version),
    queryFn: () => api.agentRepo.prompt(agentId, version),
    enabled,
  });
}

export function PromptTab() {
  const who = useWho();
  const { agent, canEditPrompt } = useAgentPage();
  const search = useSearch({ from: '/_app/repo/$agentId' });
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const version = shownVersion(agent);
  const prompt = usePrompt(agent.id, version, version > 0);
  const setHistory = (at: number | null) =>
    void navigate({
      to: '.',
      search: (previous) => {
        const rest = { ...previous };
        delete rest['history'];
        return at === null ? rest : { ...rest, history: at };
      },
    });

  if (editing) return <PromptEditor agent={agent} onDone={() => setEditing(false)} />;

  const current = prompt.data?.prompt;
  return (
    <div className="prompt-tab">
      <div className="prompt-meta-row">
        <span className="instrument">
          {current
            ? `v${current.version} · ${changedBy(current, who)} · ${ago(current.createdAt)}`
            : version === 0
              ? 'No prompt yet'
              : ' '}
          {agent.role === 'shared' && version < agent.promptVersion ? ' · the version you run' : ''}
        </span>
        {agent.lockPrompt ? (
          <span className="token">
            <Lock className="h-3 w-3" aria-hidden="true" /> Locked — agents’ changes wait for you
          </span>
        ) : null}
        <span className="ml-auto flex flex-wrap gap-2">
          {agent.promptVersion > 0 ? (
            <button className="btn" onClick={() => setHistory(agent.promptVersion)}>
              <History className="h-4 w-4" />
              History
            </button>
          ) : null}
          {canEditPrompt ? (
            <button className="btn btn-accent" onClick={() => setEditing(true)}>
              {agent.promptVersion ? 'Edit' : 'Write the prompt'}
            </button>
          ) : null}
        </span>
      </div>

      {canEditPrompt ? <Proposals agent={agent} /> : null}

      {version === 0 ? (
        <p className="note mt-6">
          {canEditPrompt
            ? 'This agent has no prompt yet. Write one — it is what every tool that runs the agent reads first.'
            : 'This agent has no prompt yet.'}
        </p>
      ) : prompt.isLoading ? (
        <Spinner label="Reading the prompt" />
      ) : prompt.error ? (
        <QueryError error={prompt.error} resource="The prompt" retry={() => prompt.refetch()} />
      ) : current ? (
        <PromptDocument body={current.body ?? ''} />
      ) : null}

      {search.history !== undefined && agent.promptVersion > 0 ? (
        <HistoryDrawer agent={agent} initial={search.history} onClose={() => setHistory(null)} />
      ) : null}
    </div>
  );
}

/**
 * Prompt changes an agent made that wait for the owner (ADR-0029): its own prompt, or any agent's
 * while the prompt is locked. Each is a diff against the live prompt with Accept and Reject for
 * the owner; everyone who can edit the prompt sees what is waiting. A change written against an
 * older version cannot be accepted: the prompt moved on, and the agent proposes again.
 */
function Proposals({ agent }: { agent: RepoAgentDto }) {
  const invalidate = useInvalidateAgent(agent.id);
  // The diff is against the LIVE prompt, which is not always the one the tab shows.
  const livePrompt = usePrompt(agent.id, 'live', agent.promptVersion > 0);
  // A refresh that failed keeps the cached version in `data`: it counts only while the query is
  // healthy AND is the version the change was written against.
  const liveFor = (proposal: PromptProposalDto) =>
    agent.promptVersion === 0
      ? proposal.basedOn === 0
        ? ''
        : undefined
      : !livePrompt.error && livePrompt.data?.prompt.version === proposal.basedOn
        ? livePrompt.data.prompt.body
        : undefined;
  const [busy, setBusy] = useState<string | null>(null);
  const proposals = useQuery({
    queryKey: queryKeys.repoAgentPart(agent.id, 'proposals'),
    queryFn: () => api.agentRepo.promptProposals(agent.id),
  });
  const decide = async (proposal: PromptProposalDto, accept: boolean) => {
    setBusy(proposal.id);
    try {
      if (accept) {
        const { prompt } = await api.agentRepo.acceptPromptProposal(agent.id, proposal.id);
        notify(`Accepted as v${prompt.version}`);
      } else {
        await api.agentRepo.rejectPromptProposal(agent.id, proposal.id);
        notify('Rejected');
      }
    } catch (error) {
      notify(error instanceof ApiError ? error.message : 'Could not save that decision', 'error');
    } finally {
      setBusy(null);
      await invalidate();
    }
  };
  if (proposals.error)
    return (
      <QueryError
        error={proposals.error}
        resource="The changes waiting for the owner"
        retry={() => proposals.refetch()}
      />
    );
  const waiting = proposals.data?.proposals ?? [];
  if (waiting.length === 0) return null;
  return (
    <section className="prompt-proposals" aria-label="Changes waiting for the owner">
      {waiting.map((proposal) => {
        const live = liveFor(proposal);
        return (
          <article key={proposal.id} className="prompt-proposal">
            <h2 className="instrument">
              {[
                `${proposal.editorAgent?.name ?? 'The agent'} proposes a change`,
                proposal.harness ? toolName(proposal.harness) : null,
                ago(proposal.createdAt),
              ]
                .filter(Boolean)
                .join(' · ')}
            </h2>
            {proposal.note ? <p className="note">{proposal.note}</p> : null}
            {proposal.stale ? null : live === undefined ? (
              livePrompt.isFetching && !livePrompt.error ? (
                <Spinner label="Reading the live prompt" />
              ) : (
                <div role="alert">
                  <p className="note">Live prompt changed or failed to load.</p>
                  <button className="btn" onClick={() => void livePrompt.refetch()}>
                    Try again
                  </button>
                </div>
              )
            ) : (
              <DiffView
                before={live}
                after={proposal.body}
                beforeLabel={`Live v${agent.promptVersion}`}
                afterLabel="Proposed"
              />
            )}
            {proposal.stale ? (
              <p className="note">
                Written against v{proposal.basedOn}; the prompt is v{agent.promptVersion} now. It
                can only be rejected: the agent proposes again from the live version.
              </p>
            ) : null}
            {agent.access.canManage ? (
              <div className="flex flex-wrap gap-2">
                {proposal.stale ? null : (
                  <button
                    className="btn btn-accent"
                    disabled={busy !== null || live === undefined}
                    onClick={() => void decide(proposal, true)}
                  >
                    Accept as v{agent.promptVersion + 1}
                  </button>
                )}
                <button
                  className="btn"
                  disabled={busy !== null}
                  onClick={() => void decide(proposal, false)}
                >
                  Reject
                </button>
              </div>
            ) : (
              <p className="note">Waiting for the agent’s owner.</p>
            )}
          </article>
        );
      })}
    </section>
  );
}

interface OutlineEntry {
  id: string;
  text: string;
  level: number;
}

/**
 * The rendered prompt, its outline, and the addenda. The outline is read from
 * the rendered headings rather than re-parsed from the source, so it can never
 * list a heading the page does not show (one inside a code fence, say).
 */
function PromptDocument({ body }: { body: string }) {
  const { agent, canEditPrompt } = useAgentPage();
  const html = useMemo(() => renderMarkdown(body, { tagLinks: false }), [body]);
  // Keep React from replacing the heading nodes (and their outline IDs) when
  // the outline or profiles update without changing the document.
  const documentHtml = useMemo(() => ({ __html: html }), [html]);
  const article = useRef<HTMLElement>(null);
  const [outline, setOutline] = useState<OutlineEntry[]>([]);
  useLayoutEffect(() => {
    const root = article.current;
    if (!root) return;
    const headings = Array.from(root.querySelectorAll<HTMLElement>('h2, h3, h4'));
    setOutline(
      headings.map((heading, index) => {
        heading.id = `prompt-section-${index + 1}`;
        heading.tabIndex = -1;
        return {
          id: heading.id,
          text: heading.textContent,
          level: Number(heading.tagName.slice(1)) - 1,
        };
      }),
    );
  }, [html]);
  const profiles = useQuery({
    queryKey: queryKeys.repoAgentPart(agent.id, 'profiles'),
    queryFn: () => api.agentRepo.profiles(agent.id),
  });
  const addenda = (profiles.data?.profiles ?? []).filter((p) => p.addendum.trim());

  return (
    <div className="prompt-layout">
      <div className="min-w-0">
        <article
          ref={article}
          className="md-doc prompt-doc"
          aria-label={`${agent.name}’s prompt`}
          dangerouslySetInnerHTML={documentHtml}
        />
        {addenda.length > 0 ? (
          <section className="prompt-addenda" aria-labelledby="prompt-addenda-title">
            <h2 id="prompt-addenda-title" className="instrument">
              What each tool also receives
            </h2>
            {addenda.map((profile) => (
              <details key={profile.harness} className="prompt-addendum">
                <summary>
                  Added for{' '}
                  {profile.harness === 'default'
                    ? 'any tool without its own profile'
                    : HARNESSES[profile.harness].short}
                </summary>
                <div
                  className="md-doc prompt-doc is-small"
                  dangerouslySetInnerHTML={{
                    __html: renderMarkdown(profile.addendum, { tagLinks: false }),
                  }}
                />
                {canEditPrompt ? (
                  <Link
                    className="note underline"
                    to="/repo/$agentId/tools"
                    params={{ agentId: agent.id }}
                    search={{ profile: profile.harness }}
                  >
                    Edit in Tools
                  </Link>
                ) : null}
              </details>
            ))}
          </section>
        ) : null}
      </div>
      {outline.length > 1 ? (
        <nav className="prompt-outline" aria-label="Contents">
          <span className="instrument">Contents</span>
          {outline.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`prompt-outline-link is-level-${Math.min(entry.level, 3)}`}
              onClick={() => {
                const target = document.getElementById(entry.id);
                target?.scrollIntoView({
                  behavior: prefersReducedMotion() ? 'auto' : 'smooth',
                  block: 'start',
                });
                target?.focus({ preventScroll: true });
              }}
            >
              {entry.text}
            </button>
          ))}
        </nav>
      ) : null}
    </div>
  );
}

interface Conflict {
  mine: string;
  base: PromptVersionDto;
  theirs: PromptVersionDto;
}

function PromptEditor({ agent, onDone }: { agent: RepoAgentDto; onDone: () => void }) {
  const who = useWho();
  const invalidate = useInvalidateAgent(agent.id);
  const live = usePrompt(agent.id, 'live', agent.promptVersion > 0);
  const [base, setBase] = useState<PromptVersionDto | null>(null);
  useEffect(() => {
    if (agent.promptVersion === 0 && !base)
      setBase({
        version: 0,
        status: 'live',
        basedOn: null,
        note: '',
        author: null,
        editorAgent: null,
        source: 'human',
        clientLabel: null,
        harness: null,
        harnessCheck: 'claimed',
        client: null,
        createdAt: new Date().toISOString(),
        body: '',
      });
    else if (live.data && !base) setBase(live.data.prompt);
  }, [agent.promptVersion, base, live.data]);

  const editor = useRef<MarkdownEditorApi | null>(null);
  const [generation, setGeneration] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [discarding, setDiscarding] = useState(false);

  if (live.error)
    return <QueryError error={live.error} resource="The prompt" retry={() => live.refetch()} />;
  if (!base) return <Spinner label="Opening the editor" />;

  const save = async (body: string, basedOn: number) => {
    if (!body.trim()) {
      notify('A prompt cannot be empty', 'error');
      return;
    }
    setSaving(true);
    try {
      const trimmed = note.trim();
      const { prompt } = await api.agentRepo.savePrompt(agent.id, {
        body,
        basedOn,
        ...(trimmed ? { note: trimmed } : {}),
      });
      setDirty(false);
      await invalidate();
      notify(`Saved as v${prompt.version}`);
      onDone();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const latest = await api.agentRepo.prompt(agent.id, 'live').catch(() => null);
        if (latest) setConflict({ mine: body, base, theirs: latest.prompt });
        else notify(error.message, 'error');
      } else {
        notify(error instanceof ApiError ? error.message : 'Could not save the prompt', 'error');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="prompt-tab is-editing">
      <MarkdownEditor
        key={`${base.version}:${generation}`}
        value={base.body ?? ''}
        label={`${agent.name}’s prompt`}
        meta={`Editing v${base.version} · saves as Markdown`}
        apiRef={editor}
        autoFocus
        onDirtyChange={setDirty}
        onNormalised={() => setNote((current) => current || 'formatting normalised by the editor')}
      />
      <div className="md-savebar">
        <input
          className="field"
          aria-label="Change note"
          placeholder="Note (optional) — why this change"
          maxLength={AGENT_REPO.promptNoteLength}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <button
          className="btn"
          disabled={saving}
          onClick={() => (dirty ? setDiscarding(true) : onDone())}
        >
          Cancel
        </button>
        <button
          className="btn btn-accent"
          disabled={!dirty || saving}
          onClick={() => void save(editor.current?.markdown() ?? '', base.version)}
        >
          Save as v{agent.promptVersion + 1}
        </button>
      </div>
      {dirty ? <LeaveGuard what="the prompt" /> : null}
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
            onDone();
          }}
        />
      ) : null}
      {conflict ? (
        <Modal
          title="This prompt changed while you were editing"
          description={`Now v${conflict.theirs.version}, ${changedBy(conflict.theirs, who)}. Your edit started from v${conflict.base.version}.`}
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
                  setGeneration((g) => g + 1);
                  setDirty(false);
                  setConflict(null);
                  void invalidate();
                }}
              >
                Start again from v{conflict.theirs.version}
              </button>
              <button
                className="btn btn-accent"
                disabled={saving}
                onClick={() => {
                  const theirs = conflict.theirs;
                  setConflict(null);
                  void save(conflict.mine, theirs.version);
                }}
              >
                Put my version on top
              </button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <p className="note">
              What changed between the version you started from and the one saved since. Putting
              yours on top saves it as v{conflict.theirs.version + 1} — their change stays in
              History.
            </p>
            <DiffView
              before={conflict.base.body ?? ''}
              after={conflict.theirs.body ?? ''}
              beforeLabel={`v${conflict.base.version}, where you started`}
              afterLabel={`v${conflict.theirs.version}, saved since`}
            />
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/**
 * Every version, newest first. Selecting one reads it; Compare diffs it against
 * the live prompt (formatting-blind on request); Restore saves it as the next
 * version — history is never rewritten, only added to.
 */
function HistoryDrawer({
  agent,
  initial,
  onClose,
}: {
  agent: RepoAgentDto;
  initial: number;
  onClose: () => void;
}) {
  const who = useWho();
  const { canEditPrompt } = useAgentPage();
  const invalidate = useInvalidateAgent(agent.id);
  const pages = useInfiniteQuery({
    queryKey: queryKeys.repoAgentPart(agent.id, 'prompts'),
    queryFn: ({ pageParam }) =>
      api.agentRepo.prompts(agent.id, pageParam ? { cursor: pageParam } : {}),
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const versions = pages.data?.pages.flatMap((page) => page.versions) ?? [];
  const [selected, setSelected] = useState(initial);
  const navigate = useNavigate();
  // The address follows the selection, so a link copied from here opens it.
  const choose = (version: number) => {
    setSelected(version);
    void navigate({
      to: '.',
      search: (previous) => ({ ...previous, history: version }),
      replace: true,
    });
  };
  const isRecipientReview =
    agent.role === 'shared' && initial === agent.acceptedVersion && initial < agent.promptVersion;
  const [view, setView] = useState<CompareView>(
    isRecipientReview ? 'current' : initial > 1 ? 'changes' : 'read',
  );
  const [restoring, setRestoring] = useState(false);
  const chosen = usePrompt(agent.id, selected);
  const current = usePrompt(agent.id, 'live');
  const previousVersion = chosen.data?.prompt.basedOn ?? selected - 1;
  const shown = compareView(view, previousVersion, selected === agent.promptVersion);
  const previous = usePrompt(agent.id, previousVersion, shown === 'changes');
  const isCurrent = selected === agent.promptVersion;
  const body = chosen.data?.prompt.body ?? '';

  return (
    <Modal title="History" side size="md" onClose={onClose}>
      <div className="flex flex-col gap-4">
        {pages.isLoading ? <Spinner label="Reading the history" /> : null}
        {pages.error ? (
          <QueryError error={pages.error} resource="History" retry={() => pages.refetch()} />
        ) : null}
        <ol className="history-list" aria-label="Versions, newest first">
          {versions.map((version) => {
            const newer =
              agent.role === 'shared' &&
              agent.acceptedVersion !== null &&
              version.version > agent.acceptedVersion;
            return (
              <li key={version.version}>
                <button
                  type="button"
                  className={`history-row ${version.version === selected ? 'is-on' : ''}`}
                  aria-pressed={version.version === selected}
                  onClick={() => choose(version.version)}
                >
                  <span>
                    <strong>v{version.version}</strong>{' '}
                    <span className="text-[color:var(--paper-dim)]">
                      · {authoredAs(version, who)}
                    </span>
                    {version.source === 'agent' && version.author ? (
                      <span className="text-[color:var(--paper-dim)]">
                        {' · '}
                        <span className="cosign">
                          cosigned by <span className="human">{who(version.author)}</span>
                        </span>
                      </span>
                    ) : null}
                  </span>
                  <span className="note">
                    {ago(version.createdAt)}
                    {version.note ? ` · “${version.note}”` : ''}
                    {version.status === 'declined' ? ' · a declined proposal (v1)' : ''}
                    {newer ? ' · newer than yours' : ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        {pages.hasNextPage ? (
          <button
            className="btn self-start"
            disabled={pages.isFetchingNextPage}
            onClick={() => void pages.fetchNextPage()}
          >
            Older versions
          </button>
        ) : null}

        <div className="flex flex-col gap-3 border-t border-[color:var(--line-soft)] pt-4">
          <VersionCompare
            name={`v${selected}`}
            isCurrent={isCurrent}
            shown={shown}
            onView={setView}
            hasPrevious={previousVersion > 0}
            currentLabel={isRecipientReview ? `Changes since v${selected}` : 'Compare with current'}
            loading={chosen.isLoading}
            changes={
              chosen.data && previous.data
                ? {
                    before: previous.data.prompt.body ?? '',
                    after: body,
                    beforeLabel: `v${previousVersion}`,
                    afterLabel: `v${selected}`,
                  }
                : null
            }
            current={
              chosen.data && current.data
                ? {
                    before: body,
                    after: current.data.prompt.body ?? '',
                    beforeLabel: `v${selected}`,
                    afterLabel: `v${current.data.prompt.version}, current`,
                  }
                : null
            }
            body={chosen.data ? body : null}
          />
          {canEditPrompt && !isCurrent && chosen.data ? (
            <button
              className="btn btn-accent self-start"
              disabled={restoring}
              onClick={() =>
                void (async () => {
                  setRestoring(true);
                  try {
                    const { prompt } = await api.agentRepo.savePrompt(agent.id, {
                      body,
                      basedOn: agent.promptVersion,
                      note: `Restored v${selected}`,
                    });
                    await invalidate();
                    notify(`Restored as v${prompt.version}`);
                    onClose();
                  } catch (error) {
                    notify(
                      error instanceof ApiError
                        ? error.status === 409
                          ? 'The prompt changed just now — reopen History and try again'
                          : error.message
                        : 'Could not restore it',
                      'error',
                    );
                    setRestoring(false);
                  }
                })()
              }
            >
              Restore as v{agent.promptVersion + 1}
            </button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
