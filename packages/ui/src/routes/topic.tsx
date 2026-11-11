import { Select } from '../components/select';
import { QueryError } from '../components/query-error';
/**
 * A topic: the radars in it, who can reach it, and the cascade switch.
 *
 * The design problem this screen exists to solve is that **a topic grant and a
 * radar grant are different things**, and a person has to be able to tell which
 * one they are giving. Every sharing surface in this app until now handed over
 * exactly what it named. A topic does not: sharing it conveys the grouping, and
 * only cascading turns that into access.
 *
 * So the switch is not a checkbox with a label. It is a panel that states, in
 * numbers taken from the current state, what turning it on will grant and to
 * whom — and once on, what turning it off will take away. A setting that
 * silently strips access on toggle is a footgun; one that silently leaves it
 * behind is a leak. Ours does neither, but the only way anybody knows that is if
 * the screen says so at the moment of the choice.
 *
 * The member list under it is the other half. Everyone here reaches every radar
 * in the topic when it cascades, and reaches none of them when it does not, and
 * the list says which of those is true rather than leaving it to be inferred.
 */
import { useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight,
  FolderMinus,
  Pencil,
  Plus,
  Radio,
  Trash2,
  UserMinus,
  Users,
} from 'lucide-react';
import {
  TOPIC_ROLES,
  templateFor,
  type RadarDto,
  type TopicDto,
  type TopicMemberDto,
} from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { accentStyle } from '../lib/theme';
import { queryKeys, useSession } from '../lib/session';
import {
  ConfirmDialog,
  Empty,
  RadarGlyph,
  Section,
  Spinner,
  notify,
} from '../components/primitives';
import { AddRadarsDialog, EditTopicDialog, NewRadarDialog } from '../components/radar-dialogs';
import { useNotificationCounts } from '../components/notifications';
import { useDocumentTitle } from '../lib/title';

