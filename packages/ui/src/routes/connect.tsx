import { Select } from '../components/select';
import { QueryError } from '../components/query-error';
/**
 * The MCP consent screen.
 *
 * An agent asking for access to somebody's private thinking should have to say
 * so out loud. This is the only place an OAuth authorization code is minted, and
 * it is never auto-approved.
 *
 * The list below is derived from the scopes the request actually carries, not
 * written by hand. It used to be three fixed sentences describing full access,
 * which was true only by accident: the scope a client asked for was recorded and
 * then ignored, so a client asking for read-only got everything and the screen
 * happened to describe what it got. Now the same `parseScopes` the server writes
 * the grant with decides what is listed here, so the screen cannot say one thing
 * while the grant says another.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Bot, ShieldCheck } from 'lucide-react';
import {
  OAUTH_DEFAULT_SCOPES,
  parseScopes,
  SCOPE_COPY,
  VOICE_COPY,
  type TokenScope,
  type Voice,
} from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { useSession } from '../lib/session';
import { Empty, Mark, Spinner, notify } from '../components/primitives';
import { useDocumentTitle } from '../lib/title';

export interface ConnectSearch {
  client_id?: string;
  redirect_uri?: string;
  response_type?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  state?: string;
  scope?: string;
}

const CONNECT_KEYS = [
  'client_id',
  'redirect_uri',
  'response_type',
  'code_challenge',
  'code_challenge_method',
  'state',
  'scope',
] as const;

/**
 * The authorization request, read from the raw query string.
 *
 * Not from the router: its search parser runs every value through
 * `JSON.parse`, so `state=12345` arrived as a number (and the decision endpoint
 * refused it with a 400), and `state=1e3` or `state=1.50` arrived as a
 * *different string* after the round trip, which fails the client's own CSRF
 * check on the way back. `state` is the client's opaque value and has to be
 * returned byte for byte; nothing here may interpret it.
 */
export function readConnectSearch(searchStr: string): ConnectSearch {
  const params = new URLSearchParams(searchStr);
  const out: ConnectSearch = {};
  for (const key of CONNECT_KEYS) {
    const value = params.get(key);
    if (value !== null) out[key] = value;
  }
  return out;
}

