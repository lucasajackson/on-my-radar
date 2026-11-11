import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, Plus, Trash2 } from 'lucide-react';
import { CopyButton } from './copy-button';
import {
  emailCaptureUsernameSchema,
  updateRadarEmailCaptureSchema,
  type RadarEmailCaptureDto,
} from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { useSession } from '../lib/session';
import { relativeTime } from '../lib/format';
import { Section, Spinner, notify } from './primitives';
import { QueryError } from './query-error';

const identityKey = ['email-capture', 'identity'] as const;
const radarKey = (id: string) => ['email-capture', 'radar', id] as const;

/** The address and its availability. */
function useEmailCaptureIdentity() {
  return useQuery({ queryKey: identityKey, queryFn: () => api.emailCapture.identity() });
}

export function EmailCaptureSettings() {
  const client = useQueryClient();
  const query = useEmailCaptureIdentity();
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const claim = async () => {
    if (busy) return;
    const parsed = emailCaptureUsernameSchema.safeParse(username);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Choose a valid username.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const identity = await api.emailCapture.claim(parsed.data);
      client.setQueryData(identityKey, identity);
      void client.invalidateQueries({ queryKey: ['email-capture', 'radar'] });
      notify('Email address saved');
    } catch (failure) {
      setError(
        failure instanceof ApiError ? failure.message : 'Could not save your email address.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div id="email-capture">
      <Section title="Email capture">
        <p className="note">
          Send email into your Drop box or directly to a radar. Each radar has its own approved
          sender list, starting with your account email.
        </p>
        {query.isLoading ? (
          <Spinner label="Loading email capture" />
        ) : query.error ? (
          <QueryError resource="Email capture" error={query.error} retry={() => query.refetch()} />
        ) : query.data ? (
          <>
            {!query.data.available ? (
              <p className="note" role="status">
                Email delivery is not active on this installation yet. You can reserve your address
                and prepare your radar settings.
              </p>
            ) : null}
            {query.data.username ? (
              <>
                {query.data.address ? (
                  <AddressCopy address={query.data.address} />
                ) : (
                  <p className="note">
                    Reserved username: <strong>{query.data.username}</strong>
                  </p>
                )}
                <p className="note">
                  This address belongs to your Drop box. Manage delivery and approved senders in its
                  Sources settings. Other radars have their own addresses and approved senders.
                </p>
                <Link className="btn self-start" to="/radars">
                  Choose a radar
                </Link>
              </>
            ) : (
              <form
                className="flex flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void claim();
                }}
              >
                <label className="flex flex-col gap-1.5">
                  <span className="instrument">Email username</span>
                  <input
                    className="field"
                    value={username}
                    onChange={(event) => setUsername(event.target.value.toLowerCase())}
                    placeholder="your-name"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    maxLength={32}
                    required
                  />
                </label>
                <p className="note">
                  Choose once: 3–32 lowercase letters, numbers or hyphens. This name becomes the
                  start of every radar’s email address and cannot be changed.
                </p>
                <p className="note">
                  Setting up this address turns on email capture for your Drop box, accepting only
                  messages from your account email. You can pause receiving in its Sources settings.
                </p>
                {error ? (
                  <p className="note" role="alert" style={{ color: 'var(--danger)' }}>
                    {error}
                  </p>
                ) : null}
                <button
                  className="btn btn-accent self-start"
                  disabled={busy || !username.trim()}
                  type="submit"
                >
                  {busy ? 'Saving…' : 'Set up email address'}
                </button>
              </form>
            )}
          </>
        ) : null}
      </Section>
    </div>
  );
}