export function TopicRoute() {
  const { topicId } = useParams({ from: '/_app/array/$topicId' });
  const { user } = useSession();
  const active = Boolean(user && user.state === 'active');
  const client = useQueryClient();
  const navigate = useNavigate();
  const { data: counts } = useNotificationCounts(active, 'needs_you');
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // The request in flight, separate from the dialog being open: the dialog stays
  // up while it runs, and its button must not send a second delete.
  const [removingTopic, setRemovingTopic] = useState(false);
  /** The radar a detach confirmation is standing over, or null. */
  const [detaching, setDetaching] = useState<RadarDto | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.topic(topicId),
    queryFn: () => api.topics.get(topicId),
    enabled: active,
  });
  useDocumentTitle(data?.topic.name);

  if (isLoading) return <Spinner label="Reading the array" />;
  if (error) return <QueryError error={error} resource="Array" retry={() => refetch()} />;
  if (!data) {
    return (
      <div className="mx-auto max-w-[760px] px-4 py-5 sm:px-6">
        <Empty
          title="Array not found"
          hint="It may have been deleted, or shared with a different account."
        />
      </div>
    );
  }

  const { topic, radars } = data;
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: queryKeys.topic(topicId) });
    void client.invalidateQueries({ queryKey: queryKeys.topics });
    void client.invalidateQueries({ queryKey: queryKeys.radars });
  };

  const remove = async () => {
    if (removingTopic) return;
    setRemovingTopic(true);
    try {
      const { radarsFreed } = await api.topics.remove(topic.id);
      notify(
        radarsFreed > 0
          ? `Array deleted. ${radarsFreed} radar${radarsFreed === 1 ? '' : 's'} kept.`
          : 'Array deleted',
      );
      void client.invalidateQueries({ queryKey: queryKeys.topics });
      void client.invalidateQueries({ queryKey: queryKeys.radars });
      void navigate({ to: '/radars' });
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not delete the array', 'error');
      setRemovingTopic(false);
    }
  };

  /**
   * Taking a radar out of the topic.
   *
   * Withdrawing needs `manage` on only ONE of the two sides — either party can
   * pull out without the other's cooperation — which is why this control is
   * gated on the topic's `canManage` and not the radar's.
   *
   * On a **cascading** topic it is an access change and not filing: everybody in
   * the topic reaches this radar right now and stops the moment it leaves. Their
   * own direct grants on it survive, which is the half people fear is not true,
   * so the confirmation says both. On a non-cascading topic the same act gives
   * and takes nothing, so it just happens.
   */
  const detach = async (radar: RadarDto) => {
    setDetaching(null);
    try {
      await api.radars.setTopic(radar.id, null);
      notify(`${radar.name} is no longer in ${topic.name}`);
      invalidate();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not move that radar', 'error');
    }
  };

  return (
    <div
      className="mx-auto flex max-w-[760px] flex-col gap-6 px-4 py-5 sm:px-6"
      style={accentStyle(topic.accent)}
    >
      <header className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 text-[color:var(--accent-from)]">
          <Users className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[21px] font-semibold tracking-tight">{topic.name}</h1>
          <p className="instrument mt-1">
            {[
              `${topic.radarCount} radar${topic.radarCount === 1 ? '' : 's'}`,
              `${topic.memberCount} member${topic.memberCount === 1 ? '' : 's'}`,
              topic.cascade ? 'shared throughout' : 'grouping only',
              topic.tagline,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        {topic.access.canManage ? (
          <div className="flex shrink-0 items-center gap-1">
            {/*
              Rename. `PATCH /api/topics/:id` and `api.topics.update` both
              existed and neither had a caller anywhere in `packages/ui` — the
              identical shape `api.topics.create` was in when topics turned out
              to be uncreatable. An array named wrong at the moment it was made
              stayed named wrong, and the only way to fix a typo was to delete
              the array and build it again, which is a destructive act to fix a
              spelling mistake.
            */}
            <button
              className="btn btn-ghost"
              onClick={() => setEditing(true)}
              aria-label="Array settings"
              title="Array settings"
            >
              <Pencil className="h-4 w-4" />
              <span className="hidden sm:inline">Edit</span>
            </button>
          </div>
        ) : null}
      </header>

      {topic.description ? (
        <p className="text-[15px] text-[color:var(--paper-dim)]">{topic.description}</p>
      ) : null}

      <Section
        title="Radars"
        bare={radars.length > 0}
        action={
          topic.access.canManage ? (
            <span className="flex flex-wrap justify-end gap-2">
              <button className="btn" onClick={() => setAdding(true)}>
                Add existing
              </button>
              <button className="btn btn-accent" onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" /> New radar
              </button>
            </span>
          ) : undefined
        }
      >
        {radars.length === 0 ? (
          <p className="note">
            {topic.access.canManage
              ? 'Create a radar for this array, or add one you already have.'
              : // Never "there are 3 radars you cannot see" — that would leak
                // their existence, and a radar's name is content.
                'Nothing here you can open yet.'}
          </p>
        ) : (
          <ul className="radar-list">
            {radars.map((radar) => {
              const template = templateFor(radar.template);
              const unread = counts?.byRadar[radar.id] ?? 0;
              return (
                <li key={radar.id} className="topic-row" style={accentStyle(radar.accent)}>
                  <Link
                    to="/radar/$radarId"
                    params={{ radarId: radar.id }}
                    className="radar-row min-w-0 flex-1"
                  >
                    <span className="shrink-0 text-[color:var(--accent-from)]">
                      <RadarGlyph glyph={radar.glyph} className="h-5 w-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-medium">{radar.name}</span>
                      {/*
                        The count sits with the row's own metadata, not in the
                        control cluster. It was a bare `0` between the name and
                        two icon buttons, where a number reads as a value you can
                        change rather than as a fact about the row — and a column
                        of zeros beside every empty radar made new radars look
                        broken. Suppressed at zero, the same rule the unread dot
                        already follows.
                      */}
                      <span className="instrument mt-0.5 block truncate">
                        {[
                          template.id === 'stream' ? null : template.label.toLowerCase(),
                          radar.blipCount > 0
                            ? `${radar.blipCount} ${radar.blipCount === 1 ? 'blip' : 'blips'}`
                            : null,
                          radar.access.via === 'topic' ? 'through this array' : null,
                          radar.tagline,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    {unread > 0 ? (
                      <span className="notification-badge">{unread > 99 ? '99+' : unread}</span>
                    ) : null}
                    <ChevronRight className="h-4 w-4 shrink-0 text-[color:var(--paper-faint)]" />
                  </Link>
                  {topic.access.canManage ? (
                    <>
                      {/*
                        A hairline between "go there" and "take it out".

                        They were 38px apart, the same size, the same weight, no
                        labels — a chevron that navigates and a folder-minus that
                        changes who can reach a radar. Equal weight for unequal
                        risk. The rule separates them and the control says what
                        it does in a word wherever there is room for one.
                      */}
                      <span className="row-split" aria-hidden="true" />
                      <button
                        className="btn btn-ghost shrink-0 text-[12.5px]"
                        aria-label={`Take ${radar.name} out of ${topic.name}`}
                        title="Take out of this array"
                        onClick={() => {
                          // On a cascading topic with other people in it, taking
                          // a radar out is an access change and not filing — so
                          // it asks, with the numbers in it. On a topic that
                          // shares nothing the same act gives and takes nothing,
                          // so it just happens.
                          if (topic.cascade && topic.memberCount > 1) setDetaching(radar);
                          else void detach(radar);
                        }}
                      >
                        <FolderMinus className="h-4 w-4" />
                        <span className="hidden sm:inline">Take out</span>
                      </button>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {topic.access.canManage ? (
        <>
          <CascadePanel topic={topic} onChanged={invalidate} />
          <TopicMembers topic={topic} onChanged={invalidate} />
        </>
      ) : (
        <Section title="Your access">
          <p className="text-[14px] text-[color:var(--paper-dim)]">
            {topic.cascade
              ? `You reach every radar in ${topic.name} because it is shared throughout.`
              : `Being in ${topic.name} groups the radars you have been given. It does not give ` +
                `you access to the others.`}
          </p>
        </Section>
      )}

      {topic.access.canManage ? (
        <div className="flex justify-end border-t border-[color:var(--line-soft)] pt-4">
          <button
            className="btn btn-ghost text-[color:var(--danger)]"
            onClick={() => setDeleting(true)}
            aria-label="Delete this array"
            title="Delete this array"
          >
            <Trash2 className="h-4 w-4" />
            <span>Delete array</span>
          </button>
        </div>
      ) : null}

      {creating ? (
        <NewRadarDialog
          initialTopicId={topic.id}
          onClose={() => setCreating(false)}
          onCreated={(radar) => {
            setCreating(false);
            invalidate();
            void navigate({ to: '/radar/$radarId', params: { radarId: radar.id } });
          }}
        />
      ) : null}

      {editing ? (
        <EditTopicDialog
          topic={topic}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            invalidate();
          }}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title="Delete this array?"
          phrase={topic.name}
          confirmLabel="Delete array"
          danger
          body={
            <>
              This does <strong className="text-[color:var(--paper)]">not</strong> delete the{' '}
              {topic.radarCount === 1 ? 'radar' : `${topic.radarCount} radars`} in it. They keep
              every person they are shared with and simply stop being grouped
              {topic.cascade
                ? ' — except for anyone who reached them only through this array, who loses that access immediately.'
                : '.'}
            </>
          }
          onClose={() => setDeleting(false)}
          busy={removingTopic}
          onConfirm={() => void remove()}
        />
      ) : null}

      {detaching ? (
        <ConfirmDialog
          title={`Take "${detaching.name}" out of ${topic.name}?`}
          confirmLabel="Take it out"
          danger
          body={
            <>
              {topic.name} is shared throughout, so{' '}
              {/* memberCount counts the owner, who is not the one losing anything. */}
              <strong className="text-[color:var(--paper)]">
                {topic.memberCount - 1} {topic.memberCount - 1 === 1 ? 'person' : 'people'}
              </strong>{' '}
              reach this radar through it. Taking it out ends that immediately. Anyone shared on the
              radar itself keeps their access.
            </>
          }
          onClose={() => setDetaching(null)}
          onConfirm={() => void detach(detaching)}
        />
      ) : null}

      {adding ? (
        <AddRadarsDialog
          topic={topic}
          present={new Set(radars.map((radar) => radar.id))}
          onClose={() => setAdding(false)}
          onAdded={invalidate}
        />
      ) : null}
    </div>
  );
}

/**
 * The cascade switch, and the sentence that makes it honest.
 *
 * It states the consequence in live numbers before the click, and it names what
 * happens on the way back out — that direct grants survive — because the fear
 * that stops people using a switch like this is not knowing whether turning it
 * off will take away something they gave somebody on purpose.
 */
function CascadePanel({ topic, onChanged }: { topic: TopicDto; onChanged: () => void }) {
  const others = Math.max(topic.memberCount - 1, 0);
  const [confirming, setConfirming] = useState(false);

  const toggle = useMutation({
    mutationFn: (cascade: boolean) => api.topics.setCascade(topic.id, cascade),
    onSuccess: (_result, cascade) => {
      notify(
        cascade
          ? `${topic.name} now shares its radars with everyone in it`
          : `${topic.name} no longer shares its radars. Direct shares are untouched.`,
      );
      onChanged();
    },
    onError: (err: unknown) =>
      notify(err instanceof ApiError ? err.message : 'Could not change sharing', 'error'),
  });

  return (
    <Section title="Sharing">
      <div className="flex flex-col gap-1.5">
        <p className="text-[14px] text-[color:var(--paper-dim)]">
          {topic.cascade ? (
            <>
              Everyone in this array can reach{' '}
              <strong className="text-[color:var(--paper)]">every radar in it</strong>, including
              radars added later. Turning this off removes exactly that and nothing else — anyone
              you shared a radar with directly keeps it.
            </>
          ) : (
            <>
              Being in this array grants{' '}
              <strong className="text-[color:var(--paper)]">no radar access</strong>. Radars are
              shared one at a time. Turning this on would give{' '}
              {others === 0 ? (
                <>anyone you add</>
              ) : (
                <strong className="text-[color:var(--paper)]">
                  {others} {others === 1 ? 'person' : 'people'}
                </strong>
              )}{' '}
              access to {topic.radarCount === 1 ? 'the radar' : `all ${topic.radarCount} radars`} in
              it, and to any added afterwards. Nobody loses anything they already have.
            </>
          )}
        </p>
      </div>

      <div>
        {/*
          A normal-width secondary control, not a full-width accent gradient.

          It was the loudest element on the page — the visual weight of a primary
          call to action — on the one control that grants people access to every
          radar in the array and every radar added afterwards. Visual weight was
          inverted against risk, with "Add a radar" (safe) a quiet ghost link
          beside it. The paragraph above already carries the persuasion; the
          button does not need to.
        */}
        <button
          className="btn"
          disabled={toggle.isPending}
          onClick={() => {
            if (!topic.cascade && others > 0) setConfirming(true);
            else toggle.mutate(!topic.cascade);
          }}
        >
          <Radio className="h-4 w-4" />
          {topic.cascade ? 'Stop sharing radars through this array' : 'Share every radar in it'}
        </button>
      </div>

      {confirming ? (
        <ConfirmDialog
          title="Share every radar in this array?"
          confirmLabel="Share them"
          busy={toggle.isPending}
          body={
            <>
              This immediately gives{' '}
              <strong className="text-[color:var(--paper)]">
                {others} {others === 1 ? 'person' : 'people'}
              </strong>{' '}
              access to {topic.radarCount === 1 ? 'the radar' : `all ${topic.radarCount} radars`} in{' '}
              {topic.name}, and to any radar added to it later. Nobody loses anything they already
              have, and turning it off again takes back exactly this and nothing else.
            </>
          }
          onClose={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            toggle.mutate(true);
          }}
        />
      ) : null}
    </Section>
  );
}

function TopicMembers({ topic, onChanged }: { topic: TopicDto; onChanged: () => void }) {
  const client = useQueryClient();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [role, setRole] = useState<(typeof TOPIC_ROLES)[number]>('viewer');
  const [removing, setRemoving] = useState<TopicMemberDto | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.topicMembers(topic.id),
    queryFn: () => api.topics.members(topic.id),
  });

  const refresh = () => {
    void client.invalidateQueries({ queryKey: queryKeys.topicMembers(topic.id) });
    onChanged();
  };

  const share = async () => {
    const address = email.trim();
    if (busy || !address) return;
    setBusy(true);
    try {
      const result = await api.topics.share(topic.id, address, role);
      notify(
        result.radarsGranted > 0
          ? `${address} can now reach ${result.radarsGranted} radar${result.radarsGranted === 1 ? '' : 's'}`
          : `${address} was added. They can see the grouping, not the radars.`,
      );
      setEmail('');
      refresh();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not share the array', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="People">
      <p className="note">
        {topic.cascade
          ? 'Everyone here reaches every radar in this array.'
          : 'Everyone here sees the grouping. Radars are shared one at a time.'}
      </p>

      {isLoading ? (
        <p className="note" role="status">
          Loading people…
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="flex flex-col items-start gap-2">
          <p className="note">Could not load who has access to this array.</p>
          <button className="btn" onClick={() => void refetch()}>
            Try again
          </button>
        </div>
      ) : null}
      <ul className="flex flex-col gap-1">
        {(data?.members ?? []).map((member) => (
          <li
            key={`${member.userId}-${member.email}`}
            className="flex items-center gap-2 py-1 text-[14px]"
          >
            <span className="min-w-0 flex-1 truncate">
              {member.name ?? member.email}
              {member.pending ? (
                <span className="instrument ml-2 text-[color:var(--paper-faint)]">invited</span>
              ) : null}
            </span>
            <span className="instrument shrink-0">{member.role}</span>
            {member.role !== 'owner' ? (
              <button
                className="btn btn-ghost p-1"
                aria-label={`Remove ${member.email}`}
                onClick={() => setRemoving(member)}
              >
                <UserMinus className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </li>
        ))}
      </ul>

      {/* One click used to do this, while detaching a radar from the same topic
          asked first — and on a cascading array removing a person also takes
          away every radar it carries. The consequence is said before the click. */}
      {removing ? (
        <ConfirmDialog
          title={
            removing.pending
              ? `Withdraw the invite to ${removing.email}?`
              : `Remove ${removing.name ?? removing.email}?`
          }
          confirmLabel={removing.pending ? 'Withdraw invite' : 'Remove'}
          danger
          body={
            removing.pending
              ? 'The link in their email stops working.'
              : topic.cascade
                ? `They lose this array, and with it access to every radar it carries (${topic.radarCount} you can see). Access they were given on a radar directly stays.`
                : 'They lose this array. Radars they were given directly stay shared with them.'
          }
          onClose={() => setRemoving(null)}
          onConfirm={() => {
            const member = removing;
            setRemoving(null);
            void (async () => {
              try {
                if (member.pending) await api.topics.revokeInvite(topic.id, member.email);
                else await api.topics.removeMember(topic.id, member.userId);
                notify(`${member.email} removed`);
                refresh();
              } catch (err) {
                notify(err instanceof ApiError ? err.message : 'Could not remove', 'error');
              }
            })();
          }}
        />
      ) : null}

      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
        <input
          className="field col-span-2 min-w-0 sm:col-span-1"
          type="email"
          aria-label="Email address"
          value={email}
          placeholder="name@example.com"
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) void share();
          }}
        />
        <Select
          className="field w-auto"
          aria-label="Access level"
          value={role}
          onValueChange={(value) => setRole(value as (typeof TOPIC_ROLES)[number])}
          options={TOPIC_ROLES.map((role) => ({ value: role, label: role }))}
        />
        <button
          className="btn btn-accent"
          disabled={busy || !email.trim()}
          onClick={() => void share()}
        >
          <Plus className="h-4 w-4" />
          {busy ? 'Adding…' : 'Add person'}
        </button>
      </div>
      <p className="note">
        {/* The role only ever matters through the cascade, so say so rather
            than letting somebody think they picked a permission that applies. */}
        {topic.cascade
          ? 'A viewer can read the radars; an editor can capture into them.'
          : 'The role decides what they would get if this array is ever set to share its radars.'}
      </p>
    </Section>
  );
}
