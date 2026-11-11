import { Select } from './select';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Plus, Users } from 'lucide-react';
import { DEFAULT_RADAR_ACCENT, type RadarDto, type TopicDto } from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { Modal, notify } from './primitives';
import { queryKeys, useTopics } from '../lib/session';
import { AppearancePicker } from './appearance';

export function NewTopicDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (topic: TopicDto) => void;
}) {
  const [name, setName] = useState('');
  const [tagline, setTagline] = useState('');
  const [accent, setAccent] = useState<string>(DEFAULT_RADAR_ACCENT);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    try {
      const { topic } = await api.topics.create({ name: name.trim(), tagline, accent });
      onCreated(topic);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not create the array', 'error');
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New array"
      description="A place to keep related radars together. It groups them — it does not share them."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-accent"
            disabled={busy || !name.trim()}
            onClick={() => void create()}
          >
            <Users className="h-4 w-4" />
            Create array
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="instrument">Name</span>
          <input
            className="field"
            value={name}
            autoFocus
            placeholder="I Am Well Foundation"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void create();
            }}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="instrument">Tagline</span>
          <input
            className="field"
            value={tagline}
            placeholder="Optional — what is this group for?"
            onChange={(e) => setTagline(e.target.value)}
          />
        </label>
        {/* No glyph half: an array's mark is not offered here, and a disclosure
            that opens onto a control which changes nothing is worse than none. */}
        <AppearancePicker accent={accent} onAccent={setAccent} label="Colour" />
        {/* Said here rather than discovered later. The cascade is the thing a
            person will assume a "topic" already does. */}
        <p className="note">
          Sharing follows the radar, not the array. You can turn on sharing for everything in a
          array later, from the array&rsquo;s own screen, which says who it will reach before you
          do.
        </p>
      </div>
    </Modal>
  );
}

/**
 * Changing a topic's name, tagline, description or colour.
 *
 * `PATCH /api/topics/:id` and `api.topics.update` both existed and **nothing in
 * `packages/ui` called either** — the identical shape `api.topics.create` was in
 * when topics turned out to be uncreatable. So a topic named wrong at the moment
 * it was made stayed named wrong forever, short of deleting it and rebuilding
 * it, which is a destructive act to fix a typo.
 *
 * The cascade switch is deliberately not here, for the same reason it is not on
 * the create form: it lives on `/array/:id` where the live numbers can say what
 * it will grant and to whom. This dialog changes what a topic is *called*, never
 * who can reach it — so it can be opened from a list without anybody worrying
 * about what a stray click might give away.
 */
export function EditTopicDialog({
  topic,
  onClose,
  onSaved,
}: {
  topic: TopicDto;
  onClose: () => void;
  onSaved: (topic: TopicDto) => void;
}) {
  const [name, setName] = useState(topic.name);
  const [tagline, setTagline] = useState(topic.tagline ?? '');
  const [description, setDescription] = useState(topic.description ?? '');
  const [accent, setAccent] = useState<string>(topic.accent);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    try {
      const { topic: saved } = await api.topics.update(topic.id, {
        name: name.trim(),
        tagline,
        description,
        accent,
      });
      notify('Array saved');
      onSaved(saved);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not save the array', 'error');
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Array settings"
      description="What this group is called. Who can reach it is on the array's own screen."
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-accent"
            disabled={busy || !name.trim()}
            onClick={() => void save()}
          >
            <Check className="h-4 w-4" />
            Save
          </button>
        </>
      }
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="instrument">Name</span>
          <input
            className="field"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void save();
            }}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="instrument">Tagline</span>
          <input
            className="field"
            value={tagline}
            placeholder="Optional — what is this group for?"
            onChange={(e) => setTagline(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="instrument">Description</span>
          <textarea
            className="field min-h-[80px]"
            value={description}
            placeholder="Optional"
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <AppearancePicker accent={accent} onAccent={setAccent} label="Colour" />
      </div>
    </Modal>
  );
}

/**
 * Putting a radar into a topic, from the topic's side.
 *
 * The radar's own settings dialog has carried `TopicPicker` since topics
 * shipped, and that is the right control for "where does this radar live". It is
 * the wrong control for the thing people actually set out to do, which is
 * "gather these three radars together" — that starts from the group, and doing
 * it one radar at a time through three separate settings dialogs is three times
 * the work in the least obvious place.
 *
 * Only radars the person can **manage** are offered, because filing needs manage
 * on both sides; the drop box and smart radars are excluded because neither can
 * ever be in a topic. Same rule as `TopicPicker`, applied from the other end: do
 * not offer a control that the server will refuse.
 *
 * When the topic cascades, adding a radar to it is an **access change**, not
 * filing — everybody in the topic can reach it the moment it lands. That
 * sentence is on the screen before the click, with the live member count in it,
 * for the same reason the cascade switch itself spells out what it is about to
 * do.
 */
