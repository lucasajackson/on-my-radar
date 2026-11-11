/**
 * Admin → Agents: every agent and every live credential, and the revoke.
 *
 * Metadata only. Who owns an agent, whether it is limited to chosen radars and how many,
 * which credentials are live and when each was last used: never a prompt, a memory, a radar's
 * name, or any part of a token. An admin runs people and settings; the owner's content is the
 * owner's. Revoking is a decision made here, in a browser, and cannot be done over a token.
 */
import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminAgentDto, AdminTokenDto } from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { relativeTime } from '../lib/format';
import { queryKeys, useSession } from '../lib/session';
import { ConfirmDialog, Empty, Spinner, notify } from '../components/primitives';
import { QueryError } from '../components/query-error';
import { useDocumentTitle } from '../lib/title';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

type Revoking = { kind: 'agent'; agent: AdminAgentDto } | { kind: 'token'; token: AdminTokenDto };

/** A search box that tells its parent once typing has paused. */
function SearchBox({ label, onSearch }: { label: string; onSearch: (q: string) => void }) {
  const [text, setText] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => onSearch(text.trim()), 250);
    return () => clearTimeout(timer);
  }, [text, onSearch]);
  return (
    <input
      type="search"
      className="input max-w-sm"
      placeholder={label}
      aria-label={label}
      value={text}
      onChange={(event) => setText(event.target.value)}
    />
  );
}

/** "Showing 100 of 1,204", so a list that stops short says so. */
function Showing({ shown, total, what }: { shown: number; total: number; what: string }) {
  return (
    <p className="instrument" role="status">
      Showing {shown.toLocaleString()} of {total.toLocaleString()} {what}
    </p>
  );
}

function MoreButton({
  hasMore,
  loading,
  onMore,
}: {
  hasMore: boolean;
  loading: boolean;
  onMore: () => void;
}) {
  if (!hasMore) return null;
  return (
    <button className="btn self-start" disabled={loading} onClick={onMore}>
      {loading ? 'Loading…' : 'Show more'}
    </button>
  );
}

/** What revoking an agent also does, in words: connections that ran it carry its limit. */
function revokeAgentBody(agent: AdminAgentDto): string {
  const lines = [
    'Every token and connected app made for this agent stops working now, and its open sessions end. Its owner can connect it again.',
  ];
  if (agent.fencedConnections > 0)
    lines.push(
      `This also disconnects ${plural(agent.fencedConnections, 'connection', 'connections')} that ran this agent, because each carries its radar limit and must not be left wider than it was.`,
    );
  return lines.join(' ');
}