export function ConnectRoute() {
  useDocumentTitle('Connect an agent');
  const searchStr = useLocation({ select: (location) => location.searchStr });
  const search = useMemo(() => readConnectSearch(searchStr), [searchStr]);
  const { user, loading } = useSession();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [agentId, setAgentId] = useState('');
  const [alsoAsMe, setAlsoAsMe] = useState(false);
  // Unticked, always: even a client that asks for it must be allowed by the person.
  const [manage, setManage] = useState(false);
  const redirected = useRef(false);

  const clientQuery = useQuery({
    queryKey: ['oauth-client', search.client_id],
    queryFn: () => api.oauth.client(search.client_id ?? ''),
    enabled: Boolean(search.client_id && user),
    retry: false,
  });

  // The session query is null while it is still in flight. Treating that as
  // "signed out" bounced the user to /login *without* the OAuth parameters;
  // login then saw an active session and sent them to the dashboard. That is
  // what made connecting an agent look like an ordinary sign-in that simply
  // ended in the app, with no consent screen and nothing returned to the client.
  // In an effect, not during render: navigating from render is a side effect
  // React may run twice, and the ref was only ever papering over that.
  useEffect(() => {
    if (loading || user || redirected.current) return;
    redirected.current = true;
    // Carry the whole request through the sign-in so the handshake survives it.
    const here = `${window.location.pathname}${window.location.search}`;
    void navigate({ to: '/login', search: { next: here }, replace: true });
  }, [loading, user, navigate]);

  if (loading) return <Spinner label="Checking your session" />;
  if (!user) return <Spinner label="Taking you to sign in" />;
  if (!search.client_id || !search.redirect_uri || !search.code_challenge) {
    return (
      <div className="mx-auto max-w-[600px] px-5 py-16">
        <Empty
          title="Incomplete connection request"
          hint="This link is missing details the connection needs. Start again from your agent."
        />
      </div>
    );
  }
  if (clientQuery.error)
    return (
      <QueryError
        error={clientQuery.error}
        resource="Connection request"
        retry={() => clientQuery.refetch()}
      />
    );
  if (clientQuery.isLoading) return <Spinner label="Checking the client" />;

  // Absent means read and write, matching the server's own default; manage is the box below,
  // whatever the client asked. A request naming nothing this server grants never reaches this
  // screen (/oauth/authorize sends it to /connect/error), so an empty list is the absent case.
  const access = parseScopes(search.scope).filter((scope) => scope !== 'radars:manage');
  const base = access.length > 0 ? access : OAUTH_DEFAULT_SCOPES;
  const granted: readonly TokenScope[] = manage ? [...base, 'radars:manage'] : base;

  const decide = async (approve: boolean) => {
    setBusy(true);
    try {
      if (!search.client_id || !search.redirect_uri || !search.code_challenge) return;
      const { redirectTo } = await api.oauth.decide({
        client_id: search.client_id,
        redirect_uri: search.redirect_uri,
        response_type: 'code',
        code_challenge: search.code_challenge,
        code_challenge_method: search.code_challenge_method ?? 'S256',
        state: search.state,
        scope: granted.join(' '),
        approve,
        // The agent and the voices are the *person's* choice, made here, in
        // front of the client's name. A client cannot ask for either: it has no
        // way to know an agent exists until somebody picks one for it.
        ...(agentId
          ? {
              agentId,
              voices: alsoAsMe ? (['persona', 'principal'] as Voice[]) : (['persona'] as Voice[]),
            }
          : {}),
      });
      window.location.href = redirectTo;
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not complete that request', 'error');
      setBusy(false);
    }
  };

  // Archived agents resolve no handle and load nowhere; they are not a choice.
  const agents = (clientQuery.data?.agents ?? []).filter((agent) => !agent.retired);

  const host = (() => {
    try {
      return new URL(search.redirect_uri ?? '').host;
    } catch {
      return search.redirect_uri ?? '';
    }
  })();

  return (
    <div className="flex min-h-full items-center justify-center px-5 py-12">
      <div className="panel w-full max-w-[440px] p-6">
        <div className="flex items-center gap-3 text-[color:var(--accent-from)]">
          <Mark size={30} sweeping={false} />
          <span className="text-[color:var(--paper-faint)]">·</span>
          <Bot className="h-6 w-6" />
        </div>

        <h1 className="mt-5 text-[19px] leading-snug font-semibold tracking-tight">
          Connect {clientQuery.data?.clientName ?? 'this agent'} to your radars?
        </h1>

        <ul className="mt-4 flex flex-col gap-2.5 text-[13.5px] text-[color:var(--paper-dim)]">
          {base.map((scope) => (
            <li key={scope} className="flex gap-2.5">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--ok)]" />
              <span>
                {SCOPE_COPY[scope].title}
                <span className="mt-0.5 block text-[12px] text-[color:var(--paper-faint)]">
                  {SCOPE_COPY[scope].detail}
                </span>
              </span>
            </li>
          ))}
        </ul>

        <label className="mt-4 flex items-start gap-2 text-[13.5px] text-[color:var(--paper-dim)]">
          <input
            type="checkbox"
            className="mt-1"
            checked={manage}
            onChange={(event) => setManage(event.target.checked)}
          />
          <span>
            Also allow: {SCOPE_COPY['radars:manage'].title}
            <span className="mt-0.5 block text-[12px] text-[color:var(--paper-faint)]">
              {SCOPE_COPY['radars:manage'].detail} Off unless you tick it.
            </span>
          </span>
        </label>

        <p className="mt-4 text-[13px] text-[color:var(--paper-dim)]">
          Never more than you can do yourself — it acts as {user.email}.
        </p>

        {/*
          Whose name it writes under, on the screen that grants the connection.

          This is the whole of safety rule 7 applied to a second question. The
          scopes above say what it can reach; this says what other people will
          see when it does — and an agent's name is exactly the kind of thing that must
          be chosen out loud, once, by the person who will be answerable for what
          it writes, rather than defaulted into by a client.
        */}
        {agents.length > 0 ? (
          <div className="mt-5 flex flex-col gap-2 border-t border-[color:var(--line-soft)] pt-4">
            <span className="instrument">Writes as</span>
            <Select
              className="field"
              value={agentId}
              onValueChange={(value) => setAgentId(value)}
              aria-label="Writes as"
              options={[
                { value: '', label: 'You' },
                ...agents.map((agent) => ({
                  value: agent.id,
                  label: `${agent.name} · cosigned by you`,
                })),
              ]}
            />
            {agentId ? (
              <label className="mt-1 flex items-start gap-2 text-[13px]">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={alsoAsMe}
                  onChange={(event) => setAlsoAsMe(event.target.checked)}
                />
                <span>
                  {VOICE_COPY.principal.title}
                  <span className="mt-0.5 block text-[12px] text-[color:var(--paper-faint)]">
                    {VOICE_COPY.principal.detail}
                  </span>
                </span>
              </label>
            ) : (
              <span className="text-[12.5px] text-[color:var(--paper-faint)]">
                Everything it writes appears under your name.
              </span>
            )}
            <span className="text-[12.5px] text-[color:var(--paper-faint)]">
              You can also choose per chat by loading an agent.
            </span>
          </div>
        ) : null}

        <p className="instrument mt-5 break-all">
          {granted.join(' ')}
          <span className="mt-1 block">returns to {host}</span>
        </p>

        <div className="mt-6 flex gap-2">
          <button
            className="btn flex-1 justify-center"
            disabled={busy}
            onClick={() => void decide(false)}
          >
            Cancel
          </button>
          <button
            className="btn btn-accent flex-1 justify-center"
            disabled={busy}
            onClick={() => void decide(true)}
          >
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