export function AddRadarsDialog({
  topic,
  present,
  onClose,
  onAdded,
}: {
  topic: TopicDto;
  /** Radar ids already in this topic, so they are not offered twice. */
  present: Set<string>;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.radars,
    queryFn: () => api.radars.list(),
  });
  const [busy, setBusy] = useState<string | null>(null);

  const candidates = (data?.radars ?? []).filter(
    (radar) =>
      !present.has(radar.id) &&
      !radar.isDropBox &&
      radar.kind !== 'smart' &&
      radar.access.canManage &&
      radar.topicId !== topic.id,
  );

  /**
   * No toast on success, deliberately — only on failure.
   *
   * The row leaves this list and appears in the topic's own list behind the
   * dialog, so the screen has already said what happened; a toast on top of that
   * is narration of something visible. And at 390px it lands squarely on the
   * Done button of a dialog that stays open, which a phone screenshot showed:
   * confirming an action by covering the way out of it.
   */
  const add = async (radar: RadarDto) => {
    setBusy(radar.id);
    try {
      await api.radars.setTopic(radar.id, topic.id);
      onAdded();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not add that radar', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      title={`Add a radar to ${topic.name}`}
      description="Only radars you can manage, and never the drop box or a smart radar — neither can be in an array."
      onClose={onClose}
    >
      <div className="flex flex-col gap-3">
        {topic.cascade ? (
          <p className="note" style={{ color: 'var(--warn)' }}>
            {topic.name} is shared throughout
            {topic.memberCount > 1
              ? `: everyone in it (${topic.memberCount}) will be able to reach whatever you add.`
              : ', so anyone added to it later will reach whatever you put here.'}
          </p>
        ) : (
          <p className="note">Grouping only — adding a radar here shares it with nobody.</p>
        )}

        {isLoading ? (
          <p className="note" role="status">
            Loading your radars…
          </p>
        ) : error ? (
          <div role="alert" className="flex flex-col items-start gap-2">
            <p className="note">Could not load your radars.</p>
            <button className="btn" onClick={() => void refetch()}>
              Try again
            </button>
          </div>
        ) : candidates.length === 0 ? (
          <p className="note">No eligible radars to add. Create a new radar from the array page.</p>
        ) : (
          <ul className="radar-list max-h-[50vh] overflow-y-auto">
            {candidates.map((radar) => (
              <li key={radar.id}>
                <button
                  className="radar-row w-full text-left"
                  disabled={busy !== null}
                  onClick={() => void add(radar)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium">{radar.name}</span>
                    {radar.topic ? (
                      // Moving, not adding — and moving out of a cascading topic
                      // takes access away from its members. Say which topic it
                      // is leaving rather than letting that happen silently.
                      <span className="instrument mt-0.5 block truncate">
                        moves out of {radar.topic.name}
                      </span>
                    ) : null}
                  </span>
                  <Plus className="h-4 w-4 shrink-0 text-[color:var(--accent-from)]" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex justify-end gap-2 border-t border-[color:var(--line-soft)] pt-4">
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Manageable topics only; inline creation preserves the enclosing radar draft.
 * Cascading access consequences remain visible before the radar is saved. */
export function TopicPicker({
  radar,
  topicId,
  onChange,
}: {
  radar?: RadarDto;
  topicId: string | null;
  onChange: (id: string | null) => void;
}) {
  const { data, isLoading, error, refetch } = useTopics();
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const topics = (data?.topics ?? []).filter((topic) => topic.access.canManage && !topic.archived);
  const chosen = topics.find((topic) => topic.id === topicId);

  const create = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    try {
      const { topic } = await api.topics.create({ name: name.trim() });
      client.setQueryData<{ topics: TopicDto[] }>(queryKeys.topics, (current) => ({
        ...current,
        topics: [...(current?.topics ?? []), topic],
      }));
      onChange(topic.id);
      setName('');
      setCreating(false);
      void client.invalidateQueries({ queryKey: queryKeys.topics });
    } catch (failure) {
      notify(failure instanceof ApiError ? failure.message : 'Could not create the array', 'error');
    } finally {
      setBusy(false);
    }
  };

  if (radar && (radar.isDropBox || radar.kind === 'smart')) return null;

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1.5">
        <span className="instrument">Array</span>
        <Select
          className="field"
          value={topicId ?? ''}
          disabled={isLoading || busy}
          onValueChange={(value) => onChange(value || null)}
          options={[
            { value: '', label: 'No array' },
            ...topics.map((topic) => ({
              value: topic.id,
              label: `${topic.name}${topic.cascade ? ' — shared with everyone in it' : ''}`,
            })),
          ]}
        />
      </label>
      {error ? (
        <p className="note" role="alert">
          Could not load arrays.{' '}
          <button type="button" className="underline" onClick={() => void refetch()}>
            Try again
          </button>
        </p>
      ) : null}
      {chosen?.cascade ? (
        <p className="note" style={{ color: 'var(--warn)' }}>
          {chosen.memberCount > 1
            ? `Everyone in ${chosen.name} (${chosen.memberCount}) will be able to reach this radar.`
            : `${chosen.name} shares every radar in it with its members.`}
        </p>
      ) : chosen ? (
        <p className="note">
          Grouping only — {chosen.name} does not change who can access this radar.
        </p>
      ) : null}
      {creating ? (
        <div className="panel flex flex-col gap-2 p-3">
          <label className="flex flex-col gap-1.5">
            <span className="instrument">New array name</span>
            <input
              className="field"
              autoFocus
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void create();
                }
              }}
              placeholder="Project or interest"
            />
          </label>
          <p className="note">Groups radars together. Nothing is shared by creating an array.</p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => setCreating(false)}
            >
              Cancel array
            </button>
            <button
              type="button"
              className="btn btn-accent"
              disabled={busy || !name.trim()}
              onClick={() => void create()}
            >
              {busy ? 'Creating…' : 'Create array'}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="btn btn-ghost self-start"
          onClick={() => setCreating(true)}
        >
          <Plus className="h-4 w-4" />
          New array
        </button>
      )}
    </div>
  );
}
