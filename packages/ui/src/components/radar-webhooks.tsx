import { Select } from './select';
import { QueryError } from './query-error';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Pause, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { CopyButton } from './copy-button';
import { type RadarDto, type WebhookDto } from '@onmyradar/contract';
import { queryKeys } from '../lib/session';
import { ApiError, api } from '../lib/api';
import { ConfirmDialog, Section, notify } from './primitives';

export function WebhooksPanel({ radar }: { radar: RadarDto }) {
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ name: string; url: string } | null>(null);

  const query = useQuery({
    queryKey: queryKeys.webhooks(radar.id),
    queryFn: () => api.radars.webhooks(radar.id),
  });

  const refresh = () => client.invalidateQueries({ queryKey: queryKeys.webhooks(radar.id) });
  const webhooks = query.data?.webhooks ?? [];

  return (
    // `Section` rather than a heading of its own: this panel is now one of two
    // directions on the tab, and the outbound one is a Section. Two blocks that
    // are peers have to be labelled the same way or the page reads as a heading
    // with a footnote under it.
    <Section title="Inbound webhooks" bare>
      <p className="note">
        Give this radar a URL. Anything that can POST to it — a form, a build, an alert — becomes a
        blip.
      </p>
      <div className="flex flex-col gap-4">
        {secret ? <SecretPanel secret={secret} onDone={() => setSecret(null)} /> : null}

        {query.isLoading ? (
          <p className="instrument py-4">loading</p>
        ) : query.error ? (
          <QueryError error={query.error} resource="Webhooks" retry={() => query.refetch()} />
        ) : webhooks.length === 0 && !creating ? (
          <p className="note py-2">
            Nothing sends to this radar yet. A webhook is the way to get something out of another
            system and into your thinking without you having to copy it across.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-[color:var(--line-soft)]">
            {webhooks.map((webhook) => (
              <WebhookRow
                key={webhook.id}
                webhook={webhook}
                onChanged={() => void refresh()}
                onRotated={(url) => {
                  setSecret({ name: webhook.name, url });
                  void refresh();
                }}
              />
            ))}
          </ul>
        )}

        {creating ? (
          <NewWebhookForm
            radarId={radar.id}
            onCancel={() => setCreating(false)}
            onCreated={(webhook) => {
              setCreating(false);
              if (webhook.secretUrl) setSecret({ name: webhook.name, url: webhook.secretUrl });
              void refresh();
            }}
          />
        ) : (
          <div className="flex justify-end border-t border-[color:var(--line-soft)] pt-4">
            <button className="btn btn-accent" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              New webhook
            </button>
          </div>
        )}
      </div>
    </Section>
  );
}

/** The one moment the token is visible. Deliberately loud, and deliberately sticky. */
function SecretPanel({
  secret,
  onDone,
}: {
  secret: { name: string; url: string };
  onDone: () => void;
}) {
  return (
    <div className="panel flex flex-col gap-2 p-3" style={{ borderColor: 'var(--accent-from)' }}>
      <span className="instrument accent-text">{secret.name} · shown once</span>
      <div className="flex gap-2">
        <input className="field font-mono text-[12px]" readOnly value={secret.url} />
        <CopyButton value={secret.url} />
      </div>
      <p className="text-[12.5px] leading-relaxed text-[color:var(--paper-dim)]">
        Paste this into whatever will be sending. It is not stored anywhere you can read it back —
        if you lose it, issue a new one. Anyone holding it can write to this radar.
      </p>
      <button className="btn btn-ghost self-end" onClick={onDone}>
        Done, I have saved it
      </button>
    </div>
  );
}

