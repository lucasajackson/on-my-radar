/**
 * Admin → People: the waitlist queue — who is waiting, and who is already in.
 * Moved here unchanged from the old single-screen `/admin`.
 */
import { QueryError } from '../components/query-error';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ShieldOff, UserCheck } from 'lucide-react';
import type { AdminUserDto, UserState } from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { fullTime, relativeTime } from '../lib/format';
import { WaitlistNote } from '../components/waitlist-note';
import { queryKeys, useSession } from '../lib/session';
import { ConfirmDialog, Empty, Spinner, notify } from '../components/primitives';
import { useDocumentTitle } from '../lib/title';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const TABS: Array<{ key: UserState | 'all'; label: string }> = [
  { key: 'pending', label: 'Waiting' },
  { key: 'active', label: 'Approved' },
  { key: 'suspended', label: 'Suspended' },
  { key: 'all', label: 'Everyone' },
];

export function AdminPeopleRoute() {
  useDocumentTitle('People · Admin');
  const { user } = useSession();
  const client = useQueryClient();
  const [tab, setTab] = useState<UserState | 'all'>('pending');
  // Per account, so a double click cannot approve twice — which sent a second
  // welcome email or came back as an error toast about a state already left.
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [suspending, setSuspending] = useState<AdminUserDto | null>(null);

  const query = useQuery({
    queryKey: queryKeys.adminUsers(tab === 'all' ? undefined : tab),
    queryFn: () => api.admin.users(tab === 'all' ? undefined : tab),
    enabled: Boolean(user?.isAdmin),
  });

  if (!user?.isAdmin) {
    return <Empty title="Admins only" hint="This screen is for account administrators." />;
  }

  const act = async (id: string, action: 'approve' | 'suspend' | 'reinstate', email: string) => {
    if (pending.has(id)) return;
    setPending((current) => new Set(current).add(id));
    try {
      await api.admin.act(id, action);
      await client.invalidateQueries({ queryKey: ['admin-users'] });
      notify(
        action === 'approve'
          ? `${email} approved — they have been emailed`
          : action === 'suspend'
            ? `${email} suspended`
            : `${email} reinstated`,
      );
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'That did not work', 'error');
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h2 className="text-[17px] font-semibold tracking-tight">Waitlist</h2>
        <p className="mt-1 text-[13.5px] text-[color:var(--paper-dim)]">
          Anyone can ask for an account. Nobody gets in until you say so.
        </p>
      </header>

      <div className="flex flex-wrap gap-1.5">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            aria-pressed={tab === key}
            className="flex items-center gap-2 rounded-full border px-3 py-1.5 text-[13px]"
            style={{
              borderColor: tab === key ? 'transparent' : 'var(--line)',
              background: tab === key ? 'var(--accent-fill)' : 'var(--ink-800)',
              color:
                tab === key
                  ? 'color-mix(in srgb, var(--accent-ink) 85%, black)'
                  : 'var(--paper-dim)',
            }}
          >
            {label}
            {key !== 'all' && query.data?.counts[key] !== undefined ? (
              <span className="font-mono text-[10.5px] opacity-75">{query.data.counts[key]}</span>
            ) : null}
          </button>
        ))}
      </div>

      {query.isLoading ? (
        <Spinner label="Loading accounts" />
      ) : query.error ? (
        <QueryError error={query.error} resource="Accounts" retry={() => query.refetch()} />
      ) : (query.data?.users.length ?? 0) === 0 ? (
        <Empty
          title={tab === 'pending' ? 'Nobody is waiting' : 'Nothing here'}
          hint={
            tab === 'pending'
              ? 'New sign-ups will appear here for you to approve.'
              : 'No accounts in this state.'
          }
        />
      ) : (
        <ul className="panel divide-y divide-[color:var(--line-soft)]">
          {query.data?.users.map((account) => (
            <li key={account.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px]">
                  {account.name ?? account.email}
                  {/* The name they gave the form, beside the address it came
                      with — theirs to claim, not ours to confirm. */}
                  {account.state === 'pending' && !account.name && account.waitlist?.name ? (
                    <span className="text-[color:var(--paper-dim)]">
                      {' '}
                      · {account.waitlist.name}
                    </span>
                  ) : null}
                  {account.isAdmin ? <span className="instrument ml-2">admin</span> : null}
                </div>
                <div className="instrument truncate" title={fullTime(account.createdAt)}>
                  {account.name ? `${account.email} · ` : ''}
                  joined {relativeTime(account.createdAt)} ·{' '}
                  {plural(account.radarCount, 'radar', 'radars')} ·{' '}
                  {plural(account.blipCount, 'blip', 'blips')}
                </div>
                {account.state === 'pending' && account.waitlist ? (
                  <WaitlistNote waitlist={account.waitlist} />
                ) : null}
              </div>

              <div className="flex shrink-0 gap-1.5">
                {account.state === 'pending' ? (
                  <button
                    className="btn btn-accent"
                    disabled={pending.has(account.id)}
                    onClick={() => void act(account.id, 'approve', account.email)}
                  >
                    <Check className="h-4 w-4" />
                    Approve
                  </button>
                ) : null}
                {account.state === 'active' && account.id !== user.id ? (
                  <button
                    className="btn"
                    disabled={pending.has(account.id)}
                    onClick={() => setSuspending(account)}
                  >
                    <ShieldOff className="h-4 w-4" />
                    Suspend
                  </button>
                ) : null}
                {account.state === 'suspended' ? (
                  <button
                    className="btn"
                    disabled={pending.has(account.id)}
                    onClick={() => void act(account.id, 'reinstate', account.email)}
                  >
                    <UserCheck className="h-4 w-4" />
                    Reinstate
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* The one act here that takes something away from a person straight
          away — every session they hold ends — and it was a single click. */}
      {suspending ? (
        <ConfirmDialog
          title={`Suspend ${suspending.email}?`}
          confirmLabel="Suspend"
          danger
          body="Every session they hold ends at once, and they cannot use On My Radar until you reinstate them. Their radars and blips stay as they are."
          onClose={() => setSuspending(null)}
          onConfirm={() => {
            const account = suspending;
            setSuspending(null);
            void act(account.id, 'suspend', account.email);
          }}
        />
      ) : null}
    </div>
  );
}
