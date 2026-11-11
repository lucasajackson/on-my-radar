/**
 * The owner's acts on an agent — export, duplicate, archive, transfer, delete —
 * shared by the header's ⋯ menu and the Settings danger zone, so the two can
 * never disagree about what a button does or what it asks first.
 *
 * Share, transfer, archive and delete are owner-only and person-only on the
 * server (docs/AGENT_REPO.md §V2.6); this screen only decides what to offer.
 */
import { useState, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { RepoAgentDto } from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { ConfirmDialog, Modal, notify } from './primitives';
import { personName, useInvalidateAgent } from './repo-common';

type Dialog = 'transfer' | 'delete' | null;

export interface Manage {
  dialog: ReactNode;
  exportAgent: () => void;
  duplicate: () => void;
  archive: () => void;
  transfer: () => void;
  remove: () => void;
  cancelTransfer: () => void;
}

const failed = (error: unknown, fallback: string) =>
  notify(error instanceof ApiError ? error.message : fallback, 'error');

export function useManage(agent: RepoAgentDto): Manage {
  const navigate = useNavigate();
  const invalidate = useInvalidateAgent(agent.id);
  const [open, setOpen] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);

  const exportAgent = () =>
    void (async () => {
      try {
        const { agent: bundle } = await api.agentRepo.export(agent.id);
        const blob = new Blob([`${JSON.stringify(bundle, null, 2)}\n`], {
          type: 'application/json',
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${agent.slug}.omr-agent.json`;
        link.click();
        URL.revokeObjectURL(url);
        notify(`Exported ${agent.name}`);
      } catch (error) {
        failed(error, 'Could not export it');
      }
    })();

  const duplicate = () =>
    void (async () => {
      try {
        const { agent: copy } = await api.agentRepo.duplicate(agent.id);
        await invalidate();
        notify(`Made ${copy.name}`);
        void navigate({ to: '/repo/$agentId', params: { agentId: copy.id } });
      } catch (error) {
        failed(error, 'Could not duplicate it');
      }
    })();

  const setArchived = async (archived: boolean) => {
    await api.agentRepo.setArchived(agent.id, archived);
    await invalidate();
  };
  const archive = () =>
    void (async () => {
      const next = !agent.archived;
      try {
        await setArchived(next);
        notify(
          next
            ? `${agent.name} is archived — it no longer loads anywhere`
            : `${agent.name} is back`,
          'ok',
          next
            ? {
                label: 'Undo',
                run: () =>
                  void setArchived(false).catch((error: unknown) =>
                    failed(error, 'Could not undo that'),
                  ),
              }
            : undefined,
        );
      } catch (error) {
        failed(error, 'Could not change that');
      }
    })();

  const cancelTransfer = () =>
    void (async () => {
      try {
        await api.agentRepo.cancelTransfer(agent.id);
        await invalidate();
        notify('Transfer cancelled');
      } catch (error) {
        failed(error, 'Could not cancel the transfer');
      }
    })();

  const dialog =
    open === 'transfer' ? (
      <TransferDialog agent={agent} onClose={() => setOpen(null)} onDone={invalidate} />
    ) : open === 'delete' ? (
      <ConfirmDialog
        title={`Delete ${agent.name}?`}
        danger
        busy={busy}
        phrase={agent.handle}
        confirmLabel="Delete agent"
        body={
          <>
            Its prompt, every version of it, its profiles and all{' '}
            {Object.values(agent.memoryCounts).reduce((a, b) => a + b, 0)} memories are deleted, and
            every checkout of it stops loading. What it wrote on radars stays, under its name.{' '}
            <strong>Archive</strong> it instead to stop it without losing anything.
          </>
        }
        onClose={() => setOpen(null)}
        onConfirm={() =>
          void (async () => {
            setBusy(true);
            try {
              await api.agentRepo.remove(agent.id);
              await invalidate();
              notify(`${agent.name} deleted`);
              setOpen(null);
              void navigate({ to: '/repo' });
            } catch (error) {
              failed(error, 'Could not delete it');
              setBusy(false);
            }
          })()
        }
      />
    ) : null;

  return {
    dialog,
    exportAgent,
    duplicate,
    archive,
    transfer: () => setOpen('transfer'),
    remove: () => setOpen('delete'),
    cancelTransfer,
  };
}

/**
 * Give the agent to another person. Two lines of consequence, and the handle
 * typed back, because the old owner keeps nothing unless the new one shares it.
 */
function TransferDialog({
  agent,
  onClose,
  onDone,
}: {
  agent: RepoAgentDto;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = /.+@.+\..+/.test(email.trim()) && typed.trim().toLowerCase() === agent.handle;
  return (
    <Modal
      title={`Transfer ${agent.name}`}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-danger"
            disabled={!ready || busy}
            onClick={() =>
              void (async () => {
                setBusy(true);
                try {
                  await api.agentRepo.offerTransfer(agent.id, email.trim());
                  await onDone();
                  notify(`Offered to ${email.trim()} — it moves when they accept`);
                  onClose();
                } catch (error) {
                  failed(error, 'Could not offer it');
                  setBusy(false);
                }
              })()
            }
          >
            Offer the agent
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <ul className="note flex list-disc flex-col gap-1 pl-5">
          <li>
            When they accept, it becomes theirs — prompt, profiles, memory, and the machines that
            write as it stop writing as it for you.
          </li>
          <li>You keep no access unless they share it back with you.</li>
        </ul>
        <label className="flex flex-col gap-1.5">
          <span className="instrument">Their email</span>
          <input
            className="field"
            type="email"
            autoComplete="off"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="instrument">
            Type <span className="text-[color:var(--paper)]">{agent.handle}</span> to confirm
          </span>
          <input
            className="field"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
      </div>
    </Modal>
  );
}

/** "Transfer to Ada pending" — said wherever the owner might look for it. */
export function transferLine(agent: RepoAgentDto): string | null {
  const pending = agent.pendingTransfer;
  if (!pending) return null;
  const who = personName(pending.person);
  return pending.direction === 'out'
    ? `Offered to ${who} — it moves when they accept`
    : `${who} wants to give you this agent`;
}
