/** Account settings: one route per section, under a shared frame. */
import { Select } from '../components/select';
import { AccountExport } from '../components/account-export';
import { EmailCaptureSettings } from '../components/email-capture';
import { IntegrationsSection, useIntegrations } from '../components/integrations';
import { QueryError } from '../components/query-error';
import { useState } from 'react';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  Bot,
  ChevronRight,
  Download,
  LogOut,
  Mail,
  Plug,
  Plus,
  Shield,
  Trash2,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import { CopyButton } from '../components/copy-button';
import {
  DEFAULT_TOKEN_SCOPES,
  TOKEN_SCOPES,
  SCOPE_COPY,
  type TokenScope,
  type ApiTokenDto,
  type OAuthGrantDto,
  type RepoAgentDto,
  type Voice,
} from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { applyTheme, type ThemePreference } from '../lib/theme';
import { fullTime } from '../lib/format';
import { queryKeys, useSession, useSignOut } from '../lib/session';
import { ConfirmDialog, Modal, Section, Spinner, notify } from '../components/primitives';
import { NotificationSettings } from '../components/notification-settings';
import { useDocumentTitle } from '../lib/title';
import {
  SETTINGS_SECTIONS,
  sectionForPath,
  settingsPath,
  type SettingsSection,
} from '../lib/settings-sections';

/**
 * The part of a client id that differs between two apps. Every id opens with
 * the same `omr_client_`, so the first eight characters were "omr_clie" on
 * every row — the one thing that could never tell two apps apart.
 */
const SCOPE_WORDS: Partial<Record<string, string>> = {
  'radars:read': 'read',
  'radars:write': 'write',
  'radars:manage': 'manage sharing',
};
/** Plain words for a grant's permissions instead of raw scope names. */
export function scopeWords(scopes: readonly string[]): string {
  const words = scopes.map((scope) => SCOPE_WORDS[scope] ?? scope);
  return [...new Set(words)].join(', ') || 'no access';
}
function clientTail(clientId: string): string {
  return clientId.replace(/^omr_client_/, '').slice(-8);
}

/* --------------------------------- frame --------------------------------- */

const SECTION_ICONS: Record<SettingsSection, LucideIcon> = {
  profile: UserRound,
  notifications: Bell,
  connections: Plug,
  email: Mail,
  data: Download,
};

/**
 * Settings is a set of sections with their own URLs. On a computer the
 * sections are tabs under one heading; on a phone `/settings` is the list of
 * sections (the "You" tab) and each one is a screen pushed on top of it, with
 * the shell's back control returning to the list.
 */
export function SettingsLayout() {
  const { user } = useSession();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const active = sectionForPath(pathname);
  const current = SETTINGS_SECTIONS.find((section) => section.key === active);
  useDocumentTitle(current ? `${current.label} · Settings` : 'Settings');
  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-4 py-6 sm:px-6">
      <header>
        <h1 className="text-[21px] font-semibold tracking-tight">
          {current ? (
            <>
              <span className="lg:hidden">{current.label}</span>
              <span className="hidden lg:inline">Settings</span>
            </>
          ) : (
            'Settings'
          )}
        </h1>
        <p className="instrument mt-1 truncate">{user?.email}</p>
      </header>
      {/* Desktop only: on a phone the sections are the list at /settings. */}
      <nav className="section-tabs hidden lg:flex" aria-label="Settings sections">
        {SETTINGS_SECTIONS.map((section) => {
          const selected = (active ?? 'profile') === section.key;
          return (
            <Link
              key={section.key}
              to={settingsPath(section.key)}
              className={`section-tab ${selected ? 'is-active' : ''}`}
              aria-current={selected ? 'page' : undefined}
            >
              {section.label}
            </Link>
          );
        })}
      </nav>
      <Outlet />
    </div>
  );
}

