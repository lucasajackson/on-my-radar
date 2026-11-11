/**
 * One agent: the header every tab shares — glyph, name, who it belongs to, the
 * bearing strip of its memory, and the three actions (Use in…, Share, ⋯) — then
 * the tabs, Prompt · Briefs · Tools · Memory · Activity · Settings, each its own
 * route.
 *
 * The agent's accent is set on this page's container, never on :root. The
 * name, the description and everything people and agents wrote are set in the
 * reading serif; the chrome is the instrument voice.
 *
 * Use-in and Share are dialogs addressed by the URL (`?use=codex`,
 * `?share=1`), so "use this agent in Codex" is a link somebody can send.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Link,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
  useRouter,
  useSearch,
} from '@tanstack/react-router';
import { ArrowLeft, MoreHorizontal } from 'lucide-react';
import { HARNESSES, resolveHarness, type Harness } from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { accentStyle } from '../lib/theme';
import { queryKeys } from '../lib/session';
import { useDocumentTitle } from '../lib/title';
import { BearingStrip, Empty, Modal, Spinner, notify } from '../components/primitives';
import { QueryError } from '../components/query-error';
import { Select } from '../components/select';
import {
  AgentGlyph,
  Switch,
  agentMeta,
  personName,
  presetLabel,
  toolOptions,
  useInvalidateAgent,
} from '../components/repo-common';
import { AgentPageContext, useAgentPage, type AgentPage } from '../components/repo-context';
import { transferLine, useManage } from '../components/repo-manage';
import { UseInDialog } from '../components/repo-use-in';
import { ShareDialog } from '../components/repo-share';

const TABS = [
  { to: '/repo/$agentId', label: 'Prompt', exact: true },
  { to: '/repo/$agentId/briefs', label: 'Briefs', exact: false },
  { to: '/repo/$agentId/tools', label: 'Tools', exact: false },
  { to: '/repo/$agentId/memory', label: 'Memory', exact: false },
  { to: '/repo/$agentId/activity', label: 'Activity', exact: false },
  { to: '/repo/$agentId/settings', label: 'Settings', exact: false },
] as const;

export function AgentLayoutRoute() {
  const { agentId } = useParams({ from: '/_app/repo/$agentId' });
  const search = useSearch({ from: '/_app/repo/$agentId' });
  const navigate = useNavigate();
  const router = useRouter();
  const location = useLocation();
  const query = useQuery({
    queryKey: queryKeys.repoAgent(agentId),
    queryFn: () => api.agentRepo.get(agentId),
  });
  const agent = query.data?.agent;
  useDocumentTitle(agent?.name);

  /*
    One address per agent. The API answers to a slug as well as an id, but
    this page's cache is keyed on what is in the URL and every edit
    invalidates by id — so a slug address is rewritten to the id, keeping the
    tab and the query string.
  */
  useEffect(() => {
    if (agent && agent.id !== agentId) {
      router.history.replace(
        `${location.pathname.replace(`/repo/${agentId}`, `/repo/${agent.id}`)}${location.searchStr}`,
      );
    }
  }, [agent, agentId, location.pathname, location.searchStr, router.history]);

  const setDialog = useCallback(
    (next: { use?: Harness; share?: true }) =>
      void navigate({
        to: '.',
        search: (previous) => {
          const rest = { ...previous };
          delete rest['use'];
          delete rest['share'];
          return { ...rest, ...next };
        },
      }),
    [navigate],
  );

  const page = useMemo<AgentPage | null>(
    () =>
      agent
        ? {
            agent,
            useIn: (harness) => setDialog({ use: harness }),
            canEditPrompt: agent.access.prompt === 'edit' && !agent.awaitingAccept,
          }
        : null,
    [agent, setDialog],
  );

  const useIn = resolveHarness(search.use);

  if (query.isLoading) return <Spinner label="Reading the agent" />;
  if (query.error)
    return (
      <div className="mx-auto max-w-[760px] px-4 py-5">
        <QueryError error={query.error} resource="This agent" retry={() => query.refetch()} />
      </div>
    );
  if (!agent || !page)
    return (
      <Empty title="Agent not found" hint="It may have been deleted, or not shared with you." />
    );

  return (
    <AgentPageContext.Provider value={page}>
      <div className="agent-page" style={accentStyle(agent.accent ?? undefined)}>
        <Link to="/repo" className="btn btn-ghost agent-back hidden lg:inline-flex">
          <ArrowLeft className="h-4 w-4" />
          Agents
        </Link>
        <Banners />
        <AgentHeader
          onUse={(harness) => setDialog({ use: harness })}
          onShare={() => setDialog({ share: true })}
        />
        <nav className="agent-tabs scroll-area" aria-label="Agent sections">
          {TABS.map((tab) => (
            <Link
              key={tab.to}
              to={tab.to}
              params={{ agentId: agent.id }}
              className="agent-tab"
              activeOptions={{ exact: tab.exact, includeSearch: false }}
              activeProps={{ className: 'is-active', 'aria-current': 'page' }}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
        <div className="agent-pane">
          <Outlet />
        </div>
        {useIn ? (
          <UseInDialog
            key={`${agent.id}-${useIn}`}
            agent={agent}
            harness={useIn}
            onHarness={(harness) => setDialog({ use: harness })}
            onClose={() => setDialog({})}
          />
        ) : null}
        {search.share && agent.access.canManage ? (
          <ShareDialog agent={agent} onClose={() => setDialog({})} />
        ) : null}
      </div>
    </AgentPageContext.Provider>
  );
}

function AgentHeader({
  onUse,
  onShare,
}: {
  onUse: (harness: Harness) => void;
  onShare: () => void;
}) {
  const { agent } = useAgentPage();
  const [more, setMore] = useState(false);
  const manage = useManage(agent);
  const profiled = new Set(agent.profiles.map((p) => p.harness));
  // The agent's primary tool first, then the rest in the registry's order.
  const order = (Object.keys(HARNESSES) as Harness[]).sort(
    (a, b) => Number(b === agent.primaryHarness) - Number(a === agent.primaryHarness),
  );
  const tools = toolOptions(order).map((option) => ({
    ...option,
    description: `${option.description}${profiled.has(option.value) ? ' · has a profile' : ''}`,
  }));
  const [expanded, setExpanded] = useState(false);
  const blocked = agent.awaitingAccept || agent.archived;

  return (
    <header className="agent-head">
      <AgentGlyph name={agent.name} size="lg" />
      <div className="min-w-0">
        <h1 className="agent-name">{agent.name}</h1>
        <p className="agent-meta">{agentMeta(agent, { page: true })}</p>
        {agent.description ? (
          <p className={`agent-description ${expanded ? '' : 'is-clamped'}`}>
            {agent.description}
            {agent.description.length > 180 ? (
              <button
                type="button"
                className="agent-more-link"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? 'Less' : 'More'}
              </button>
            ) : null}
          </p>
        ) : null}
        <BearingStrip timestamps={agent.memoryActivity} />
      </div>
      <div className="agent-actions">
        <Select
          tone="primary"
          className="min-h-11"
          aria-label="Connect a tool"
          value=""
          placeholder="Connect a tool…"
          disabled={blocked}
          options={tools}
          onValueChange={(value) => {
            const harness = tools.find((tool) => tool.value === value)?.value;
            if (harness) onUse(harness);
          }}
        />
        {agent.access.canManage ? (
          <button className="btn" onClick={onShare}>
            Share
          </button>
        ) : null}
        <button className="btn" aria-label="More actions" onClick={() => setMore(true)}>
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </div>
      {more ? (
        <Modal title="More" size="sm" onClose={() => setMore(false)}>
          <div className="flex flex-col gap-2">
            <button
              className="btn justify-start"
              onClick={() => {
                setMore(false);
                manage.exportAgent();
              }}
            >
              Export
            </button>
            <button
              className="btn justify-start"
              onClick={() => {
                setMore(false);
                manage.duplicate();
              }}
            >
              Duplicate
            </button>
            {agent.access.canManage ? (
              <>
                <button
                  className="btn justify-start"
                  onClick={() => {
                    setMore(false);
                    manage.transfer();
                  }}
                >
                  Transfer ownership…
                </button>
                <button
                  className="btn justify-start"
                  onClick={() => {
                    setMore(false);
                    manage.archive();
                  }}
                >
                  {agent.archived ? 'Unarchive' : 'Archive'}
                </button>
                <button
                  className="btn btn-danger-quiet justify-start"
                  onClick={() => {
                    setMore(false);
                    manage.remove();
                  }}
                >
                  Delete…
                </button>
              </>
            ) : null}
          </div>
        </Modal>
      ) : null}
      {manage.dialog}
    </header>
  );
}

/**
 * The bars above the header, for what is waiting on this person: a share to
 * accept, an update to take, a transfer to answer, or an archived agent.
 */
function Banners() {
  const { agent } = useAgentPage();
  const invalidate = useInvalidateAgent(agent.id);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const act = (work: () => Promise<unknown>, done: string, fallback: string) =>
    void (async () => {
      setBusy(true);
      try {
        await work();
        await invalidate();
        notify(done);
      } catch (error) {
        notify(error instanceof ApiError ? error.message : fallback, 'error');
      } finally {
        setBusy(false);
      }
    })();
  const owner = personName(agent.owner);
  const transfer = transferLine(agent);
  const promptMoved = agent.acceptedVersion !== null && agent.promptVersion > agent.acceptedVersion;

  return (
    <>
      {agent.awaitingAccept ? (
        <div className="agent-banner is-accent" role="status">
          <span>
            <strong>{owner}</strong> shared this agent with you · {presetLabel(agent.sharedPreset)}.
            Read the prompt first — it runs as instructions in your own tools.
          </span>
          <span className="agent-banner-actions">
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                void (async () => {
                  setBusy(true);
                  try {
                    await api.agentRepo.leave(agent.id);
                    await invalidate();
                    notify('Declined');
                    void navigate({ to: '/repo' });
                  } catch (error) {
                    notify(
                      error instanceof ApiError ? error.message : 'Could not decline',
                      'error',
                    );
                    setBusy(false);
                  }
                })()
              }
            >
              Decline
            </button>
            <button
              className="btn btn-accent"
              disabled={busy}
              onClick={() =>
                act(
                  () => api.agentRepo.accept(agent.id),
                  `Accepted — you run v${agent.promptVersion} until you update`,
                  'Could not accept',
                )
              }
            >
              Accept
            </button>
          </span>
        </div>
      ) : null}

      {agent.updateAvailable && !agent.awaitingAccept ? (
        <div className="agent-banner is-accent" role="status">
          <span>
            {promptMoved ? (
              <>
                <strong>{owner}</strong> updated this agent ·{' '}
                <strong>
                  v{agent.acceptedVersion ?? '?'} → v{agent.promptVersion}
                </strong>
                {agent.briefsUpdated ? ', and its briefs' : ''}
              </>
            ) : (
              <>
                <strong>{owner}</strong> updated this agent’s briefs
              </>
            )}
          </span>
          <span className="agent-banner-actions">
            <label className="agent-banner-follow">
              <Switch
                label="Follow updates"
                checked={agent.followUpdates}
                disabled={busy}
                onChange={(follow) =>
                  act(
                    () => api.agentRepo.setFollow(agent.id, follow),
                    follow ? 'You now run every new version' : 'You choose when to update',
                    'Could not change that',
                  )
                }
              />
              <span className="note">Follow updates</span>
            </label>
            {promptMoved && agent.acceptedVersion ? (
              <Link
                className="btn"
                to="/repo/$agentId"
                params={{ agentId: agent.id }}
                search={{ history: agent.acceptedVersion }}
              >
                Review changes
              </Link>
            ) : null}
            {agent.briefsUpdated ? (
              <Link className="btn" to="/repo/$agentId/briefs" params={{ agentId: agent.id }}>
                Review briefs
              </Link>
            ) : null}
            <button
              className="btn btn-accent"
              disabled={busy}
              onClick={() =>
                act(
                  () => api.agentRepo.takeUpdate(agent.id),
                  `Updated — you run v${agent.promptVersion}`,
                  'Could not update',
                )
              }
            >
              Update
            </button>
          </span>
        </div>
      ) : null}

      {agent.pendingTransfer ? (
        <div className="agent-banner" role="status">
          <span>{transfer}</span>
          <span className="agent-banner-actions">
            {agent.pendingTransfer.direction === 'in' ? (
              <>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    act(
                      () => api.agentRepo.declineTransfer(agent.id),
                      'Declined',
                      'Could not decline',
                    )
                  }
                >
                  Decline
                </button>
                <button
                  className="btn btn-accent"
                  disabled={busy}
                  onClick={() =>
                    act(
                      () => api.agentRepo.acceptTransfer(agent.id),
                      `${agent.name} is yours now`,
                      'Could not accept',
                    )
                  }
                >
                  Accept
                </button>
              </>
            ) : (
              <button
                className="btn"
                disabled={busy}
                onClick={() =>
                  act(
                    () => api.agentRepo.cancelTransfer(agent.id),
                    'Transfer cancelled',
                    'Could not cancel',
                  )
                }
              >
                Cancel transfer
              </button>
            )}
          </span>
        </div>
      ) : null}

      {agent.archived ? (
        <div className="agent-banner" role="status">
          <span>Archived — it no longer loads anywhere. Its name stays on what it wrote.</span>
          {agent.access.canManage ? (
            <span className="agent-banner-actions">
              <button
                className="btn"
                disabled={busy}
                onClick={() =>
                  act(
                    () => api.agentRepo.setArchived(agent.id, false),
                    `${agent.name} is back`,
                    'Could not unarchive',
                  )
                }
              >
                Unarchive
              </button>
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
