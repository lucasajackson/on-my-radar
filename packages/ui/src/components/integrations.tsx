/**
 * Client-portal integrations (docs/HELPDESK.md §3.4): Settings → Connections,
 * and a Helpdesk's "Client portal" tab.
 *
 * Every control here that widens what the portal reaches — connecting a portal,
 * rotating its token, connecting a Helpdesk — is refused by the server for an
 * agent, so this screen is where those decisions are made. Each one says what
 * it does before the click (§17's rule): what the portal will and will not see,
 * how long an old token keeps working, and that a disconnection is final.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plug, Plus, RotateCw } from 'lucide-react';
import { INTEGRATION_LIMITS, type IntegrationDto, type RadarDto } from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { fullTime } from '../lib/format';
import { queryKeys } from '../lib/session';
import { CopyButton } from './copy-button';
import { ConfirmDialog, Modal, Section, notify } from './primitives';
import { Select } from './select';

const OVERLAPS = [
  { value: '2', label: 'Keep the old token for 2 hours' },
  { value: '24', label: `Keep the old token for ${INTEGRATION_LIMITS.maxOverlapHours} hours` },
  { value: '0', label: 'Stop the old token now (it leaked)' },
];

export function useIntegrations() {
  return useQuery({ queryKey: queryKeys.integrations, queryFn: () => api.integrations.list() });
}

function failure(err: unknown, fallback: string) {
  notify(err instanceof ApiError ? err.message : fallback, 'error');
}

function TokenOnce({ token, onClose }: { token: string; onClose: () => void }) {
  return (
    <Modal
      title="The portal's token"
      description="Copy it now — it is not shown again."
      onClose={onClose}
    >
      <div className="flex flex-col gap-3">
        <div className="flex gap-2">
          <input
            className="field font-mono text-[12.5px]"
            readOnly
            value={token}
            aria-label="Integration token"
          />
          <CopyButton value={token} />
        </div>
        <p className="text-[12.5px] leading-relaxed text-[color:var(--paper-dim)]">
          Store it in the portal&apos;s secret store. Never paste it into a CI variable or a chat.
        </p>
      </div>
    </Modal>
  );
}

function SecretOnce({ secret, onClose }: { secret: string; onClose: () => void }) {
  return (
    <Modal
      title="The events signing secret"
      description="Copy it now — it is not shown again."
      onClose={onClose}
    >
      <div className="flex flex-col gap-3">
        <div className="flex gap-2">
          <input
            className="field font-mono text-[12.5px]"
            readOnly
            value={secret}
            aria-label="Events signing secret"
          />
          <CopyButton value={secret} />
        </div>
        <p className="text-[12.5px] leading-relaxed text-[color:var(--paper-dim)]">
          Store it where the portal verifies events, keeping the old one until the portal picks this
          one up. On My Radar signs with this one from now on.
        </p>
      </div>
    </Modal>
  );
}

/**
 * Events to the portal (§5.4). The portal can always pull them; a receiver
 * makes them arrive as they happen. A pause — by hand, by an agent, or after
 * six failed attempts — keeps every event queued, and resuming sends the queue
 * oldest first, so this says how many are waiting rather than "failed".
 */