function WebhookRow({
  webhook,
  onChanged,
  onRotated,
}: {
  webhook: WebhookDto;
  onChanged: () => void;
  onRotated: (url: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<'rotate' | 'delete' | null>(null);

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await run();
      onChanged();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'That did not work', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex items-start gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[13.5px]">
          <span className="truncate font-medium">{webhook.name}</span>
          {!webhook.enabled ? <span className="instrument">paused</span> : null}
        </div>
        <div className="instrument mt-0.5 truncate">
          {webhook.deliveryCount} delivered
          {webhook.lastDeliveryAt
            ? ` · last ${new Date(webhook.lastDeliveryAt).toLocaleDateString()}`
            : ''}
          {webhook.tags.length > 0 ? ` · ${webhook.tags.map((t) => `#${t}`).join(' ')}` : ''}
          {` · ${webhook.format}`}
        </div>
        {webhook.lastError ? (
          <p className="mt-1 text-[12.5px] text-[color:var(--danger)]">
            Last failure: {webhook.lastError}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          className="btn btn-ghost p-1.5"
          title={webhook.enabled ? 'Pause' : 'Resume'}
          aria-label={webhook.enabled ? `Pause ${webhook.name}` : `Resume ${webhook.name}`}
          disabled={busy}
          onClick={() =>
            void act(() => api.webhooks.update(webhook.id, { enabled: !webhook.enabled }))
          }
        >
          {webhook.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </button>
        <button
          className="btn btn-ghost p-1.5"
          title="Issue a new URL"
          aria-label={`Issue a new URL for ${webhook.name}`}
          disabled={busy}
          onClick={() => setConfirming('rotate')}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
        <button
          className="btn btn-ghost p-1.5"
          title="Delete"
          aria-label={`Delete ${webhook.name}`}
          disabled={busy}
          onClick={() => setConfirming('delete')}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {confirming === 'rotate' ? (
        <ConfirmDialog
          title="Issue a new URL?"
          confirmLabel="Issue a new URL"
          busy={busy}
          body={
            <>
              The current URL for{' '}
              <strong className="text-[color:var(--paper)]">{webhook.name}</strong> stops working
              immediately. Anything already configured to POST to it will start failing until you
              paste the new one in.
            </>
          }
          onClose={() => setConfirming(null)}
          onConfirm={() =>
            void (async () => {
              setConfirming(null);
              setBusy(true);
              try {
                const { webhook: rotated } = await api.webhooks.rotate(webhook.id);
                if (rotated.secretUrl) onRotated(rotated.secretUrl);
              } catch (err) {
                notify(err instanceof ApiError ? err.message : 'Could not rotate', 'error');
              } finally {
                setBusy(false);
              }
            })()
          }
        />
      ) : null}

      {confirming === 'delete' ? (
        <ConfirmDialog
          title={`Delete "${webhook.name}"?`}
          confirmLabel="Delete it"
          danger
          busy={busy}
          body="Its URL dies immediately and cannot be brought back. Blips it has already delivered stay on the radar."
          onClose={() => setConfirming(null)}
          onConfirm={() => {
            setConfirming(null);
            void act(() => api.webhooks.remove(webhook.id));
          }}
        />
      ) : null}
    </li>
  );
}

function NewWebhookForm({
  radarId,
  onCancel,
  onCreated,
}: {
  radarId: string;
  onCancel: () => void;
  onCreated: (webhook: WebhookDto) => void;
}) {
  const [name, setName] = useState('');
  const [format, setFormat] = useState<'auto' | 'template'>('auto');
  const [bodyTemplate, setBodyTemplate] = useState('');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const { webhook } = await api.radars.createWebhook(radarId, {
        name: name.trim(),
        format,
        ...(format === 'template' ? { bodyTemplate } : {}),
        tags: tags
          .split(/[,\s]+/)
          .map((t) => t.trim())
          .filter(Boolean),
      });
      onCreated(webhook);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not create that webhook', 'error');
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 border-t border-[color:var(--line-soft)] pt-4">
      <label className="flex flex-col gap-1.5">
        <span className="instrument">What will be sending?</span>
        <input
          className="field"
          value={name}
          autoFocus
          placeholder="Roving Studio contact form"
          onChange={(e) => setName(e.target.value)}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="instrument">Tags on every blip it creates</span>
        <input
          className="field"
          value={tags}
          placeholder="forms leads"
          onChange={(e) => setTags(e.target.value)}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="instrument">Body</span>
        <Select
          className="field"
          value={format}
          onValueChange={(value) => setFormat(value as 'auto' | 'template')}
          options={[
            { value: 'auto', label: 'Work it out from the payload' },
            { value: 'template', label: 'Write my own template' },
          ]}
        />
      </label>

      {format === 'auto' ? (
        <p className="text-[12.5px] leading-relaxed text-[color:var(--paper-dim)]">
          A payload with one obvious message field is used as-is. Anything else — a form submission
          with eleven fields — becomes one labelled line per field, so nothing is thrown away.
        </p>
      ) : (
        <label className="flex flex-col gap-1.5">
          <span className="instrument">Template</span>
          <textarea
            className="field font-mono text-[12.5px]"
            rows={4}
            value={bodyTemplate}
            placeholder={'{{name}} asked about {{service}}\n\n{{message}}'}
            onChange={(e) => setBodyTemplate(e.target.value)}
          />
          <span className="text-[12.5px] text-[color:var(--paper-dim)]">
            {'{{field.path}}'} is replaced from the payload. Markdown works, and #hashtags in the
            result become tags like anywhere else.
          </span>
        </label>
      )}

      <div className="flex justify-end gap-2">
        <button className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          className="btn btn-accent"
          disabled={busy || !name.trim() || (format === 'template' && !bodyTemplate.trim())}
          onClick={() => void create()}
        >
          <Link2 className="h-4 w-4" />
          Create and show me the URL
        </button>
      </div>
    </div>
  );
}