export function RadarEmailCapture({ radarId, isDropBox }: { radarId: string; isDropBox: boolean }) {
  const client = useQueryClient();
  const { user } = useSession();
  const query = useQuery({
    queryKey: radarKey(radarId),
    queryFn: () => api.emailCapture.radar(radarId),
  });
  const [sender, setSender] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settings = query.data;
  const save = async (next: Pick<RadarEmailCaptureDto, 'enabled' | 'allowedSenders'>) => {
    if (busy) return false;
    const parsed = updateRadarEmailCaptureSchema.safeParse(next);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter one complete email address.');
      return false;
    }
    setBusy(true);
    setError(null);
    try {
      client.setQueryData(
        radarKey(radarId),
        await api.emailCapture.updateRadar(radarId, parsed.data),
      );
      return true;
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : 'Could not update email capture.');
      return false;
    } finally {
      setBusy(false);
    }
  };
  const add = async () => {
    if (!settings || !sender.trim()) return;
    if (
      await save({
        enabled: settings.enabled,
        allowedSenders: [...settings.allowedSenders, sender.trim().toLowerCase()],
      })
    )
      setSender('');
  };
  return (
    <Section title="Email">
      <p className="note">
        {isDropBox
          ? 'Your main capture address delivers here.'
          : 'Send a message straight to this radar.'}{' '}
        The subject, message and attachments become a blip.
      </p>
      <p className="note">
        Up to 12 attachments per message. Maximum total email size: 10 MB, including attachments.
      </p>
      {query.isLoading ? (
        <Spinner label="Loading email settings" />
      ) : query.error ? (
        <QueryError resource="Email settings" error={query.error} retry={() => query.refetch()} />
      ) : settings ? (
        <>
          {!settings.available ? (
            <p className="note" role="status">
              Email delivery is not active on this installation yet.
            </p>
          ) : null}
          {settings.address ? (
            <AddressCopy address={settings.address} />
          ) : settings.identityConfigured ? (
            <p className="note">
              Your radar address will be assigned when you enable email capture.
            </p>
          ) : (
            <p className="note">
              Reserve your email username first in{' '}
              <Link to="/settings/email" className="underline">
                Email capture settings
              </Link>
              .
            </p>
          )}
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-[color:var(--accent-from)]"
              checked={settings.enabled}
              disabled={
                busy || (!settings.enabled && (!settings.available || !settings.identityConfigured))
              }
              onChange={(event) =>
                void save({
                  enabled: event.target.checked,
                  allowedSenders: settings.allowedSenders,
                })
              }
            />
            <span>
              <span className="block text-[14px] font-medium">Receive email on this radar</span>
              <span className="note">
                Only individually approved senders below can deliver here.
              </span>
            </span>
          </label>
          <div className="flex flex-col gap-2 border-t border-[color:var(--line-soft)] pt-3">
            <h3 className="text-[14px] font-semibold">Approved senders</h3>
            <p className="note">
              One exact email address per sender. Domains and wildcards are never accepted. The
              sender’s mail provider must authenticate the message.
            </p>
            <ul className="divide-y divide-[color:var(--line-soft)]">
              {settings.allowedSenders.map((email) => (
                <li key={email} className="flex items-center gap-2 py-2">
                  <Mail className="h-4 w-4 shrink-0 text-[color:var(--paper-dim)]" />
                  <span className="min-w-0 flex-1 break-all text-[13.5px]">
                    {email}
                    {email.toLowerCase() === user?.email.toLowerCase() ? (
                      <span className="note block">Your account email · always approved</span>
                    ) : null}
                  </span>
                  {email.toLowerCase() !== user?.email.toLowerCase() ? (
                    <button
                      className="btn btn-ghost shrink-0 p-2"
                      disabled={busy}
                      onClick={() =>
                        void save({
                          enabled: settings.enabled,
                          allowedSenders: settings.allowedSenders.filter(
                            (value) => value !== email,
                          ),
                        })
                      }
                      aria-label={`Remove approved sender ${email}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(event) => {
                event.preventDefault();
                void add();
              }}
            >
              <label className="min-w-0 flex-1">
                <span className="sr-only">Approved sender email</span>
                <input
                  className="field"
                  type="email"
                  required
                  value={sender}
                  onChange={(event) => setSender(event.target.value)}
                  placeholder="sender@example.com"
                  disabled={busy || settings.allowedSenders.length >= 25}
                />
              </label>
              <button
                className="btn"
                type="submit"
                disabled={busy || !sender.trim() || settings.allowedSenders.length >= 25}
              >
                <Plus className="h-4 w-4" />
                Approve sender
              </button>
            </form>
            {settings.allowedSenders.length >= 25 ? (
              <p className="note">Maximum 25 approved senders. Remove one to add another.</p>
            ) : null}
          </div>
          {error ? (
            <p className="note" role="alert" style={{ color: 'var(--danger)' }}>
              {error}
            </p>
          ) : null}
          {settings.lastReceivedAt ? (
            <p className="note">Last email received {relativeTime(settings.lastReceivedAt)}.</p>
          ) : null}
          {settings.lastError ? (
            <p className="note" role="status" style={{ color: 'var(--warn)' }}>
              Last delivery issue: {settings.lastError}
            </p>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}

function AddressCopy({ address }: { address: string }) {
  return (
    <div className="panel flex items-center gap-2 p-3">
      <code className="min-w-0 flex-1 select-all break-all text-[13px]">{address}</code>
      <CopyButton className="btn shrink-0" value={address} ariaLabel="Copy email address" />
    </div>
  );
}
