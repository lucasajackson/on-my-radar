/**
 * The Settings tab: Basics, Identity, Prompt safety, Danger zone — and, for
 * somebody an agent was shared with, their own Updates choice.
 *
 * Editors change Basics; the rest is the owner's. Viewers see it read-only,
 * because "what is this agent called and who does it write as" is worth
 * reading even when it is not yours to change.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  AGENT_GRANT_CEILINGS,
  AGENT_REPO,
  repoSlugFrom,
  type AgentGrantCeiling,
  type RepoAgentDto,
} from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { queryKeys, useRadars, useSession } from '../lib/session';
import { Select } from './select';
import { slugDraft } from '../lib/slug';
import { AccentSwatch, ConfirmDialog, Section, Spinner, notify } from './primitives';
import { QueryError } from './query-error';
import {
  AGENT_ACCENTS,
  Cosigned,
  Switch,
  ago,
  personName,
  useInvalidateAgent,
} from './repo-common';
import { useAgentPage } from './repo-context';
import { useManage } from './repo-manage';
import { MintToken } from './repo-token';

export function SettingsTab() {
  const { agent } = useAgentPage();
  return (
    <div className="settings-tab">
      <Basics agent={agent} />
      <Identity agent={agent} />
      {agent.role === 'shared' ? <Updates agent={agent} /> : null}
      {agent.access.canManage ? <RadarReach agent={agent} /> : null}
      {agent.access.canManage ? <PromptSafety agent={agent} /> : null}
      {agent.access.canManage ? <DangerZone agent={agent} /> : null}
    </div>
  );
}

/** Is this handle free? Debounced, and only asked when it changed. */
function useHandleCheck(handle: string, current: string) {
  const [debounced, setDebounced] = useState(handle);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(handle), 300);
    return () => clearTimeout(timer);
  }, [handle]);
  return useQuery({
    queryKey: ['repo-handle', debounced],
    queryFn: () => api.agentRepo.handleAvailable(debounced),
    enabled: Boolean(debounced) && debounced !== current,
    staleTime: 10_000,
  });
}

function Basics({ agent }: { agent: RepoAgentDto }) {
  const canEdit = agent.access.prompt === 'edit';
  const invalidate = useInvalidateAgent(agent.id);
  const [name, setName] = useState(agent.name);
  const [handle, setHandle] = useState(agent.slug);
  const [description, setDescription] = useState(agent.description);
  const [accent, setAccent] = useState(agent.accent ?? 'cobalt');
  const [busy, setBusy] = useState(false);
  const slug = repoSlugFrom(handle);
  const check = useHandleCheck(slug, agent.slug);
  const taken = slug !== agent.slug && check.data?.available === false;
  const changed =
    name.trim() !== agent.name ||
    slug !== agent.slug ||
    description.trim() !== agent.description ||
    accent !== (agent.accent ?? 'cobalt');

  const save = () =>
    void (async () => {
      setBusy(true);
      try {
        await api.agentRepo.update(agent.id, {
          ...(name.trim() !== agent.name ? { name: name.trim() } : {}),
          ...(slug !== agent.slug ? { slug } : {}),
          ...(description.trim() !== agent.description ? { description: description.trim() } : {}),
          ...(accent !== (agent.accent ?? 'cobalt') ? { accent } : {}),
          expectedRevision: agent.revision,
        });
        await invalidate();
        notify('Saved');
      } catch (error) {
        notify(
          error instanceof ApiError
            ? error.status === 409
              ? 'It changed elsewhere just now — reload to see the latest'
              : error.message
            : 'Could not save',
          'error',
        );
      } finally {
        setBusy(false);
      }
    })();

  return (
    <Section title="Basics">
      <div className="form-row">
        <label className="form-label" htmlFor="agent-name">
          Name
        </label>
        <div className="form-control">
          <input
            id="agent-name"
            className="field font-serif text-[16px]"
            value={name}
            disabled={!canEdit}
            maxLength={AGENT_REPO.nameLength}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
      </div>
      <div className="form-row">
        <label className="form-label" htmlFor="agent-handle">
          Handle
        </label>
        <div className="form-control">
          <div className="handle-field">
            <span aria-hidden="true">@</span>
            <input
              id="agent-handle"
              className="field font-mono text-[13.5px]"
              value={handle}
              disabled={!canEdit}
              maxLength={AGENT_REPO.slugLength}
              spellCheck={false}
              onChange={(event) => setHandle(slugDraft(event.target.value))}
            />
          </div>
          <span
            className={`form-hint ${taken ? 'is-danger' : slug !== agent.slug ? 'is-warn' : ''}`}
          >
            {taken
              ? `@${slug} is taken${check.data?.suggestion ? ` — @${check.data.suggestion} is free` : ''}.`
              : 'Changing it breaks @-mentions written before.'}
          </span>
        </div>
      </div>
      <div className="form-row is-top">
        <label className="form-label" htmlFor="agent-description">
          What it’s for
        </label>
        <div className="form-control">
          <textarea
            id="agent-description"
            className="field min-h-[64px]"
            value={description}
            disabled={!canEdit}
            maxLength={AGENT_REPO.descriptionLength}
            onChange={(event) => setDescription(event.target.value)}
          />
          <span className="form-hint">
            The one line tools read when deciding to use this agent.
          </span>
        </div>
      </div>
      <div className="form-row">
        <span className="form-label" id="agent-accent">
          Accent
        </span>
        <div className="form-control">
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-labelledby="agent-accent">
            {AGENT_ACCENTS.map((key) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={accent === key}
                aria-label={key}
                className="swatch-button"
                disabled={!canEdit}
                onClick={() => setAccent(key)}
              >
                <AccentSwatch accent={key} active={accent === key} />
              </button>
            ))}
          </div>
        </div>
      </div>
      {canEdit ? (
        <div className="flex justify-end">
          <button
            className="btn btn-accent"
            disabled={!changed || busy || taken || !slug}
            onClick={save}
          >
            Save
          </button>
        </div>
      ) : null}
    </Section>
  );
}

