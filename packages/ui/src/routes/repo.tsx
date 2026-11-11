/**
 * The Agent Repo index: every agent this person owns, has been shared, or has
 * archived — present at zero, where the empty screen draws the mental model
 * (docs/AGENT_REPO.md §V2.1): define it here, use it in your tool, it
 * remembers everywhere.
 *
 * Each row carries a bearing strip of when the agent's memory was written: an
 * agent that learned everything in one burst reads nothing like one learning
 * steadily, and that is a true thing about it rather than decoration.
 */
import { ConnectToolDialog } from '../components/repo-connect-tool';
import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, FileUp, Plus } from 'lucide-react';
import { HARNESSES, importAgentSchema, type RepoAgentDto } from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { accentStyle } from '../lib/theme';
import { queryKeys } from '../lib/session';
import { useDocumentTitle } from '../lib/title';
import { BearingStrip, Modal, Spinner, notify } from '../components/primitives';
import { QueryError } from '../components/query-error';
import { Select } from '../components/select';
import { AgentGlyph, Segmented, agentMeta } from '../components/repo-common';

type View = 'mine' | 'shared' | 'archived';
type Sort = 'used' | 'name' | 'changed';

const SORTS: ReadonlyArray<{ value: Sort; label: string }> = [
  { value: 'used', label: 'Recently used' },
  { value: 'name', label: 'Name' },
  { value: 'changed', label: 'Recently changed' },
];

function sortAgents(agents: RepoAgentDto[], sort: Sort): RepoAgentDto[] {
  const time = (iso: string | undefined) => (iso ? new Date(iso).getTime() : 0);
  return [...agents].sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name);
    if (sort === 'changed') return time(b.updatedAt) - time(a.updatedAt);
    return (
      time(b.lastSession?.startedAt) - time(a.lastSession?.startedAt) ||
      time(b.updatedAt) - time(a.updatedAt)
    );
  });
}

/** Waiting on this person: a share to accept, or an update to take. */
const waiting = (agent: RepoAgentDto) => agent.awaitingAccept || agent.updateAvailable;

