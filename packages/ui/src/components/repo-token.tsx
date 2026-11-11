/**
 * "Create a token for a machine": a token bound to this agent, so a local tool
 * that is only ever this agent writes under its name without passing a session
 * (docs/AGENT_REPO.md §V2.5, source 2). The secret is shown exactly once.
 *
 * Only the owner can bind a credential to an agent — the server refuses
 * anyone else's. For an agent shared with you the token is your own, and
 * your sessions still write under the agent's name through `load_agent`.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DEFAULT_TOKEN_EXPIRY_DAYS, type RepoAgentDto } from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { queryKeys } from '../lib/session';
import { CopyButton } from './copy-button';
import { notify } from './primitives';
import { Select } from './select';

/** 90 days is the default; "Never" is a choice, never the fallback. */
const TOKEN_EXPIRY_OPTIONS = [
  { value: '30', label: '30 days' },
  { value: String(DEFAULT_TOKEN_EXPIRY_DAYS), label: `${DEFAULT_TOKEN_EXPIRY_DAYS} days` },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'Never' },
];

export function MintToken({
  agent,
  tool,
  label = 'Create a token for a machine',
  onMinted,
}: {
  agent: RepoAgentDto;
  /** The tool it is for, when minted from Use in… — goes into the default name. */
  tool?: string;
  label?: string;
  onMinted?: (token: string) => void;
}) {
  const client = useQueryClient();
  const today = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState([agent.slug, tool, today].filter(Boolean).join(' · '));
  const [expiry, setExpiry] = useState(String(DEFAULT_TOKEN_EXPIRY_DAYS));
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);

  if (secret)
    return (
      <div className="token-reveal" role="status">
        <span className="note">
          <strong>Copy it now</strong> — it is shown once.{' '}
          {agent.role === 'owner'
            ? `It writes as ${agent.name}, cosigned by you.`
            : `It is yours; while ${agent.name} is loaded, what you write shows under its name, cosigned by you.`}
        </span>
        <code className="token-secret">{secret}</code>
        <CopyButton value={secret} label="Copy token" />
      </div>
    );

  if (!open)
    return (
      <button type="button" className="btn self-start" onClick={() => setOpen(true)}>
        {label}
      </button>
    );

  return (
    <form
      className="token-form"
      onSubmit={(event) => {
        event.preventDefault();
        void (async () => {
          setBusy(true);
          try {
            const expiresInDays = expiry === 'never' ? null : Number(expiry);
            const { token } =
              agent.role === 'owner'
                ? await api.agentRepo.mintToken(agent.id, name.trim(), expiresInDays)
                : await api.tokens.create({ name: name.trim(), expiresInDays });
            await client.invalidateQueries({
              queryKey: queryKeys.repoAgentPart(agent.id, 'connections'),
            });
            await client.invalidateQueries({ queryKey: queryKeys.tokens });
            if (token.token) {
              setSecret(token.token);
              onMinted?.(token.token);
            } else notify('Token created');
          } catch (error) {
            notify(error instanceof ApiError ? error.message : 'Could not create a token', 'error');
          } finally {
            setBusy(false);
          }
        })();
      }}
    >
      <label className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="instrument">Name it after the machine</span>
        <input
          className="field"
          value={name}
          maxLength={80}
          autoFocus
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="instrument">Expires</span>
        <Select
          value={expiry}
          onValueChange={setExpiry}
          aria-label="Token expiry"
          options={TOKEN_EXPIRY_OPTIONS}
        />
      </label>
      <button type="submit" className="btn btn-accent" disabled={busy || !name.trim()}>
        Create token
      </button>
      <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}