/** `/settings`: the list of sections on a phone, Profile on a computer. */
export function SettingsHome() {
  return (
    <>
      <div className="flex flex-col gap-8 lg:hidden">
        <nav aria-label="Settings sections">
          <ul className="panel flex flex-col divide-y divide-[color:var(--line-soft)]">
            {SETTINGS_SECTIONS.map((section) => {
              const Icon = SECTION_ICONS[section.key];
              return (
                <li key={section.key}>
                  <Link
                    to={settingsPath(section.key)}
                    className="flex min-h-14 items-center gap-3 px-4 py-3"
                    data-omr="settings-section-link"
                  >
                    <Icon className="h-[18px] w-[18px] shrink-0 text-[color:var(--accent-from)]" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14.5px] text-[color:var(--paper)]">
                        {section.label}
                      </span>
                      <span className="block truncate text-[12.5px] text-[color:var(--paper-dim)]">
                        {section.hint}
                      </span>
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-[color:var(--paper-faint)]" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <AccountActions />
      </div>
      <div className="hidden lg:block">
        <ProfileSettings />
      </div>
    </>
  );
}

/* -------------------------------- sections ------------------------------- */

export function ProfileSettings() {
  const { user, refresh } = useSession();
  const [name, setName] = useState(user?.name ?? '');

  const saveProfile = async () => {
    try {
      await api.auth.updateProfile({ name: name.trim() || null });
      await refresh();
      notify('Profile saved');
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not save your profile', 'error');
    }
  };

  const setTheme = async (theme: ThemePreference) => {
    applyTheme(theme);
    try {
      await api.auth.updateProfile({ theme });
      await refresh();
    } catch {
      // The local preference already applied; the server copy can catch up later.
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <Section title="Profile">
        <label className="flex flex-col gap-1.5">
          <span className="instrument">Display name</span>
          <input
            className="field"
            value={name}
            placeholder="What should we call you?"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div>
          <button className="btn btn-accent" onClick={() => void saveProfile()}>
            Save profile
          </button>
        </div>
      </Section>

      <Section title="Appearance">
        <div className="flex flex-wrap gap-2">
          {(['system', 'light', 'dark'] as const).map((option) => (
            <button
              key={option}
              className="btn"
              aria-pressed={user?.theme === option}
              style={{
                borderColor: user?.theme === option ? 'var(--accent-from)' : 'var(--line)',
                color: user?.theme === option ? 'var(--accent-from)' : undefined,
              }}
              onClick={() => void setTheme(option)}
            >
              {option === 'system' ? 'Match my system' : option === 'light' ? 'Light' : 'Dark'}
            </button>
          ))}
        </div>
      </Section>

      <AccountActions />
    </div>
  );
}

/** Sign out and the admin dashboard: on the phone's "You" list and on Profile. */
function AccountActions() {
  const { user } = useSession();
  const signOut = useSignOut();
  return (
    <Section title="Account">
      <div className="flex flex-wrap items-center gap-2">
        {user?.isAdmin ? (
          <Link to="/admin" className="btn">
            <Shield className="h-4 w-4" />
            Admin
          </Link>
        ) : null}
        <button className="btn" onClick={() => void signOut()}>
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </div>
    </Section>
  );
}

export function NotificationsSettings() {
  return <NotificationSettings />;
}

export function EmailSettings() {
  return <EmailCaptureSettings />;
}

export function DataSettings() {
  return <AccountExport />;
}

/**
 * Connections: how a tool reaches On My Radar, and whose name it writes under.
 * There is no separate "identity" to make any more — an Agent Repo agent is the
 * identity (docs/AGENT_REPO.md §V2.5) — so a token or a connected app either
 * writes as one of your agents, cosigned by you, or writes as you.
 */
export function ConnectionsSettings() {
  const { user } = useSession();
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<string | null>(null);
  /*
    Revoking a token is irreversible, and used to be a `window.confirm`. The
    audit named three native prompts; there were nine. A designed confirmation
    used in four places out of nine is the inconsistency the audit is about, so
    they all went the same way.
  */
  const [revoking, setRevoking] = useState<ApiTokenDto | null>(null);
  const tokensQuery = useQuery({ queryKey: queryKeys.tokens, queryFn: () => api.tokens.list() });
  const grantsQuery = useQuery({ queryKey: queryKeys.grants, queryFn: () => api.tokens.grants() });
  const integrations = useIntegrations();
  const mcpUrl = tokensQuery.data?.mcp.url ?? `${window.location.origin}/mcp`;

  /*
    Nothing paints until both lists have settled. Painting each as it landed
    is what made "New token" miss its first click: the button moved between
    the pointer arriving and the click, and the list said "No tokens yet"
    while it was still loading.
  */
  if (tokensQuery.isPending || grantsQuery.isPending)
    return <Spinner label="Loading connections" />;

  return (
    <div className="flex flex-col gap-8">
      {tokensQuery.error ? (
        <QueryError
          error={tokensQuery.error}
          resource="Connections"
          retry={() => tokensQuery.refetch()}
        />
      ) : null}

      <Section title="Connections">
        <div className="flex items-start gap-3">
          <Bot className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--accent-from)]" />
          <div className="min-w-0 text-[13.5px] leading-relaxed text-[color:var(--paper-dim)]">
            Connect Claude — or any MCP-capable agent — to your radars. It gets exactly the access
            you have: it can read, search, capture and re-file blips, and manage radars and sharing.
            Nothing more.{' '}
            <Link to="/repo" className="accent-text hover:underline">
              Agents and their prompts live in Agents.
            </Link>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="instrument">Server URL</span>
          <CopyRow value={mcpUrl} />
          <p className="text-[12.5px] text-[color:var(--paper-dim)]">
            Remote clients that support OAuth (like claude.ai) can use this URL on its own — you
            will be asked to approve the connection. For a local agent, create a token below and
            send it as a bearer token.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="instrument">Access tokens</span>
            <button className="btn" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              New token
            </button>
          </div>

          {(tokensQuery.data?.tokens.length ?? 0) === 0 ? (
            <p className="text-[13px] text-[color:var(--paper-faint)]">
              No tokens yet. Create one to connect a local agent.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-[color:var(--line-soft)]">
              {tokensQuery.data?.tokens.map((token) => (
                <li key={token.id} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px]">{token.name}</div>
                    {/* Whose name this connection writes under, on the row
                        that revokes it — because "which of my connections can
                        write as me" is the question this list exists to answer
                        and it is unanswerable from a prefix. Its own line,
                        wrapped rather than cut: at the end of the meta line a
                        phone truncated exactly the agent's name. */}
                    <div className="instrument break-words whitespace-normal">
                      {token.agent ? `writes as ${token.agent.name}` : 'writes as you'}
                    </div>
                    <div className="instrument truncate">
                      {token.prefix}… ·{' '}
                      {token.lastUsedAt ? `last used ${fullTime(token.lastUsedAt)}` : 'never used'}
                    </div>
                  </div>
                  <button
                    className="btn btn-ghost min-h-11 min-w-11 p-1.5"
                    aria-label={`Revoke ${token.name}`}
                    onClick={() => setRevoking(token)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <ConnectedApps />

        <details className="text-[13px]">
          <summary className="instrument cursor-pointer">Claude Code configuration</summary>
          <pre className="mt-2 overflow-x-auto rounded-lg border border-[color:var(--line-soft)] p-3 font-mono text-[12px] text-[color:var(--paper-dim)]">
            {`claude mcp add --transport http onmyradar ${mcpUrl} \\
  --header "Authorization: Bearer <your token>"`}
          </pre>
        </details>
      </Section>

      {/* Client portals are an admin tool; anyone who already has one keeps it. */}
      {user?.isAdmin || (integrations.data?.integrations.length ?? 0) > 0 ? (
        <IntegrationsSection />
      ) : null}

      {creating ? (
        <NewTokenDialog
          onClose={() => setCreating(false)}
          onCreated={(token) =>
            void (async () => {
              setCreating(false);
              setIssued(token);
              await client.invalidateQueries({ queryKey: queryKeys.tokens });
            })()
          }
        />
      ) : null}

      {revoking ? (
        <ConfirmDialog
          title={`Revoke ${revoking.name}?`}
          confirmLabel="Revoke token"
          danger
          body="Any agent using this token stops working immediately. Nothing it has already written is affected."
          onClose={() => setRevoking(null)}
          onConfirm={() =>
            void (async () => {
              const token = revoking;
              setRevoking(null);
              try {
                await api.tokens.revoke(token.id);
                await client.invalidateQueries({ queryKey: queryKeys.tokens });
                notify('Token revoked');
              } catch (err) {
                notify(err instanceof ApiError ? err.message : 'Could not revoke it', 'error');
              }
            })()
          }
        />
      ) : null}

      {issued ? (
        <Modal
          title="Your new token"
          description="Copy it now — it is not shown again."
          onClose={() => setIssued(null)}
        >
          <CopyRow value={issued} />
        </Modal>
      ) : null}
    </div>
  );
}

/**
 * Remote apps connected through OAuth — claude.ai and the like. Each is a
 * grant that refreshes itself, so until this list existed a lost device's
 * connector could not be cut off from this end at all. Disconnecting stops
 * every token of the grant at once; connecting again is a fresh consent.
 */
function ConnectedApps() {
  const client = useQueryClient();
  const grants = useQuery({ queryKey: queryKeys.grants, queryFn: () => api.tokens.grants() });
  const [revoking, setRevoking] = useState<OAuthGrantDto | null>(null);
  const list = grants.data?.grants ?? [];
  // Names more than one connected app goes by; those rows also show their id.
  const seen = new Map<string, number>();
  for (const grant of list) {
    const name = grant.clientName ?? grant.clientId;
    seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  const namesShared = new Set([...seen].filter(([, count]) => count > 1).map(([name]) => name));
  return (
    <div className="flex flex-col gap-2">
      <span className="instrument">Connected apps</span>
      {list.length === 0 ? (
        <p className="text-[13px] text-[color:var(--paper-faint)]">
          No apps connected through OAuth. claude.ai and other remote clients appear here once you
          approve them.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-[color:var(--line-soft)]">
          {list.map((grant) => (
            <li key={grant.clientId} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px]">{grant.clientName ?? grant.clientId}</div>
                <div className="instrument break-words whitespace-normal">
                  {grant.agent ? `writes as ${grant.agent.name}` : 'writes as you'}
                </div>
                <div className="instrument truncate">
                  {scopeWords(grant.scopes)} ·{' '}
                  {grant.lastUsedAt ? `last used ${fullTime(grant.lastUsedAt)}` : 'not used yet'} ·{' '}
                  {`lapses ${new Date(grant.lapsesAt).toLocaleDateString(undefined, { dateStyle: 'medium' })} if unused`}
                </div>
                {/* What tells two apps with one name apart: an app names itself,
                    so two "LM Studio"s are only distinguishable by where they
                    send you back to, when they connected, and their id. */}
                {/* Wraps rather than truncates, with the id first: at a narrow
                    width the end of the line was cut, and the end was the one
                    part that told two apps apart. */}
                <div className="instrument break-words whitespace-normal text-[color:var(--paper-faint)]">
                  {[
                    namesShared.has(grant.clientName ?? grant.clientId)
                      ? `id …${clientTail(grant.clientId)}`
                      : null,
                    `connected ${fullTime(grant.createdAt)}`,
                    grant.redirectHosts.length
                      ? `returns to ${grant.redirectHosts.join(', ')}`
                      : null,
                  ]
                    .filter((part): part is string => part !== null)
                    .join(' · ')}
                </div>
              </div>
              <button
                className="btn"
                aria-label={`Disconnect ${grant.clientName ?? grant.clientId}${
                  namesShared.has(grant.clientName ?? grant.clientId)
                    ? ` (id …${clientTail(grant.clientId)})`
                    : ''
                }`}
                onClick={() => setRevoking(grant)}
              >
                Disconnect
              </button>
            </li>
          ))}
        </ul>
      )}
      {revoking ? (
        <ConfirmDialog
          title={`Disconnect ${revoking.clientName ?? revoking.clientId}?`}
          confirmLabel="Disconnect"
          danger
          body="It stops working immediately, on every device it is signed in on. Connecting it again asks for your approval again. Nothing it wrote is affected."
          onClose={() => setRevoking(null)}
          onConfirm={() =>
            void (async () => {
              const grant = revoking;
              setRevoking(null);
              try {
                await api.tokens.revokeGrant(grant.clientId);
                await client.invalidateQueries({ queryKey: queryKeys.grants });
                notify('Disconnected');
              } catch (err) {
                notify(err instanceof ApiError ? err.message : 'Could not disconnect it', 'error');
              }
            })()
          }
        />
      ) : null}
    </div>
  );
}

function CopyRow({ value }: { value: string }) {
  return (
    <div className="flex gap-2">
      <input className="field font-mono text-[12.5px]" readOnly value={value} />
      <CopyButton value={value} />
    </div>
  );
}

/**
 * Who a new token may be bound to: your own live agents, and only those. A
 * credential binding outlives the moment it was made, so the server refuses a
 * token bound to an agent you do not own (\`auth/bearer.ts\`). Shared agents
 * still write under their name — through a load session, which re-checks the
 * share on every call (docs/AGENT_REPO.md §V2.5).
 */
export function writableAgents(agents: readonly RepoAgentDto[]): RepoAgentDto[] {
  return agents
    .filter((agent) => !agent.archived && agent.role === 'owner')
    .sort((a, b) => a.name.localeCompare(b.name));
}

function NewTokenDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (token: string) => void;
}) {
  const [name, setName] = useState('');
  const [agentId, setAgentId] = useState('');
  const [alsoAsMe, setAlsoAsMe] = useState(false);
  const [scopes, setScopes] = useState<readonly TokenScope[]>(DEFAULT_TOKEN_SCOPES);
  const [busy, setBusy] = useState(false);
  // Read when the dialog opens, not with the page: only this dialog needs it.
  const agentsQuery = useQuery({
    queryKey: [...queryKeys.repoAgents, 'writes-as'],
    queryFn: () => api.agentRepo.list(),
  });
  const agents = writableAgents(agentsQuery.data?.agents ?? []);
  const chosen = agents.find((agent) => agent.id === agentId);

  return (
    <Modal
      title="New access token"
      description="Name it after the tool that will use it, so you know what you are revoking later."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-accent"
            disabled={busy || !name.trim() || scopes.length === 0}
            onClick={() =>
              void (async () => {
                setBusy(true);
                try {
                  const { token } = await api.tokens.create({
                    name: name.trim(),
                    scopes: [...scopes],
                    ...(chosen
                      ? {
                          agentId: chosen.id,
                          // The agent's own name first, always. Writing under the
                          // person's name is the more consequential mode and is
                          // opt-in on this screen.
                          voices: alsoAsMe
                            ? (['persona', 'principal'] as Voice[])
                            : (['persona'] as Voice[]),
                        }
                      : {}),
                  });
                  onCreated(token.token as string);
                } catch (err) {
                  notify(
                    err instanceof ApiError ? err.message : 'Could not create a token',
                    'error',
                  );
                  setBusy(false);
                }
              })()
            }
          >
            Create token
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-3">
          <legend className="instrument">Connection permissions</legend>
          {TOKEN_SCOPES.map((scope) => (
            <label key={scope} className="flex gap-2">
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                onChange={(event) =>
                  setScopes(
                    event.target.checked
                      ? [...scopes, scope]
                      : scopes.filter((value) => value !== scope),
                  )
                }
              />
              <span>
                {SCOPE_COPY[scope].title}
                <small className="note block">{SCOPE_COPY[scope].detail}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <input
          className="field"
          value={name}
          autoFocus
          aria-label="Token name"
          placeholder="claude-code on my laptop"
          onChange={(event) => setName(event.target.value)}
        />
        <label className="flex flex-col gap-1.5">
          <span className="instrument">Writes as · optional</span>
          <Select
            className="field"
            aria-label="Writes as"
            value={chosen ? chosen.id : ''}
            disabled={agentsQuery.isPending}
            onValueChange={(value) => setAgentId(value)}
            options={[
              { value: '', label: 'You' },
              ...agents.map((agent) => ({
                value: agent.id,
                label: `${agent.name} · cosigned by you`,
              })),
            ]}
          />
          <span className="text-[12.5px] text-[color:var(--paper-dim)]">
            {chosen
              ? `It writes as ${chosen.name}, cosigned by you — you are recorded underneath ` +
                'everything it writes. It can write under your own name only if you allow that below.'
              : agents.length === 0 && !agentsQuery.isPending
                ? 'Everything it writes appears under your name. Make an agent in Agents to give a ' +
                  'tool a name of its own.'
                : 'Everything it writes appears under your name. Pick an agent to have it write ' +
                  'under that agent’s name instead.'}
          </span>
        </label>
        {chosen ? (
          <label className="flex items-start gap-2 text-[13px]">
            <input
              type="checkbox"
              className="mt-1"
              checked={alsoAsMe}
              onChange={(event) => setAlsoAsMe(event.target.checked)}
            />
            <span>
              Let it also write under my name when asked.
              <span className="block text-[12.5px] text-[color:var(--paper-dim)]">
                The agent’s name stays the default. Leave this off and it can never write as you,
                whatever it is asked to do.
              </span>
            </span>
          </label>
        ) : null}
      </div>
    </Modal>
  );
}
