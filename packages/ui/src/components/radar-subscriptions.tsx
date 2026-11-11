import { useRef, useState } from 'react';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SUBSCRIPTION_EVENTS,
  type SubscriptionDto,
  type SubscriptionEvent,
} from '@onmyradar/contract';
import { api, ApiError } from '../lib/api';
import { queryKeys } from '../lib/session';
import { ConfirmDialog, Modal, Section, Spinner, notify } from './primitives';
import { QueryError } from './query-error';
import { focusWhenPresent } from '../lib/focus';

export function RadarSubscriptions({ radarId }: { radarId: string }) {
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  // Whose secret is on screen, so acknowledging it can hand focus to that row.
  const [secretFor, setSecretFor] = useState<string | null>(null);
  /*
    A one-time secret takes focus when it appears — it is the thing to act on,
    and the button that opened the dialog is disabled while it shows, so focus
    had nowhere to return to and fell to the page title. Saying "I have saved
    it" hands focus to the subscription it belongs to.
  */
  const showSecret = (row: SubscriptionDto) => {
    setSecret(row.secret ?? null);
    setSecretFor(row.id);
    requestAnimationFrame(() => focusWhenPresent(['[aria-label="Signing secret"]']));
  };
  const [selected, setSelected] = useState<SubscriptionDto | null>(null);
  const [confirm, setConfirm] = useState<{
    row: SubscriptionDto;
    action: 'rotate' | 'delete';
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const query = useQuery({
    queryKey: queryKeys.subscriptions(radarId),
    queryFn: () => api.subscriptions.list(radarId),
    refetchInterval: 10000,
  });
  const history = useQuery({
    queryKey: queryKeys.subscriptionDeliveries(radarId, selected?.id ?? ''),
    queryFn: selected ? () => api.subscriptions.deliveries(radarId, selected.id) : skipToken,
    refetchInterval: selected ? 3000 : false,
  });
  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    try {
      await work();
      await client.invalidateQueries({ queryKey: queryKeys.subscriptions(radarId) });
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not update the subscription', 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section
      title="Outbound webhooks"
      action={
        <button
          className="btn btn-accent"
          disabled={busy || Boolean(secret)}
          onClick={() => setCreating(true)}
        >
          New subscription
        </button>
      }
    >
      <p className="text-sm text-[color:var(--paper-dim)]">
        Send signed blip and comment events to another service. Choose a public HTTPS receiver and
        save its signing secret.
      </p>
      {secret && (
        <div className="panel flex flex-col gap-3 p-4" role="status">
          <strong>Signing secret — shown once</strong>
          <input
            aria-label="Signing secret"
            className="field font-mono text-xs"
            readOnly
            value={secret}
          />
          <p className="text-sm">
            Save this in your receiver’s configuration. It cannot be read back. Rotating it
            immediately changes the secret used for new delivery attempts.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              className="btn"
              onClick={() => {
                void navigator.clipboard
                  .writeText(secret)
                  .then(() => notify('Secret copied'))
                  .catch(() => notify('Select and copy the secret above', 'error'));
              }}
            >
              Copy secret
            </button>
            <button
              className="btn"
              onClick={() => {
                setSecret(null);
                if (secretFor)
                  focusWhenPresent([`[data-subscription-id="${secretFor}"]`], { frames: 120 });
              }}
            >
              I have saved it
            </button>
          </div>
        </div>
      )}
      {query.isPending ? (
        <Spinner />
      ) : query.isError ? (
        <QueryError resource="Subscriptions" error={query.error} retry={query.refetch} />
      ) : query.data.subscriptions.length === 0 ? (
        <p className="text-sm py-4">No outbound subscriptions yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {query.data.subscriptions.map((row) => (
            <li
              key={row.id}
              data-subscription-id={row.id}
              tabIndex={-1}
              aria-label={row.name}
              className="panel flex min-w-0 flex-col gap-2 p-4"
            >
              <div className="flex flex-wrap gap-2">
                <strong className="break-words">{row.name}</strong>
                <span
                  className="instrument status-state"
                  data-state={row.enabled ? 'active' : 'paused'}
                >
                  {row.enabled ? 'Active' : 'Paused'}
                </span>
              </div>
              <p className="break-all text-sm text-[color:var(--paper-dim)]">{row.url}</p>
              <p className="break-words text-xs">{row.events.join(', ')}</p>
              {row.lastError && (
                <p className="text-sm" role="status">
                  {row.lastError}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    void act(() => api.subscriptions.update(radarId, row.id, !row.enabled))
                  }
                >
                  {row.enabled ? 'Pause' : 'Resume'}
                </button>
                <button
                  className="btn"
                  disabled={busy || !row.enabled}
                  onClick={() =>
                    void act(async () => {
                      await api.subscriptions.test(radarId, row.id);
                      setSelected(row);
                      notify('Test delivery queued');
                    })
                  }
                >
                  Send test
                </button>
                <button className="btn" onClick={() => setSelected(row)}>
                  Delivery history
                </button>
                <button
                  className="btn"
                  disabled={busy || Boolean(secret)}
                  onClick={() => setConfirm({ row, action: 'rotate' })}
                >
                  Rotate secret
                </button>
                <button
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => setConfirm({ row, action: 'delete' })}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {creating && (
        <NewSubscription
          radarId={radarId}
          onClose={() => setCreating(false)}
          onCreated={(row) => {
            setCreating(false);
            showSecret(row);
            void client.invalidateQueries({ queryKey: queryKeys.subscriptions(radarId) });
          }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.action === 'rotate' ? 'Rotate signing secret?' : 'Delete subscription?'}
          body={
            confirm.action === 'rotate'
              ? 'Your receiver will need the replacement secret. Pending retries will use it too.'
              : 'This stops delivery and deletes pending events and delivery history.'
          }
          confirmLabel={confirm.action === 'rotate' ? 'Rotate secret' : 'Delete subscription'}
          danger={confirm.action === 'delete'}
          busy={busy}
          onClose={() => setConfirm(null)}
          onConfirm={() =>
            void act(async () => {
              if (confirm.action === 'rotate') {
                const result = await api.subscriptions.rotate(radarId, confirm.row.id);
                showSecret(result.subscription);
              } else await api.subscriptions.remove(radarId, confirm.row.id);
              setConfirm(null);
            })
          }
        />
      )}
      {selected && (
        <Modal title={`Delivery history · ${selected.name}`} onClose={() => setSelected(null)}>
          <p className="text-sm mb-4">
            Last 100 attempts. Failed events retry six times over about six hours, then pause the
            subscription and notify its creator.
          </p>
          {history.isPending ? (
            <Spinner />
          ) : history.isError ? (
            <QueryError resource="Delivery history" error={history.error} retry={history.refetch} />
          ) : history.data.deliveries.length === 0 ? (
            <p>No attempts yet. Queued deliveries will appear here shortly.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {history.data.deliveries.map((d) => (
                <li key={d.id} className="panel p-3 text-sm">
                  <div>
                    {d.event} · attempt {d.attempt} ·{' '}
                    {d.status ? `HTTP ${d.status}` : 'Connection failed'}
                  </div>
                  <div className="text-xs text-[color:var(--paper-dim)]">
                    {new Date(d.createdAt).toLocaleString()}
                  </div>
                  <code className="break-all text-xs">{d.eventId}</code>
                  {d.error && <p>{d.error}</p>}
                </li>
              ))}
            </ul>
          )}
        </Modal>
      )}
    </Section>
  );
}
function NewSubscription({
  radarId,
  onClose,
  onCreated,
}: {
  radarId: string;
  onClose: () => void;
  onCreated: (row: SubscriptionDto) => void;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<SubscriptionEvent[]>([...SUBSCRIPTION_EVENTS]);
  const [busy, setBusy] = useState(false);
  // Said beside the field it is about. A toast for "that address is private"
  // disappeared while somebody was still reading it, over a form that looked fine.
  const [error, setError] = useState<string | null>(null);
  const urlField = useRef<HTMLInputElement>(null);
  return (
    <Modal title="New outbound subscription" onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          void api.subscriptions
            .create(radarId, { name, url, events })
            .then(({ subscription }) => onCreated(subscription))
            .catch((err: unknown) => {
              setError(err instanceof ApiError ? err.message : 'Could not create subscription');
              urlField.current?.focus();
            })
            .finally(() => setBusy(false));
        }}
      >
        <label className="flex flex-col gap-1">
          Name
          <input
            className="field"
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Customer portal"
          />
        </label>
        <label className="flex flex-col gap-1">
          Receiver URL
          <input
            ref={urlField}
            className="field"
            type="url"
            required
            maxLength={2048}
            value={url}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'subscription-error' : undefined}
            onChange={(e) => {
              setUrl(e.target.value);
              setError(null);
            }}
            placeholder="https://example.com/webhooks/onmyradar"
          />
          {error ? (
            <span
              id="subscription-error"
              role="alert"
              className="text-sm text-[color:var(--danger)]"
            >
              {error}
            </span>
          ) : null}
        </label>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2">Events to send</legend>
          {SUBSCRIPTION_EVENTS.map((event) => (
            <label key={event} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={events.includes(event)}
                onChange={(e) =>
                  setEvents(
                    e.target.checked ? [...events, event] : events.filter((v) => v !== event),
                  )
                }
              />
              {event}
            </label>
          ))}
        </fieldset>
        <p className="text-sm text-[color:var(--paper-dim)]">
          Your receiver will receive blip content and comments for these events while you have write
          access to this radar.
        </p>
        <div className="flex justify-end gap-2">
          <button className="btn" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-accent" type="submit" disabled={busy || events.length === 0}>
            {busy ? 'Creating…' : 'Create subscription'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