function Identity({ agent }: { agent: RepoAgentDto }) {
  const { user } = useSession();
  const you = user?.name?.trim() || user?.email.split('@')[0] || 'you';
  return (
    <Section title="Identity">
      <p>
        Everything it writes shows as <strong className="font-serif">{agent.name}</strong>{' '}
        <span className="text-[color:var(--paper-dim)]">
          ·{' '}
          <Cosigned
            name={agent.role === 'owner' ? you : `whoever runs it — ${you}, when it is you`}
          />
        </span>
      </p>
      <p className="note">
        An agent has its own name, but a person always cosigns its work: on a shared agent, the
        cosigner is whoever ran it. Hover or tap a byline anywhere in On My Radar to see who.
      </p>
      <p className="note">
        Mention it as <code className="font-mono">@{agent.handle}</code> on any radar — it reads
        mentions the next time it loads.
      </p>
      {/* Credentials bind only to an agent you own (bearer.ts refuses the rest). */}
      {agent.role === 'owner' ? <Connections agent={agent} /> : null}
    </Section>
  );
}

function Connections({ agent }: { agent: RepoAgentDto }) {
  const connections = useQuery({
    queryKey: queryKeys.repoAgentPart(agent.id, 'connections'),
    queryFn: () => api.agentRepo.connections(agent.id),
  });
  const invalidate = useInvalidateAgent(agent.id);
  const [revoking, setRevoking] = useState<
    { kind: 'token'; id: string; name: string } | { kind: 'grant'; id: string; name: string } | null
  >(null);
  const [busy, setBusy] = useState(false);
  const tokens = connections.data?.tokens ?? [];
  const grants = connections.data?.grants ?? [];
  return (
    <div className="flex flex-col gap-2">
      <h3 className="instrument mt-1">Machines and apps that write as it</h3>
      {connections.isLoading ? <Spinner label="Reading its connections" /> : null}
      {connections.error ? (
        <QueryError
          error={connections.error}
          resource="Connections"
          retry={() => connections.refetch()}
        />
      ) : null}
      {!connections.isLoading && tokens.length + grants.length === 0 ? (
        <p className="note">
          None yet. A session writes as it whenever a tool loads it; a token here makes a machine
          write as it without loading it first.
        </p>
      ) : null}
      <ul className="connection-list">
        {tokens.map((token) => (
          <li key={token.id} className="connection-row">
            <span className="connection-mark" aria-hidden="true">
              ⌘
            </span>
            <span className="min-w-0">
              <span className="block truncate">{token.name}</span>
              <span className="note block">
                token {token.prefix}… ·{' '}
                {token.lastUsedAt ? `last used ${ago(token.lastUsedAt)}` : 'never used'}
              </span>
            </span>
            <button
              className="btn"
              onClick={() => setRevoking({ kind: 'token', id: token.id, name: token.name })}
            >
              Revoke
            </button>
          </li>
        ))}
        {grants.map((grant) => (
          <li key={grant.clientId} className="connection-row">
            <span className="connection-mark" aria-hidden="true">
              ◇
            </span>
            <span className="min-w-0">
              <span className="block truncate">{grant.clientName ?? 'An app'}</span>
              <span className="note block">
                connected app ·{' '}
                {grant.lastUsedAt ? `last used ${ago(grant.lastUsedAt)}` : 'never used'}
              </span>
            </span>
            <button
              className="btn"
              onClick={() =>
                setRevoking({
                  kind: 'grant',
                  id: grant.clientId,
                  name: grant.clientName ?? 'this app',
                })
              }
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>
      <MintToken agent={agent} />
      {revoking ? (
        <ConfirmDialog
          title={`Revoke ${revoking.name}?`}
          body={
            revoking.kind === 'token'
              ? 'The machine using this token stops reaching On My Radar at once.'
              : 'This disconnects the app from On My Radar entirely — every chat that uses it, not only this agent. It can connect again by signing in.'
          }
          confirmLabel="Revoke"
          danger
          busy={busy}
          onClose={() => setRevoking(null)}
          onConfirm={() =>
            void (async () => {
              setBusy(true);
              try {
                if (revoking.kind === 'token') await api.tokens.revoke(revoking.id);
                else await api.tokens.revokeGrant(revoking.id);
                await invalidate();
                notify('Revoked');
                setRevoking(null);
              } catch (error) {
                notify(error instanceof ApiError ? error.message : 'Could not revoke it', 'error');
              } finally {
                setBusy(false);
              }
            })()
          }
        />
      ) : null}
    </div>
  );
}

function Updates({ agent }: { agent: RepoAgentDto }) {
  const invalidate = useInvalidateAgent(agent.id);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  return (
    <Section title="Updates">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <strong>Follow updates</strong>
          <p className="note">
            Off: you run the version you accepted
            {agent.acceptedVersion ? ` (v${agent.acceptedVersion})` : ''} until you choose to
            update. On: every new version from {personName(agent.owner)} runs as soon as it is
            saved.
          </p>
        </div>
        <Switch
          label="Follow updates"
          checked={agent.followUpdates}
          disabled={busy || agent.awaitingAccept}
          onChange={(follow) =>
            void (async () => {
              setBusy(true);
              try {
                await api.agentRepo.setFollow(agent.id, follow);
                await invalidate();
              } catch (error) {
                notify(
                  error instanceof ApiError ? error.message : 'Could not change that',
                  'error',
                );
              } finally {
                setBusy(false);
              }
            })()
          }
        />
      </div>
      <div>
        <button className="btn btn-danger-quiet" onClick={() => setLeaving(true)}>
          Leave this agent
        </button>
      </div>
      {leaving ? (
        <ConfirmDialog
          title={`Leave ${agent.name}?`}
          body={`It stops loading in your tools. ${personName(agent.owner)} can share it with you again.`}
          confirmLabel="Leave"
          danger
          busy={busy}
          onClose={() => setLeaving(false)}
          onConfirm={() =>
            void (async () => {
              setBusy(true);
              try {
                await api.agentRepo.leave(agent.id);
                await invalidate();
                notify(`Left ${agent.name}`);
                void navigate({ to: '/repo' });
              } catch (error) {
                notify(error instanceof ApiError ? error.message : 'Could not leave it', 'error');
                setBusy(false);
              }
            })()
          }
        />
      ) : null}
    </Section>
  );
}

const CEILING_OPTIONS = AGENT_GRANT_CEILINGS.map((value) => ({
  value,
  label: { read: 'Read', write: 'Read and write', manage: 'Full control' }[value],
}));

/**
 * Which radars the agent may reach. Everything it was connected with by default; or only
 * the radars ticked here, each at read, write or full control, whatever its token allows.
 * The owner's choice alone: an agent cannot see this control work on itself.
 */
function RadarReach({ agent }: { agent: RepoAgentDto }) {
  const invalidate = useInvalidateAgent(agent.id);
  const radars = useRadars();
  // A grant on a radar the owner can no longer read has no name and no row to untick; saving
  // lets it go.
  const saved = new Map(
    (agent.radarGrants ?? []).filter((g) => g.name !== null).map((g) => [g.radarId, g.ceiling]),
  );
  const [scope, setScope] = useState(agent.radarScope);
  const [chosen, setChosen] = useState<Map<string, AgentGrantCeiling>>(saved);
  const [busy, setBusy] = useState(false);
  const changed =
    scope !== agent.radarScope ||
    (scope === 'selected' &&
      (chosen.size !== saved.size || [...chosen].some(([id, c]) => saved.get(id) !== c)));
  const readable = (radars.data?.radars ?? []).filter((r) => !r.archived);

  const save = () =>
    void (async () => {
      setBusy(true);
      try {
        await api.agentRepo.setRadars(agent.id, {
          scope,
          grants:
            scope === 'selected'
              ? [...chosen].map(([radarId, ceiling]) => ({ radarId, ceiling }))
              : [],
        });
        await invalidate();
        notify(scope === 'all' ? 'Reaches all your radars' : 'Limited to the radars you chose');
      } catch (error) {
        notify(error instanceof ApiError ? error.message : 'Could not save that', 'error');
      } finally {
        setBusy(false);
      }
    })();

  return (
    <Section title="Radars it can reach">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <strong>Only the radars I choose</strong>
          <p className="note">
            Off: it reaches whatever you can, within what its connection was allowed. On: it sees
            the radars ticked below, and nothing else, not even by their link.
          </p>
        </div>
        <Switch
          label="Limit to chosen radars"
          checked={scope === 'selected'}
          disabled={busy}
          onChange={(on) => setScope(on ? 'selected' : 'all')}
        />
      </div>
      {scope === 'selected' ? (
        <ul className="panel divide-y divide-[color:var(--line-soft)]">
          {readable.map((radar) => {
            const ceiling = chosen.get(radar.id);
            return (
              <li key={radar.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <label className="flex min-w-0 flex-1 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={ceiling !== undefined}
                    disabled={busy}
                    onChange={(event) =>
                      setChosen((current) => {
                        const next = new Map(current);
                        if (event.target.checked) next.set(radar.id, 'write');
                        else next.delete(radar.id);
                        return next;
                      })
                    }
                  />
                  <span className="truncate">{radar.name}</span>
                </label>
                {ceiling ? (
                  <Select
                    value={ceiling}
                    options={CEILING_OPTIONS}
                    aria-label={`What it may do in ${radar.name}`}
                    disabled={busy}
                    onValueChange={(value) =>
                      setChosen((current) =>
                        new Map(current).set(radar.id, value as AgentGrantCeiling),
                      )
                    }
                  />
                ) : null}
              </li>
            );
          })}
          {readable.length === 0 ? (
            <li className="note px-3 py-2">You have no radars yet.</li>
          ) : null}
        </ul>
      ) : null}
      {agent.radarScope === 'selected' || scope === 'selected' ? (
        <p className="note">
          For a hard limit, connect this agent with its own key: create a token for it under
          Identity above. A tool that only signs in as you and loads this agent is held to these
          radars from then on, for as long as that connection lasts, until you choose all radars
          here. Your own sign-in can still skip loading it and reach everything you can.
        </p>
      ) : null}
      {changed ? (
        <div>
          <button className="btn btn-accent" disabled={busy} onClick={save}>
            Save
          </button>
        </div>
      ) : null}
    </Section>
  );
}

/** One owner-only switch on the Prompt safety section, saved on change. */
function SafetySwitch({
  agent,
  title,
  note,
  checked,
  save,
  done,
}: {
  agent: RepoAgentDto;
  title: string;
  note: string;
  checked: boolean;
  save: (on: boolean) => Promise<unknown>;
  done: (on: boolean) => string;
}) {
  const invalidate = useInvalidateAgent(agent.id);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <strong>{title}</strong>
        <p className="note">{note}</p>
      </div>
      <Switch
        label={title}
        checked={checked}
        disabled={busy}
        onChange={(on) =>
          void (async () => {
            setBusy(true);
            try {
              await save(on);
              await invalidate();
              notify(done(on));
            } catch (error) {
              notify(error instanceof ApiError ? error.message : 'Could not change that', 'error');
            } finally {
              setBusy(false);
            }
          })()
        }
      />
    </div>
  );
}

function PromptSafety({ agent }: { agent: RepoAgentDto }) {
  return (
    <Section title="Prompt safety">
      <SafetySwitch
        agent={agent}
        title="Lock prompt"
        note="While this is on, a change from any agent waits here for you to accept it. People with edit access can still edit it."
        checked={agent.lockPrompt}
        save={(locked) => api.agentRepo.setLocked(agent.id, locked)}
        done={(locked) => (locked ? 'Locked — agents can’t change the prompt' : 'Unlocked')}
      />
      <SafetySwitch
        agent={agent}
        title="Let other agents change this live"
        note="Off: another agent’s change to this prompt or its tool profiles waits here for you to accept it, like its own would. On: it goes live at once and Activity names the agent. The lock still holds it back."
        checked={agent.agentEditsLive}
        save={(live) => api.agentRepo.setAgentEditsLive(agent.id, live)}
        done={(live) =>
          live
            ? 'Other agents can now change this prompt live'
            : 'Other agents’ changes now wait for you'
        }
      />
    </Section>
  );
}

function DangerZone({ agent }: { agent: RepoAgentDto }) {
  const manage = useManage(agent);
  return (
    <Section title="Danger zone">
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn" onClick={manage.archive}>
          {agent.archived ? 'Unarchive' : 'Archive'}
        </button>
        <span className="note">It stops loading everywhere. Its name stays on what it wrote.</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {agent.pendingTransfer?.direction === 'out' ? (
          <button className="btn" onClick={manage.cancelTransfer}>
            Cancel the transfer to {personName(agent.pendingTransfer.person)}
          </button>
        ) : (
          <button className="btn" onClick={manage.transfer}>
            Transfer ownership…
          </button>
        )}
        <button className="btn btn-danger" onClick={manage.remove}>
          Delete…
        </button>
      </div>
      {manage.dialog}
    </Section>
  );
}