export function AdminAgentsRoute() {
  useDocumentTitle('Agents · Admin');
  const { user } = useSession();
  const client = useQueryClient();
  const enabled = Boolean(user?.isAdmin);
  const [agentSearch, setAgentSearch] = useState('');
  const [tokenSearch, setTokenSearch] = useState('');
  const agents = useInfiniteQuery({
    queryKey: [...queryKeys.adminAgents, agentSearch],
    queryFn: ({ pageParam }) =>
      api.admin.agents({
        ...(agentSearch ? { q: agentSearch } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled,
  });
  const tokens = useInfiniteQuery({
    queryKey: [...queryKeys.adminTokens, tokenSearch],
    queryFn: ({ pageParam }) =>
      api.admin.tokens({
        ...(tokenSearch ? { q: tokenSearch } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled,
  });
  const agentRows = agents.data?.pages.flatMap((page) => page.agents) ?? [];
  const tokenRows = tokens.data?.pages.flatMap((page) => page.tokens) ?? [];
  const [revoking, setRevoking] = useState<Revoking | null>(null);
  const [busy, setBusy] = useState(false);

  if (!user?.isAdmin) {
    return <Empty title="Admins only" hint="This screen is for account administrators." />;
  }

  const revoke = async () => {
    if (!revoking) return;
    setBusy(true);
    try {
      if (revoking.kind === 'agent') await api.admin.revokeAgent(revoking.agent.id);
      else await api.admin.revokeToken(revoking.token);
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.adminAgents }),
        client.invalidateQueries({ queryKey: queryKeys.adminTokens }),
      ]);
      notify('Revoked');
      setRevoking(null);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not revoke it', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h2 className="text-[17px] font-semibold tracking-tight">Agents and connections</h2>
        <p className="mt-1 text-[13.5px] text-[color:var(--paper-dim)]">
          What is connected to this instance and what each agent may reach. You see who and how
          much, never what they wrote or which radars. Revoking cuts the credentials off at once;
          the agent and its owner’s radars stay.
        </p>
      </header>

      <section className="flex flex-col gap-2.5">
        <h3 className="instrument">Agents</h3>
        <SearchBox label="Search agents by name, handle or owner" onSearch={setAgentSearch} />
        {agents.isLoading ? (
          <Spinner label="Loading agents" />
        ) : agents.error ? (
          <QueryError error={agents.error} resource="Agents" retry={() => agents.refetch()} />
        ) : agentRows.length === 0 ? (
          <Empty
            title={agentSearch ? 'No agent matches' : 'No agents yet'}
            hint={
              agentSearch
                ? 'Try a name, a handle or an owner’s email.'
                : 'Agents people create will be listed here.'
            }
          />
        ) : (
          <>
            <ul className="panel divide-y divide-[color:var(--line-soft)]">
              {agentRows.map((agent) => (
                <li key={agent.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px]">
                      {agent.name} <span className="instrument">@{agent.handle}</span>
                      {agent.archived ? <span className="instrument ml-2">archived</span> : null}
                    </div>
                    <div className="instrument truncate">
                      {agent.owner.name ?? agent.owner.email} ·{' '}
                      {agent.radarScope === 'selected'
                        ? `limited to ${plural(agent.radarGrantCount, 'radar', 'radars')}`
                        : 'all radars'}{' '}
                      · {plural(agent.liveTokens, 'token', 'tokens')},{' '}
                      {plural(agent.liveGrants, 'connected app', 'connected apps')},{' '}
                      {plural(agent.liveSessions, 'open session', 'open sessions')}
                      {agent.fencedConnections > 0
                        ? `, ${plural(agent.fencedConnections, 'connection', 'connections')} that ran it`
                        : ''}{' '}
                      · {agent.lastUsedAt ? `used ${relativeTime(agent.lastUsedAt)}` : 'never used'}
                    </div>
                  </div>
                  <button
                    className="btn"
                    disabled={
                      agent.liveTokens +
                        agent.liveGrants +
                        agent.liveSessions +
                        agent.fencedConnections ===
                      0
                    }
                    onClick={() => setRevoking({ kind: 'agent', agent })}
                  >
                    Revoke all
                  </button>
                </li>
              ))}
            </ul>
            <Showing
              shown={agentRows.length}
              total={agents.data?.pages[0]?.total ?? agentRows.length}
              what="agents"
            />
            <MoreButton
              hasMore={agents.hasNextPage}
              loading={agents.isFetchingNextPage}
              onMore={() => void agents.fetchNextPage()}
            />
          </>
        )}
      </section>

      <section className="flex flex-col gap-2.5">
        <h3 className="instrument">Live credentials</h3>
        <SearchBox label="Search credentials by name, owner or agent" onSearch={setTokenSearch} />
        {tokens.isLoading ? (
          <Spinner label="Loading credentials" />
        ) : tokens.error ? (
          <QueryError error={tokens.error} resource="Credentials" retry={() => tokens.refetch()} />
        ) : tokenRows.length === 0 ? (
          <Empty
            title={tokenSearch ? 'No credential matches' : 'Nothing connected'}
            hint={
              tokenSearch
                ? 'Try a name, an owner’s email or an agent.'
                : 'Tokens and connected apps will be listed here.'
            }
          />
        ) : (
          <>
            <ul className="panel divide-y divide-[color:var(--line-soft)]">
              {tokenRows.map((token) => (
                <li
                  key={`${token.kind}:${token.owner.id}:${token.id}`}
                  className="flex flex-wrap items-center gap-3 px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px]">
                      {token.name}{' '}
                      <span className="instrument">
                        {token.kind === 'pat' ? 'token' : 'connected app'}
                      </span>
                    </div>
                    <div className="instrument truncate">
                      {token.owner.name ?? token.owner.email}
                      {token.agent ? ` · as @${token.agent.handle}` : ''} ·{' '}
                      {token.lastUsedAt ? `used ${relativeTime(token.lastUsedAt)}` : 'never used'}
                    </div>
                  </div>
                  <button className="btn" onClick={() => setRevoking({ kind: 'token', token })}>
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
            <Showing
              shown={tokenRows.length}
              total={tokens.data?.pages[0]?.total ?? tokenRows.length}
              what="credentials"
            />
            <MoreButton
              hasMore={tokens.hasNextPage}
              loading={tokens.isFetchingNextPage}
              onMore={() => void tokens.fetchNextPage()}
            />
          </>
        )}
      </section>

      {revoking ? (
        <ConfirmDialog
          title={
            revoking.kind === 'agent'
              ? `Revoke everything for ${revoking.agent.name}?`
              : `Revoke ${revoking.token.name}?`
          }
          body={
            revoking.kind === 'agent'
              ? revokeAgentBody(revoking.agent)
              : revoking.token.kind === 'oauth'
                ? `This disconnects the app from ${revoking.token.owner.email} entirely, every chat that uses it.`
                : 'The machine using this token stops reaching On My Radar at once.'
          }
          confirmLabel="Revoke"
          danger
          busy={busy}
          onClose={() => setRevoking(null)}
          onConfirm={() => void revoke()}
        />
      ) : null}
    </div>
  );
}
