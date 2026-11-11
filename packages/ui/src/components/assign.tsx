import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, UserPlus } from 'lucide-react';
import type { BlipDto, BlipHolderDto, MemberDto } from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { invalidateBlipLists, queryKeys, useSession } from '../lib/session';
import { Modal } from './primitives';

export function initialsOf(name: string | null): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : [words[0]];
  return (
    letters
      .map((word) => word?.[0] ?? '')
      .join('')
      .toUpperCase() || '?'
  );
}

/** Who holds the card: initials for a person, the agent badge for an agent. */
export function AssigneeChip({ holder }: { holder: BlipHolderDto }) {
  const agent = Boolean(holder.agentId);
  return (
    <span className="assignee-chip" data-assignee={agent ? 'agent' : 'person'}>
      <span className={`assignee-mark${agent ? ' is-agent' : ''}`} aria-hidden="true">
        {agent ? <Bot size={11} /> : initialsOf(holder.name)}
      </span>
      <span className="instrument">{holder.name ?? 'someone'}</span>
    </span>
  );
}

interface Option {
  key: string;
  name: string;
  detail: string;
  agent: boolean;
}

/** The picker. Which people and agents are allowed is the server's call; its refusal is shown here. */
export function AssignControl({ blip }: { blip: BlipDto }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-ghost" onClick={() => setOpen(true)}>
        <UserPlus size={16} />
        <span>{blip.assignee ? 'Reassign' : 'Assign'}</span>
      </button>
      {open ? <AssignDialog blip={blip} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function AssignDialog({ blip, onClose }: { blip: BlipDto; onClose: () => void }) {
  const client = useQueryClient();
  const { user } = useSession();
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const members = useQuery({
    queryKey: queryKeys.members(blip.radarId),
    queryFn: () => api.radars.members(blip.radarId),
    staleTime: 60_000,
  });
  const options: Option[] = [
    ...(members.data?.members ?? [])
      .filter((member: MemberDto) => !member.pending)
      .map((member) => ({
        key: member.userId,
        name: member.name?.trim() || member.email,
        detail: member.email,
        agent: false,
      })),
    ...(members.data?.agents ?? []).map((agent) => ({
      key: agent.id,
      name: agent.name,
      detail: `@${agent.handle} · ${agent.ownerName}`,
      agent: true,
    })),
  ];
  const needle = search.trim().toLowerCase();
  const shown = options.filter((o) => `${o.name} ${o.detail}`.toLowerCase().includes(needle));

  // Both fields go every time: the server stores each as sent, and a card holds one assignee.
  const assign = async (userId: string | null, agentId: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await api.blips.update(blip.id, { assigneeUserId: userId, assigneeAgentId: agentId });
      await invalidateBlipLists(client);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not assign that card.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Assign card" onClose={onClose}>
      <div className="assign-picker">
        <input
          className="field"
          type="search"
          placeholder="Search people and agents"
          aria-label="Search people and agents"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="assign-actions">
          {user ? (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void assign(user.id, null)}
            >
              Assign to me
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy || !blip.assignee}
            onClick={() => void assign(null, null)}
          >
            Unassign
          </button>
        </div>
        {error ? (
          <p role="alert" className="note">
            {error}
          </p>
        ) : null}
        <ul className="assign-list">
          {shown.map((o) => (
            <li key={o.key}>
              <button
                type="button"
                className="assign-option"
                disabled={busy}
                data-assign-option={o.agent ? 'agent' : 'person'}
                aria-pressed={(o.agent ? blip.assignee?.agentId : blip.assignee?.userId) === o.key}
                onClick={() => void (o.agent ? assign(null, o.key) : assign(o.key, null))}
              >
                <AssigneeChip
                  holder={{ userId: null, agentId: o.agent ? o.key : null, name: o.name }}
                />
                <span className="note">{o.detail}</span>
              </button>
            </li>
          ))}
          {members.isPending ? <li className="note">Loading…</li> : null}
          {!members.isPending && shown.length === 0 ? (
            <li className="note">Nobody matches.</li>
          ) : null}
        </ul>
      </div>
    </Modal>
  );
}
