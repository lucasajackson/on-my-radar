import { Select } from './select';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pause, Play, Plus, Rss, Trash2 } from 'lucide-react';
import { createFeedSchema, type FeedDto, type FeedLookback } from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { fullTime, relativeTime } from '../lib/format';
import { ConfirmDialog, Modal, Section, Spinner, notify } from './primitives';
import { QueryError } from './query-error';

const HISTORY: Array<{ value: FeedLookback; label: string }> = [
  { value: 'forever', label: 'Forever — all available posts' },
  { value: 'year', label: 'Past year' },
  { value: 'month', label: 'Past month' },
  { value: 'week', label: 'Past week' },
  { value: 'day', label: 'Past day' },
];
const feedKey = (radarId: string) => ['feeds', radarId] as const;

export function FeedSources({ radarId }: { radarId: string }) {
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const query = useQuery({
    queryKey: feedKey(radarId),
    queryFn: () => api.feeds.list(radarId),
    refetchInterval: 20_000,
  });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: feedKey(radarId) });
  };
  return (
    <Section
      title="RSS feeds"
      action={
        <button className="btn btn-accent" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" />
          Add RSS feed
        </button>
      }
    >
      <p className="note">
        Bring new posts into this radar automatically. Each feed entry becomes a blip.
      </p>
      {query.isLoading ? (
        <Spinner label="Loading feeds" />
      ) : query.error ? (
        <QueryError resource="RSS feeds" error={query.error} retry={() => query.refetch()} />
      ) : query.data?.feeds.length ? (
        <ul className="divide-y divide-[color:var(--line-soft)]">
          {query.data.feeds.map((feed) => (
            <FeedRow key={feed.id} feed={feed} onChanged={refresh} />
          ))}
        </ul>
      ) : (
        <div className="flex items-start gap-3 rounded-lg border border-dashed border-[color:var(--line)] p-4">
          <Rss className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--paper-faint)]" />
          <div className="min-w-0">
            <p className="text-[14px] font-medium">No feeds yet</p>
            <p className="note mt-1">
              Add an RSS or Atom feed and choose how much existing history to import.
            </p>
          </div>
        </div>
      )}
      {creating ? (
        <FeedEditor
          radarId={radarId}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            refresh();
          }}
        />
      ) : null}
    </Section>
  );
}

function FeedRow({ feed, onChanged }: { feed: FeedDto; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const change = async (remove: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      if (remove) await api.feeds.remove(feed.radarId, feed.id);
      else await api.feeds.update(feed.radarId, feed.id, { enabled: !feed.enabled });
      onChanged();
      setRemoving(false);
      notify(
        remove
          ? 'Feed removed. Imported blips kept.'
          : feed.enabled
            ? 'Feed paused'
            : 'Feed resumed',
      );
    } catch (error) {
      notify(error instanceof ApiError ? error.message : 'Could not update the feed', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex flex-col gap-3 py-4 first:pt-1 last:pb-1">
      <div className="flex items-start gap-3">
        <Rss className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--paper-dim)]" />
        <div className="min-w-0 flex-1">
          <p className="break-words text-[14px] font-medium">{feed.title || 'RSS feed'}</p>
          <p className="note break-all">{feed.url}</p>
        </div>
        <span
          className="instrument status-state shrink-0"
          data-state={!feed.enabled ? 'paused' : feed.lastSuccessAt ? 'active' : 'pending'}
        >
          {!feed.enabled ? 'Paused' : feed.lastSuccessAt ? 'Active' : 'First import queued'}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="note mr-auto">
          {feed.itemCount} imported
          {feed.lastSuccessAt ? (
            <>
              {' '}
              · checked{' '}
              <time dateTime={feed.lastSuccessAt} title={fullTime(feed.lastSuccessAt)}>
                {relativeTime(feed.lastSuccessAt)}
              </time>
            </>
          ) : null}
        </p>
        <button
          className="btn btn-ghost"
          disabled={busy}
          onClick={() => void change(false)}
          aria-label={`${feed.enabled ? 'Pause' : 'Resume'} ${feed.title || feed.url}`}
        >
          {feed.enabled ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          {feed.enabled ? 'Pause' : 'Resume'}
        </button>
        <button
          className="btn btn-ghost"
          disabled={busy}
          onClick={() => setRemoving(true)}
          aria-label={`Remove ${feed.title || feed.url}`}
        >
          <Trash2 className="h-4 w-4" />
          Remove
        </button>
      </div>
      {feed.lastError ? (
        <p className="note" role="status" style={{ color: 'var(--danger)' }}>
          Last check failed: {feed.lastError}.{' '}
          {feed.enabled ? 'We will try again automatically.' : 'Resume this feed to try again.'}
        </p>
      ) : null}
      {removing ? (
        <ConfirmDialog
          title="Remove this feed?"
          body="New posts will stop importing. Blips already imported from this feed stay on your radar."
          confirmLabel="Remove feed"
          busy={busy}
          onClose={() => setRemoving(false)}
          onConfirm={() => void change(true)}
        />
      ) : null}
    </li>
  );
}

function FeedEditor({
  radarId,
  onClose,
  onCreated,
}: {
  radarId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [url, setUrl] = useState('');
  const [lookback, setLookback] = useState<FeedLookback | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (busy || !url.trim() || !lookback) return;
    const parsed = createFeedSchema.safeParse({ url: url.trim(), lookback });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the feed URL and history selection.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.feeds.create(radarId, parsed.data);
      onCreated();
    } catch (failure) {
      setError(
        failure instanceof ApiError
          ? failure.message
          : 'Could not add this feed. Check the URL and try again.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Add RSS feed"
      description="New feed entries will appear as blips on this radar."
      onClose={onClose}
      footer={
        <>
          <button className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-accent"
            disabled={busy || !url.trim() || !lookback}
            onClick={() => void submit()}
          >
            {busy ? 'Adding…' : 'Add feed'}
          </button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="instrument">Feed URL</span>
          <input
            className="field"
            type="url"
            autoFocus
            required
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/feed.xml"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="instrument">Import existing posts</span>
          <Select
            className="field"
            required
            value={lookback}
            onValueChange={(value) => setLookback(value as FeedLookback | '')}
            options={[
              { value: '', label: 'Choose how much history to import', disabled: true },
              ...HISTORY,
            ]}
          />
        </label>
        <p className="note">
          Imports matching entries still supplied by the feed, then new posts automatically. A feed
          may contain only its most recent posts. Time-limited imports skip posts without a
          publication date; Forever includes them.
        </p>
        {error ? (
          <p className="note" role="alert" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