export function AgentsRoute() {
  useDocumentTitle('Agents');
  const [view, setView] = useState<View>('mine');
  const [find, setFind] = useState('');
  const [sort, setSort] = useState<Sort>('used');
  const [importing, setImporting] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const query = useQuery({
    queryKey: [...queryKeys.repoAgents, view],
    queryFn: () => api.agentRepo.list({ view }),
  });
  // For the count on the Shared tab, whichever tab is showing.
  const shared = useQuery({
    queryKey: [...queryKeys.repoAgents, 'shared'],
    queryFn: () => api.agentRepo.list({ view: 'shared' }),
  });
  const pending = (shared.data?.agents ?? []).filter(waiting).length;
  const agents = useMemo(() => {
    const needle = find.trim().toLowerCase();
    const all = query.data?.agents ?? [];
    const found = needle
      ? all.filter((agent) =>
          [agent.name, agent.handle, agent.description].some((text) =>
            text.toLowerCase().includes(needle),
          ),
        )
      : all;
    return sortAgents(found, sort);
  }, [query.data, find, sort]);
  const total = query.data?.agents.length ?? 0;

  return (
    <div className="repo-page">
      <header className="repo-head">
        <h1 className="repo-title">Agents</h1>
        <button
          className="btn btn-accent min-h-11"
          aria-label="Connect a tool"
          onClick={() => setConnecting(true)}
        >
          Connect a tool
        </button>
        <button className="btn" onClick={() => setImporting(true)}>
          <FileUp className="h-4 w-4" />
          Import
        </button>
        <Link to="/repo/new" className="btn">
          <Plus className="h-4 w-4" />
          New agent
        </Link>
      </header>
      <p className="note text-[14px]">
        An agent lives here — a name, a prompt, a memory. Your tools run it.{' '}
        <button className="link-button accent-text" onClick={() => setExplaining(true)}>
          How it works
        </button>
      </p>

      <div className="repo-filters">
        <Segmented
          label="Which agents"
          value={view}
          onChange={setView}
          options={[
            { value: 'mine', label: 'Mine' },
            {
              value: 'shared',
              label: (
                <>
                  Shared with me
                  {pending > 0 ? (
                    <span className="token is-accent ml-1.5" aria-label={`${pending} waiting`}>
                      {pending}
                    </span>
                  ) : null}
                </>
              ),
            },
            { value: 'archived', label: 'Archived' },
          ]}
        />
        <input
          className="field repo-find"
          type="search"
          aria-label="Find an agent"
          placeholder="Find an agent"
          value={find}
          onChange={(event) => setFind(event.target.value)}
        />
        <Select
          aria-label="Sort"
          className="repo-sort"
          value={sort}
          options={SORTS}
          onValueChange={(value) => {
            const found = SORTS.find((option) => option.value === value);
            if (found) setSort(found.value);
          }}
        />
      </div>

      {query.isLoading ? <Spinner label="Reading your agents" /> : null}
      {query.error ? (
        <QueryError error={query.error} resource="Your agents" retry={() => query.refetch()} />
      ) : null}

      {!query.isLoading && !query.error && total === 0 ? (
        view === 'mine' ? (
          <HowItWorks
            actions={
              <>
                <Link to="/repo/new" className="btn btn-accent">
                  New agent
                </Link>
                <button className="btn" onClick={() => setImporting(true)}>
                  Import from Claude Code
                </button>
              </>
            }
          />
        ) : (
          <p className="repo-empty note">
            {view === 'shared'
              ? 'Nothing shared with you yet. When someone shares an agent, it appears here.'
              : 'Nothing archived.'}
          </p>
        )
      ) : null}
      {total > 0 && agents.length === 0 ? (
        <p className="repo-empty note">No agent matches “{find.trim()}”.</p>
      ) : null}

      {agents.length > 0 ? (
        <ul className="repo-rows">
          {agents.map((agent) => (
            <li key={agent.id} style={accentStyle(agent.accent ?? undefined)}>
              <Link to="/repo/$agentId" params={{ agentId: agent.id }} className="repo-row">
                <AgentGlyph name={agent.name} />
                <span className="min-w-0">
                  <span className="repo-row-name">{agent.name}</span>
                  <span className="repo-row-meta">{agentMeta(agent)}</span>
                  <BearingStrip timestamps={agent.memoryActivity} />
                </span>
                <span className="repo-row-end">
                  {agent.awaitingAccept ? (
                    <span className="token is-accent">Waiting for you</span>
                  ) : null}
                  {agent.updateAvailable && !agent.awaitingAccept ? (
                    <span className="token is-accent">Update available</span>
                  ) : null}
                  <span className="repo-row-tools">
                    {agent.profiles
                      .filter((p) => p.harness !== 'default')
                      .slice(0, 4)
                      .map((p) => (
                        <span key={p.harness} className="tool-chip">
                          {p.harness === 'default' ? 'Default' : HARNESSES[p.harness].short}
                        </span>
                      ))}
                    {agent.profiles.filter((p) => p.harness !== 'default').length > 4 ? (
                      <span className="tool-chip">
                        +{agent.profiles.filter((p) => p.harness !== 'default').length - 4}
                      </span>
                    ) : null}
                  </span>
                  <ChevronRight
                    className="h-4 w-4 text-[color:var(--paper-faint)]"
                    aria-hidden="true"
                  />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      {importing ? <ImportDialog onClose={() => setImporting(false)} /> : null}
      {connecting ? <ConnectToolDialog onClose={() => setConnecting(false)} /> : null}
      {explaining ? (
        <Modal title="How agents work" size="lg" onClose={() => setExplaining(false)}>
          <HowItWorks />
        </Modal>
      ) : null}
    </div>
  );
}

/** The mental model, drawn: three steps, one sentence each. */
function HowItWorks({ actions }: { actions?: ReactNode }) {
  const steps = [
    ['Define it here', 'A name, a prompt, a memory.'],
    ['Use it in your tool', 'Claude Code, Codex, Cursor, Claude — any of them.'],
    ['It remembers everywhere', 'What it learns is saved here, never on one machine.'],
  ] as const;
  return (
    <div className="how-it-works">
      <ol className="how-steps">
        {steps.map(([title, text], index) => (
          <li key={title} className="how-step panel">
            <span className="use-step-number" aria-hidden="true">
              {index + 1}
            </span>
            <strong>{title}</strong>
            <span className="note">{text}</span>
          </li>
        ))}
      </ol>
      {actions ? <div className="flex flex-wrap justify-center gap-2">{actions}</div> : null}
    </div>
  );
}

/**
 * Two ways in: a bundle from Export (dropped as a file or pasted), or the
 * command that reads Claude Code's own agents from this machine.
 */
function ImportDialog({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [how, setHow] = useState<'file' | 'claude'>('file');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  let problem: string | null = null;
  let parsed: ReturnType<typeof importAgentSchema.safeParse> | null = null;
  if (text.trim()) {
    try {
      parsed = importAgentSchema.safeParse(JSON.parse(text));
      if (!parsed.success) problem = parsed.error.issues[0]?.message ?? 'Not an agent bundle';
    } catch {
      problem = 'That is not valid JSON.';
    }
  }
  const command = `OMR_MCP_URL=${window.location.origin}/mcp OMR_TOKEN=omr_pat_… \\\n  pnpm --filter @onmyradar/server exec tsx scripts/import-claude-agents.ts --dry-run`;

  return (
    <Modal
      title="Import"
      size="lg"
      onClose={onClose}
      footer={
        how === 'file' ? (
          <>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn btn-accent"
              disabled={busy || !parsed?.success}
              onClick={() =>
                void (async () => {
                  if (!parsed?.success) return;
                  setBusy(true);
                  try {
                    const { agent } = await api.agentRepo.import(parsed.data);
                    await client.invalidateQueries({ queryKey: queryKeys.repoAgents });
                    notify(`${agent.name} imported`);
                    onClose();
                    void navigate({ to: '/repo/$agentId', params: { agentId: agent.id } });
                  } catch (err) {
                    notify(err instanceof ApiError ? err.message : 'Could not import it', 'error');
                    setBusy(false);
                  }
                })()
              }
            >
              Import
            </button>
          </>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3">
        <Segmented
          label="Import from"
          value={how}
          onChange={setHow}
          options={[
            { value: 'file', label: 'From a file' },
            { value: 'claude', label: 'From Claude Code' },
          ]}
        />
        {how === 'file' ? (
          <>
            <label
              className="import-drop"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const file = event.dataTransfer.files[0];
                if (file) void file.text().then(setText);
              }}
            >
              <span className="note">Drop an export here, or choose one</span>
              <input
                type="file"
                accept=".json,application/json"
                className="note"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void file.text().then(setText);
                }}
              />
            </label>
            <textarea
              className="field min-h-[180px] font-mono text-[12.5px]"
              aria-label="Or paste the export"
              value={text}
              placeholder='Or paste it: {"name": "Architect", "prompt": "…", "memories": […]}'
              onChange={(event) => setText(event.target.value)}
            />
            {problem ? <p className="note text-[color:var(--danger)]">{problem}</p> : null}
            {parsed?.success ? (
              <p className="instrument">
                {parsed.data.name} · {parsed.data.memories.length} memories
                {parsed.data.prompt ? ' · a prompt' : ''}
                {parsed.data.profiles
                  ? ` · ${Object.keys(parsed.data.profiles).length} profiles`
                  : ''}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <p className="note">
              Run this once on the machine where your Claude Code agents live. It reads
              <code className="font-mono"> ~/.claude/agents</code> and each agent’s memory folder
              and imports them here — nothing on the machine is changed. Drop{' '}
              <code className="font-mono">--dry-run</code> when the list looks right.
            </p>
            <div className="snippet">
              <pre>{command}</pre>
            </div>
            <p className="note">
              Each agent’s Claude Code settings become its Claude Code profile. Anything the
              importer cannot carry is listed rather than silently dropped.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}