function DeliveryPanel({ integration }: { integration: IntegrationDto }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(integration.delivery?.url ?? 'https://');
  const [secret, setSecret] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const delivery = integration.delivery;
  const deliveries = useQuery({
    queryKey: [...queryKeys.integrations, integration.id, 'deliveries'],
    queryFn: () => api.integrations.deliveries(integration.id),
    enabled: history,
  });
  const refresh = () => client.invalidateQueries({ queryKey: queryKeys.integrations });
  const act = (
    run: () => Promise<{ integration: IntegrationDto }>,
    done: string,
    fallback: string,
  ) =>
    void (async () => {
      try {
        const { integration: next } = await run();
        await refresh();
        if (next.deliverySecret) setSecret(next.deliverySecret);
        notify(done);
      } catch (err) {
        failure(err, fallback);
      }
    })();

  return (
    <div className="flex flex-col gap-1.5" data-delivery={delivery ? 'push' : 'pull'}>
      <span className="instrument">Events</span>
      {delivery ? (
        <>
          <div className="instrument break-words whitespace-normal">pushed to {delivery.url}</div>
          <div
            className="instrument break-words whitespace-normal"
            data-delivery-state={delivery.pausedAt ? 'paused' : 'delivering'}
          >
            {delivery.pausedAt ? `paused ${fullTime(delivery.pausedAt)}` : 'delivering'}
            {delivery.pending > 0 ? ` · ${delivery.pending} waiting` : ''}
            {delivery.lastError ? ` · last try: ${delivery.lastError}` : ''}
          </div>
          <div className="flex flex-wrap gap-2">
            {delivery.pausedAt ? (
              <button
                className="btn btn-accent"
                onClick={() =>
                  act(
                    () => api.integrations.resumeDelivery(integration.id),
                    'Resumed — sending what was waiting, oldest first',
                    'Could not resume',
                  )
                }
              >
                Resume
              </button>
            ) : (
              <button
                className="btn"
                onClick={() =>
                  act(
                    () => api.integrations.pauseDelivery(integration.id),
                    'Paused — events keep queueing',
                    'Could not pause',
                  )
                }
              >
                Pause
              </button>
            )}
            <button
              className="btn"
              onClick={() =>
                act(
                  () => api.integrations.testDelivery(integration.id),
                  delivery.pausedAt
                    ? 'Test sent — if the portal answers, delivery resumes'
                    : 'Test sent',
                  'Could not send a test',
                )
              }
            >
              Send test
            </button>
            <button className="btn" onClick={() => setHistory(!history)}>
              {history ? 'Hide history' : 'History'}
            </button>
            <button className="btn" onClick={() => setEditing(true)}>
              Change
            </button>
          </div>
          {history ? (
            deliveries.data?.attempts.length ? (
              <ul className="flex flex-col gap-0.5" data-delivery-history>
                {deliveries.data.attempts.slice(0, 20).map((attempt) => (
                  <li key={attempt.id} className="instrument break-words whitespace-normal">
                    {fullTime(attempt.createdAt)} · {attempt.event} · try {attempt.attempt} ·{' '}
                    {attempt.status ?? attempt.error ?? 'no answer'}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12.5px] text-[color:var(--paper-faint)]">
                {deliveries.isPending ? 'Loading…' : 'Nothing sent yet.'}
              </p>
            )
          ) : null}
        </>
      ) : (
        <>
          <p className="text-[12.5px] text-[color:var(--paper-faint)]">
            The portal pulls events (ids only) from On My Radar. Add its receiver to have them
            pushed as they happen, signed.
          </p>
          <div>
            <button className="btn" onClick={() => setEditing(true)}>
              Add receiver
            </button>
          </div>
        </>
      )}

      {editing ? (
        <Modal
          title={delivery ? 'Change where events go' : 'Push events to the portal'}
          description="A public https address on the portal. Each event carries ids only; the portal fetches the rest through its token."
          onClose={() => setEditing(false)}
          footer={
            <>
              {delivery ? (
                <button
                  className="btn btn-danger mr-auto"
                  onClick={() => {
                    setEditing(false);
                    act(
                      () => api.integrations.setDelivery(integration.id, null),
                      'Stopped pushing — the portal can still pull',
                      'Could not stop pushing',
                    );
                  }}
                >
                  Stop pushing
                </button>
              ) : null}
              <button className="btn" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button
                className="btn btn-accent"
                disabled={!url.trim().startsWith('https://')}
                onClick={() => {
                  setEditing(false);
                  act(
                    () => api.integrations.setDelivery(integration.id, url.trim()),
                    'Saved',
                    'Could not save the receiver',
                  );
                }}
              >
                Save
              </button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <input
              className="field"
              value={url}
              autoFocus
              inputMode="url"
              aria-label="Receiver URL"
              onChange={(event) => setUrl(event.target.value)}
            />
            {delivery ? (
              <button
                className="btn self-start"
                onClick={() => {
                  setEditing(false);
                  act(
                    () => api.integrations.rotateDeliverySecret(integration.id),
                    'New signing secret issued',
                    'Could not issue a new secret',
                  );
                }}
              >
                <RotateCw className="h-4 w-4" />
                New signing secret
              </button>
            ) : (
              <p className="text-[12.5px] leading-relaxed text-[color:var(--paper-dim)]">
                A signing secret is shown once when you save. The portal verifies every delivery
                with it before reading it.
              </p>
            )}
          </div>
        </Modal>
      ) : null}
      {secret ? <SecretOnce secret={secret} onClose={() => setSecret(null)} /> : null}
    </div>
  );
}

/** One integration's row: its tokens, its reach, and the acts on it. */
function IntegrationRow({
  integration,
  onIssued,
}: {
  integration: IntegrationDto;
  onIssued: (token: string) => void;
}) {
  const client = useQueryClient();
  const [rotating, setRotating] = useState(false);
  const [overlap, setOverlap] = useState('2');
  const [revoking, setRevoking] = useState(false);
  const refresh = () => client.invalidateQueries({ queryKey: queryKeys.integrations });
  const revoked = integration.revokedAt !== null;

  return (
    <li className="flex flex-col gap-2 py-3" data-integration={integration.id}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px]">{integration.name}</div>
          <div className="instrument break-words whitespace-normal">
            replies to clients as “{integration.staffDisplayName}”
          </div>
          {revoked ? (
            <div className="instrument text-[color:var(--paper-faint)]">
              revoked {fullTime(integration.revokedAt ?? '')}
            </div>
          ) : (
            <>
              <div className="instrument break-words whitespace-normal">
                {integration.tokenPrefix}… ·{' '}
                {integration.tokenLastUsedAt
                  ? `last used ${fullTime(integration.tokenLastUsedAt)}`
                  : 'not used yet'}{' '}
                · expires {fullTime(integration.expiresAt)}
              </div>
              {integration.previous ? (
                <div className="instrument break-words whitespace-normal">
                  previous token works until {fullTime(integration.previous.expiresAt)} ·{' '}
                  {integration.previous.lastUsedAt
                    ? `last used ${fullTime(integration.previous.lastUsedAt)}`
                    : 'not used since the rotation'}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>

      {!revoked ? (
        <>
          {integration.enrolments.length === 0 ? (
            <p className="text-[12.5px] text-[color:var(--paper-faint)]">
              Reaches no Helpdesk yet. Connect one from that Helpdesk’s settings → Client portal.
            </p>
          ) : (
            <ul className="flex flex-col gap-1 text-[13px]">
              {integration.enrolments.map((enrolment) => (
                <li key={enrolment.id} className="flex flex-wrap items-baseline gap-x-2">
                  <Link
                    to="/radar/$radarId/settings"
                    params={{ radarId: enrolment.radarId }}
                    search={{ section: 'portal' }}
                    className="accent-text hover:underline"
                  >
                    {enrolment.radarName}
                  </Link>
                  {enrolment.externalRef ? (
                    <span className="instrument">website {enrolment.externalRef}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <DeliveryPanel integration={integration} />
          <div className="flex flex-wrap gap-2">
            <button className="btn" onClick={() => setRotating(true)}>
              <RotateCw className="h-4 w-4" />
              Rotate token
            </button>
            {integration.previous ? (
              <button
                className="btn"
                onClick={() =>
                  void (async () => {
                    try {
                      await api.integrations.revokePrevious(integration.id);
                      await refresh();
                      notify('The previous token no longer works');
                    } catch (err) {
                      failure(err, 'Could not stop the previous token');
                    }
                  })()
                }
              >
                Stop previous token now
              </button>
            ) : null}
            <button className="btn btn-danger" onClick={() => setRevoking(true)}>
              Revoke
            </button>
          </div>
        </>
      ) : null}

      {rotating ? (
        <Modal
          title={`Rotate ${integration.name}'s token?`}
          description="A new token is shown once. Until the portal has it, keep the old one working for a while."
          onClose={() => setRotating(false)}
          footer={
            <>
              <button className="btn" onClick={() => setRotating(false)}>
                Cancel
              </button>
              <button
                className="btn btn-accent"
                onClick={() =>
                  void (async () => {
                    try {
                      const { integration: rotated } = await api.integrations.rotate(
                        integration.id,
                        { overlapHours: Number(overlap) },
                      );
                      setRotating(false);
                      await refresh();
                      if (rotated.token) onIssued(rotated.token);
                    } catch (err) {
                      failure(err, 'Could not rotate the token');
                    }
                  })()
                }
              >
                Rotate
              </button>
            </>
          }
        >
          <label className="flex flex-col gap-1.5">
            <span className="instrument">The old token</span>
            <Select
              className="field"
              aria-label="How long the old token keeps working"
              value={overlap}
              onValueChange={setOverlap}
              options={OVERLAPS}
            />
            <span className="text-[12.5px] text-[color:var(--paper-dim)]">
              The new token expires in {INTEGRATION_LIMITS.expiryDays} days. Store it where the
              portal reads it, let the portal pick it up, then watch “previous token … last used”
              stop moving.
            </span>
          </label>
        </Modal>
      ) : null}

      {revoking ? (
        <ConfirmDialog
          title={`Revoke ${integration.name}?`}
          confirmLabel="Revoke for good"
          danger
          body="The portal stops working immediately and every Helpdesk is disconnected from it. This cannot be undone: connecting again means a new portal and connecting each Helpdesk again. Requests filed through this one stay on your Helpdesks, but a new portal does not see them. If its token leaked, rotate it with the old token stopped now instead."
          onClose={() => setRevoking(false)}
          onConfirm={() =>
            void (async () => {
              setRevoking(false);
              try {
                await api.integrations.revoke(integration.id);
                await refresh();
                notify('Revoked');
              } catch (err) {
                failure(err, 'Could not revoke it');
              }
            })()
          }
        />
      ) : null}
    </li>
  );
}

/** Settings → Connections. Shown to admins and to anyone who already has a portal (routes/settings.tsx). */
export function IntegrationsSection() {
  const client = useQueryClient();
  const query = useIntegrations();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<string | null>(null);
  const list = query.data?.integrations ?? [];

  return (
    <Section title="Integrations">
      <div className="flex items-start gap-3">
        <Plug className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--accent-from)]" />
        <p className="min-w-0 text-[13.5px] leading-relaxed text-[color:var(--paper-dim)]">
          The client portal files requests on the Helpdesks you connect, shows each client their own
          requests and the replies you release, and posts their answers back. It never sees internal
          notes, tags, or replies waiting for your review.
        </p>
      </div>
      <div className="flex items-center justify-between">
        <span className="instrument">Client portals</span>
        <button className="btn" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" />
          Connect a portal
        </button>
      </div>
      {query.isPending ? null : list.length === 0 ? (
        <p className="text-[13px] text-[color:var(--paper-faint)]">
          No portal connected. Connect one, then connect each Helpdesk it should reach.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-[color:var(--line-soft)]">
          {list.map((integration) => (
            <IntegrationRow key={integration.id} integration={integration} onIssued={setIssued} />
          ))}
        </ul>
      )}

      {creating ? (
        <Modal
          title="Connect a client portal"
          description="Name it after the system that will hold the token."
          onClose={() => setCreating(false)}
          footer={
            <>
              <button className="btn" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button
                className="btn btn-accent"
                disabled={busy || !name.trim()}
                onClick={() =>
                  void (async () => {
                    setBusy(true);
                    try {
                      const { integration } = await api.integrations.create({ name: name.trim() });
                      setCreating(false);
                      await client.invalidateQueries({ queryKey: queryKeys.integrations });
                      if (integration.token) setIssued(integration.token);
                    } catch (err) {
                      failure(err, 'Could not connect it');
                    } finally {
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
          <div className="flex flex-col gap-3">
            <input
              className="field"
              value={name}
              autoFocus
              aria-label="Portal name"
              placeholder="Portal name"
              maxLength={INTEGRATION_LIMITS.name}
              onChange={(event) => setName(event.target.value)}
            />
            <p className="text-[12.5px] leading-relaxed text-[color:var(--paper-dim)]">
              It reaches nothing until you connect a Helpdesk to it. Clients see replies signed
              “Workshop &amp; Web Support”, never your name. The token expires in{' '}
              {INTEGRATION_LIMITS.expiryDays} days.
            </p>
          </div>
        </Modal>
      ) : null}

      {issued ? <TokenOnce token={issued} onClose={() => setIssued(null)} /> : null}
    </Section>
  );
}

/**
 * A Helpdesk's "Client portal" tab: which portal reaches it, and the switch.
 * Disconnecting is final for that connection, and the dialog says so.
 */
export function HelpdeskPortalPanel({ radar }: { radar: RadarDto }) {
  const client = useQueryClient();
  const query = useIntegrations();
  const [refs, setRefs] = useState<Record<string, string>>({});
  const [leaving, setLeaving] = useState<IntegrationDto | null>(null);
  const live = (query.data?.integrations ?? []).filter((i) => i.revokedAt === null);
  const refresh = () => client.invalidateQueries({ queryKey: queryKeys.integrations });

  return (
    <Section title="Client portal">
      <p className="text-[13.5px] leading-relaxed text-[color:var(--paper-dim)]">
        A connected portal can list this Helpdesk’s requests to the client account that filed each
        one, file new requests, and post that client’s replies. It sees the request, its client
        status and the replies you release — never internal notes, tags, lanes, or drafts waiting
        for review.
      </p>
      {query.isPending ? null : live.length === 0 ? (
        <p className="text-[13px] text-[color:var(--paper-faint)]">
          No client portal is connected to your account.{' '}
          <Link to="/settings/connections" className="accent-text hover:underline">
            Connect one in Settings → Connections.
          </Link>
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-[color:var(--line-soft)]">
          {live.map((integration) => {
            const enrolment = integration.enrolments.find((e) => e.radarId === radar.id);
            return (
              <li key={integration.id} className="flex flex-col gap-2 py-3">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-[13.5px]">{integration.name}</span>
                  <span className="instrument">
                    {enrolment
                      ? `connected ${fullTime(enrolment.enrolledAt)}${
                          enrolment.externalRef ? ` · website ${enrolment.externalRef}` : ''
                        }`
                      : 'not connected'}
                  </span>
                </div>
                {enrolment ? (
                  <div>
                    <button className="btn" onClick={() => setLeaving(integration)}>
                      Disconnect
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      className="field max-w-[260px]"
                      aria-label="Website reference (optional)"
                      placeholder="Website reference (optional)"
                      maxLength={INTEGRATION_LIMITS.externalRef}
                      value={refs[integration.id] ?? ''}
                      onChange={(event) =>
                        setRefs({ ...refs, [integration.id]: event.target.value })
                      }
                    />
                    <button
                      className="btn btn-accent"
                      onClick={() =>
                        void (async () => {
                          const externalRef = (refs[integration.id] ?? '').trim();
                          try {
                            await api.integrations.enrol(integration.id, {
                              radarId: radar.id,
                              ...(externalRef ? { externalRef } : {}),
                            });
                            await refresh();
                            notify(`Connected to ${integration.name}`);
                          } catch (err) {
                            failure(err, 'Could not connect it');
                          }
                        })()
                      }
                    >
                      Connect
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {leaving ? (
        <ConfirmDialog
          title={`Disconnect from ${leaving.name}?`}
          confirmLabel="Disconnect"
          danger
          body="The portal stops listing this Helpdesk’s requests and cannot post to it, from its next call. Connecting again later is a new connection you make here. Requests already filed stay on this radar."
          onClose={() => setLeaving(null)}
          onConfirm={() =>
            void (async () => {
              const integration = leaving;
              setLeaving(null);
              try {
                await api.integrations.unenrol(integration.id, radar.id);
                await refresh();
                notify('Disconnected');
              } catch (err) {
                failure(err, 'Could not disconnect it');
              }
            })()
          }
        />
      ) : null}
    </Section>
  );
}
