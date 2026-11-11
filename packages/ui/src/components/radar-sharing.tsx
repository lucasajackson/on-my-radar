import { Select } from './select';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, Lock, RefreshCw, UserMinus, Users } from 'lucide-react';
import { CopyButton } from './copy-button';
import {
  RADAR_ROLES,
  isClientFacingTemplate,
  type MemberDto,
  type RadarDto,
} from '@onmyradar/contract';
import { ApiError, api } from '../lib/api';
import { queryKeys } from '../lib/session';
import { ConfirmDialog, notify } from './primitives';

export function SharePanel({ radar, onChanged }: { radar: RadarDto; onChanged: () => void }) {
  const client = useQueryClient();
  // A helpdesk is never public, and anyone it is shared with reads its internal
  // notes. Both are said here, before the click (docs/HELPDESK.md §6.1).
  const helpdesk = isClientFacingTemplate(radar.template);
  // A former helpdesk keeps the notes it gathered, so it keeps both rules too:
  // no public link, and the warning about who reads what (0044).
  const formerHelpdesk = !helpdesk && radar.neverPublic;
  /*
    Members through the query cache, under the key the mention menus read.

    This used to be its own fetch into component state, so sharing a radar
    with somebody left every composer's cached member list (60s) without them:
    the person just invited could not be @mentioned, and somebody just removed
    still could. One key, one invalidation, and both screens agree.

    Loaded, failed, or not yet known are still three states: `listMembers`
    always includes the owner, so a list that loaded is never empty, and a
    failed read must never render like a radar shared with nobody.
  */
  const membersQuery = useQuery({
    queryKey: queryKeys.members(radar.id),
    queryFn: () => api.radars.members(radar.id),
  });
  const members: MemberDto[] = membersQuery.data?.members ?? [];
  const membersState: 'loading' | 'ready' | 'failed' = membersQuery.isError
    ? 'failed'
    : membersQuery.isPending
      ? 'loading'
      : 'ready';
  const load = () => client.invalidateQueries({ queryKey: queryKeys.members(radar.id) });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>('viewer');
  const [busy, setBusy] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [removing, setRemoving] = useState<MemberDto | null>(null);
  /*
    What a visibility change or a rotation returned, until the radar handed in
    catches up. Seeding state from the prop once meant a change made anywhere
    else never reached this panel while it stayed open.
  */
  const [latest, setLatest] = useState<RadarDto | null>(null);
  const current = latest && latest.updatedAt >= radar.updatedAt ? latest : radar;

  const publicUrl =
    current.publicSlug && current.visibility === 'public'
      ? `${window.location.origin}/r/${current.publicSlug}`
      : null;

  const share = async () => {
    if (!email.trim()) return;
    setBusy(true);
    try {
      const { share: result } = await api.radars.share(radar.id, email.trim(), role);
      // Three different things can have happened, and saying "shared" for all of
      // them hides the one that matters: `approved` means this share also let a
      // waitlisted person into the application. That is an admin decision with a
      // consequence beyond this radar, and it should never happen silently.
      notify(
        result.approved
          ? `Shared with ${result.email} — and let them into On My Radar`
          : result.status === 'invited'
            ? `Invited ${result.email} — we have emailed them a link to join`
            : `Shared with ${result.email}`,
      );
      setEmail('');
      await load();
      onChanged();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not share the radar', 'error');
    } finally {
      setBusy(false);
    }
  };

  const setVisibility = async (visibility: 'private' | 'public') => {
    setBusy(true);
    try {
      const { radar: updated } = await api.radars.setVisibility(radar.id, visibility);
      setLatest(updated);
      onChanged();
      notify(visibility === 'public' ? 'Radar published' : 'Radar is private again');
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not change visibility', 'error');
    } finally {
      setBusy(false);
    }
  };

  const rotate = async () => {
    setRotating(false);
    setBusy(true);
    try {
      const { radar: updated } = await api.radars.rotateLink(radar.id);
      setLatest(updated);
      onChanged();
      notify('New link issued');
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not issue a new link', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {/* The drop box half of this is not a shorter sentence, it is a different
          one: the standing description promised a public link two lines above
          the paragraph explaining that this radar does not get one. Caught by
          reading a screenshot rather than by any of the assertions below it,
          which were all looking for the *control*. */}
      <p className="note">
        {radar.isDropBox
          ? 'Give someone their own view of your drop box. There is no public link.'
          : helpdesk
            ? 'Give a collaborator their own view of this helpdesk. There is no public link.'
            : formerHelpdesk
              ? 'Give a collaborator their own view of this radar. It was a helpdesk, so there is no public link.'
              : 'Give people their own view of this radar, or publish a read-only link.'}
      </p>
      {helpdesk || formerHelpdesk ? (
        <p className="note" data-testid="helpdesk-share-warning" role="note">
          Everyone you share this with sees every request and every internal note. Share only with
          people who work on the site with you — never with the client. Clients see their requests
          through the portal, and nothing else.
        </p>
      ) : null}
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <span className="instrument">Share with a person</span>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              className="field"
              type="email"
              value={email}
              placeholder="their@email.com"
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void share();
              }}
            />
            <Select
              className="field sm:w-36"
              value={role}
              aria-label="Access level"
              onValueChange={(value) => setRole(value)}
              options={RADAR_ROLES.filter((role) => role !== 'owner').map((role) => ({
                value: role,
                label: role === 'viewer' ? 'Can view' : 'Can edit',
              }))}
            />
            <button
              className="btn btn-accent"
              disabled={busy || !email.trim()}
              onClick={() => void share()}
            >
              Share
            </button>
          </div>
        </div>

        {membersState === 'failed' ? (
          <div className="flex flex-col gap-2 rounded-md border border-[color:var(--warn)] px-3 py-2.5">
            <p className="text-[13px] text-[color:var(--paper-dim)]">
              Who this radar is shared with could not be loaded. This is not the same as it being
              shared with nobody — the list is unknown, not empty.
            </p>
            <button
              type="button"
              className="btn btn-ghost self-start text-[12.5px]"
              onClick={() => void membersQuery.refetch()}
            >
              Try again
            </button>
          </div>
        ) : membersState === 'ready' && members.length === 0 ? (
          // Degenerate in practice, because the owner is always in the list.
          // Stated anyway rather than rendering nothing, so that "empty" is
          // something the screen says out loud and never something it implies
          // by absence.
          <p className="note">Nobody is listed on this radar.</p>
        ) : members.length > 0 ? (
          <ul className="flex flex-col divide-y divide-[color:var(--line-soft)]">
            {members.map((member) => (
              <li key={`${member.userId}-${member.email}`} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px]">{member.name ?? member.email}</div>
                  <div className="instrument truncate">
                    {member.role}
                    {member.pending ? ' · invite pending' : ''}
                    {/*
                      Somebody who reaches this radar only through a cascading
                      topic holds no membership row here, and would otherwise be
                      invisible in the one place that answers "who can see
                      this". Access nobody can enumerate is access nobody
                      audits, so they are listed and labelled with where the
                      access came from — and they disappear from this list the
                      moment that array stops cascading.
                    */}
                    {member.via === 'topic' && member.viaTopic
                      ? ` · via ${member.viaTopic.name}`
                      : ''}
                  </div>
                </div>
                {member.via === 'topic' ? (
                  // Nothing to remove here: there is no grant on this radar to
                  // take away. It is managed on the topic, so the control is
                  // there rather than being offered here and then failing.
                  <Link
                    to="/array/$topicId"
                    params={{ topicId: member.viaTopic?.id ?? '' }}
                    className="btn btn-ghost p-1.5"
                    title="Managed on the array"
                    aria-label={`Manage ${member.email} on the array`}
                  >
                    <Users className="h-3.5 w-3.5" />
                  </Link>
                ) : member.role !== 'owner' && radar.access.canManage ? (
                  <button
                    className="btn btn-ghost p-1.5"
                    aria-label={`Remove ${member.email}`}
                    onClick={() => setRemoving(member)}
                  >
                    <UserMinus className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {/* The drop box has no public address at all — not the flag and not the
            slug — so the whole section goes rather than being shown and then
            refused. Same rule as TopicPicker, and the service and two CHECK
            constraints refuse it regardless of what is on screen. The
            share-with-a-person half above stays: that is a deliberate act with a
            named recipient, which is a different thing from an address. */}
        {radar.isDropBox ? (
          <p className="border-t border-[color:var(--line-soft)] pt-4 text-[13px] text-[color:var(--paper-dim)]">
            Your drop box has no public link. It is the one radar holding things you have not sorted
            yet, so there is nothing in it you have decided to show anyone.
          </p>
        ) : helpdesk || formerHelpdesk ? (
          // Same rule as the drop box: the section goes rather than being shown
          // and then refused. The service, the access check and a CHECK
          // constraint refuse it regardless of what is on screen.
          <p className="border-t border-[color:var(--line-soft)] pt-4 text-[13px] text-[color:var(--paper-dim)]">
            {helpdesk ? 'A helpdesk has' : 'A radar that was a helpdesk has'} no public link. Its
            comments include internal notes about a client.
          </p>
        ) : (
          <div className="flex flex-col gap-2 border-t border-[color:var(--line-soft)] pt-4">
            <span className="instrument">Public link</span>
            {publicUrl ? (
              <>
                <div className="flex gap-2">
                  <input className="field font-mono text-[12.5px]" readOnly value={publicUrl} />
                  <CopyButton value={publicUrl} />
                </div>
                <p className="text-[12.5px] text-[color:var(--paper-dim)]">
                  Anyone with this link can read the radar.
                  {current.allowIndex
                    ? ' Search engines may list it.'
                    : ' It is hidden from search engines.'}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button className="btn" disabled={busy} onClick={() => setRotating(true)}>
                    <RefreshCw className="h-4 w-4" />
                    New link
                  </button>
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() => void setVisibility('private')}
                  >
                    <Lock className="h-4 w-4" />
                    Make private
                  </button>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-between gap-3">
                <p className="text-[13px] text-[color:var(--paper-dim)]">
                  Not published. Publishing creates an unguessable, read-only link.
                </p>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => void setVisibility('public')}
                >
                  <Globe className="h-4 w-4" />
                  Publish
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {rotating ? (
        <ConfirmDialog
          title="Issue a new link?"
          confirmLabel="Issue a new link"
          body="The current link stops working immediately. Anyone you have already sent it to loses access until you send them the new one."
          onClose={() => setRotating(false)}
          onConfirm={() => void rotate()}
        />
      ) : null}

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
              : 'They stop seeing this radar straight away. What they wrote on it stays.'
          }
          onClose={() => setRemoving(null)}
          onConfirm={() => {
            const member = removing;
            setRemoving(null);
            void (async () => {
              try {
                if (member.pending) await api.radars.revokeInvite(radar.id, member.email);
                else await api.radars.removeMember(radar.id, member.userId);
                await load();
                onChanged();
              } catch (err) {
                notify(err instanceof ApiError ? err.message : 'Could not remove them', 'error');
              }
            })();
          }}
        />
      ) : null}
    </div>
  );
}
