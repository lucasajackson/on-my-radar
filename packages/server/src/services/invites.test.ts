/**
 * Share-by-email invitations, against a real Postgres.
 *
 * The whole feature is a security boundary — an invitation decides who gets
 * into a waitlisted application — so every assertion here is about something
 * that must not be true, not about something working. Four properties carry it:
 *
 * - **The token grants nothing.** It names an invitation row and is signed so a
 *   forged one cannot render a convincing page; it is never consulted when the
 *   waitlist bypass is decided. Replay, wrong recipient, revocation and deletion
 *   all fall out of that.
 * - **The bypass is read live.** An admin who has since been demoted or
 *   suspended stops letting people in immediately, which can only be asserted
 *   against a real row.
 * - **`findOrCreateUser` still decides only an initial state.** A returning
 *   account must not be re-approved, and a suspension must never be walked back
 *   by an invitation.
 * - **An agent may never invite a stranger**, on either transport, because the
 *   refusal lives under both of them.
 *
 * Skipped when DATABASE_URL is absent, like the rest of the suite. CI sets it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { INVITE } from '@onmyradar/contract';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { claimInvites, findOrCreateUser } from '../auth/accounts.js';
import { hashSecret, signFor } from '../auth/crypto.js';
import type { Actor } from '../http.js';
import { createRadar, deleteRadar, revokeInvite, shareRadar } from './radars.js';
import { createTopic, shareTopic } from './topics.js';
import { invitationBypassFor, openInviteToken, resolveInvite, sealInviteToken } from './invites.js';
import { must } from '../errors.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

let seq = 0;
function freshEmail(label: string): string {
  seq += 1;
  return `${label}-${Date.now()}-${seq}-${Math.random().toString(36).slice(2)}@example.test`;
}

async function makeUser(
  label: string,
  patch: Partial<typeof schema.users.$inferInsert> = {},
): Promise<Actor> {
  const [user] = await getDb()
    .insert(schema.users)
    .values({ email: freshEmail(label), name: label, state: 'active', ...patch })
    .returning();
  if (!user) throw new Error('user insert returned no row');
  return { user, kind: 'user' };
}

/** The invitation row a share just wrote, so a test can read its id and age. */
async function inviteFor(email: string) {
  const [row] = await getDb()
    .select()
    .from(schema.radarInvites)
    .where(eq(schema.radarInvites.email, email))
    .limit(1);
  return row ?? null;
}

async function stateOf(email: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ state: schema.users.state })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);
  return row?.state ?? null;
}

describe.skipIf(!hasDatabase)('share-by-email invitations (real postgres)', () => {
  beforeAll(async () => {
    await runMigrations();
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  /* ------------------------------- the token ------------------------------ */

  it('round-trips a token and refuses one whose body has been edited', async () => {
    const sealed = sealInviteToken('radar', '11111111-1111-1111-1111-111111111111', new Date());
    expect(openInviteToken(sealed)).toEqual({
      kind: 'radar',
      id: '11111111-1111-1111-1111-111111111111',
    });

    // Swap the invitation id for another one and keep the signature. This is the
    // attack the HMAC exists for: an invitation id is a uuid somebody could hold
    // from their own invitation, and reusing it against a signature that was
    // minted for a different row must not work.
    const [body, sig] = sealed.split('.');
    const forgedBody = Buffer.from(
      JSON.stringify({ v: 1, k: 'radar', i: '22222222-2222-2222-2222-222222222222', e: 4e9 }),
      'utf8',
    ).toString('base64url');
    expect(openInviteToken(`${forgedBody}.${sig ?? ''}`)).toBeNull();
    expect(openInviteToken(`${body ?? ''}.deadbeef`)).toBeNull();
    expect(openInviteToken('not-a-token')).toBeNull();
    expect(openInviteToken('')).toBeNull();
  });

  it('signs in its own domain: never the stored hash of the same string', () => {
    const sealed = sealInviteToken('radar', '44444444-4444-4444-4444-444444444444', new Date());
    const [body, sig] = sealed.split('.');
    // The signature is not what `hashSecret` — the stored form of every
    // credential — gives for the same input, nor the SSO state's domain.
    expect(sig).not.toBe(hashSecret(must(body)));
    expect(sig).not.toBe(signFor('oidc-state', must(body)));
  });

  it('still honours a link emailed before the domains were separated, until it expires', () => {
    const legacy = (id: string, expiresAt: number) => {
      const encoded = Buffer.from(
        JSON.stringify({ v: 1, k: 'radar', i: id, e: Math.floor(expiresAt / 1000) }),
        'utf8',
      ).toString('base64url');
      return `${encoded}.${hashSecret(encoded)}`;
    };
    // Sealed just before the deploy: honoured.
    const early = Date.parse('2026-10-09T00:00:00Z');
    if (Date.now() < early) {
      expect(openInviteToken(legacy('55555555-5555-5555-5555-555555555555', early))).toEqual({
        kind: 'radar',
        id: '55555555-5555-5555-5555-555555555555',
      });
    }
    // An old-style signature on a token no legacy seal could have produced — an
    // expiry beyond the window — is refused: the old domain mints nothing new.
    expect(
      openInviteToken(
        legacy('66666666-6666-6666-6666-666666666666', Date.now() + 400 * 86_400_000),
      ),
    ).toBeNull();
  });

  it('refuses a token past its expiry', () => {
    const old = new Date(Date.now() - (INVITE.ttlDays + 1) * 24 * 60 * 60 * 1000);
    const sealed = sealInviteToken('radar', '33333333-3333-3333-3333-333333333333', old);
    // Correctly signed — it is only the clock that rejects it.
    expect(openInviteToken(sealed)).toBeNull();
  });

  /* ---------------------------- resolving a link -------------------------- */

  it('resolves a live invitation, and keeps resolving it when replayed', async () => {
    const owner = await makeUser('owner');
    const radar = await createRadar(owner, { name: `Invite ${Math.random()}` });
    const guest = freshEmail('guest');

    const result = await shareRadar(owner, radar.id, guest, 'editor');
    expect(result.status).toBe('invited');
    expect(result.approved).toBe(false);

    const invite = await inviteFor(guest);
    if (!invite) throw new Error('no invitation row was written');
    const token = sealInviteToken('radar', invite.id, invite.createdAt);

    const preview = await resolveInvite(token);
    expect(preview?.name).toBe(radar.name);
    expect(preview?.email).toBe(guest);
    expect(preview?.role).toBe('editor');
    expect(preview?.hasAccount).toBe(false);
    expect(preview?.next).toBe(`/radar/${radar.id}`);

    // Replay grants nothing because it never granted anything — the same page,
    // as many times as it is asked for.
    expect((await resolveInvite(token))?.email).toBe(guest);
  });

  it('stops resolving once the share is revoked, and once the radar is deleted', async () => {
    const owner = await makeUser('owner');
    const radar = await createRadar(owner, { name: `Revoke ${Math.random()}` });
    const guest = freshEmail('guest');
    await shareRadar(owner, radar.id, guest, 'viewer');

    const invite = await inviteFor(guest);
    if (!invite) throw new Error('no invitation row was written');
    const token = sealInviteToken('radar', invite.id, invite.createdAt);
    expect(await resolveInvite(token)).not.toBeNull();

    await revokeInvite(owner, radar.id, guest);
    expect(await resolveInvite(token)).toBeNull();

    // And deleting the radar takes any invitation with it, by cascade rather
    // than by anybody remembering to.
    const second = freshEmail('guest');
    await shareRadar(owner, radar.id, second, 'viewer');
    const secondInvite = await inviteFor(second);
    if (!secondInvite) throw new Error('no invitation row was written');
    const secondToken = sealInviteToken('radar', secondInvite.id, secondInvite.createdAt);
    expect(await resolveInvite(secondToken)).not.toBeNull();

    await deleteRadar(owner, radar.id);
    expect(await resolveInvite(secondToken)).toBeNull();
  });

  it('re-sharing a pending invitation at a higher role changes the role', async () => {
    const owner = await makeUser('owner');
    const radar = await createRadar(owner, { name: `Upgrade ${Math.random()}` });
    const guest = freshEmail('guest');

    await shareRadar(owner, radar.id, guest, 'viewer');
    await shareRadar(owner, radar.id, guest, 'editor');

    // `onConflictDoNothing` used to swallow this, so somebody told they were an
    // editor arrived as a viewer.
    const invite = await inviteFor(guest);
    expect(invite?.role).toBe('editor');
  });

  /* ---------------------------- the admin bypass -------------------------- */

  it("an ordinary user's invitation does not skip the waitlist", async () => {
    const owner = await makeUser('owner');
    const radar = await createRadar(owner, { name: `Ordinary ${Math.random()}` });
    const guest = freshEmail('guest');
    await shareRadar(owner, radar.id, guest, 'viewer');

    expect(await invitationBypassFor(guest)).toBe(false);
    const { user } = await findOrCreateUser(guest);
    expect(user.state).toBe('pending');
  });

  it("an admin's invitation skips the waitlist, on a radar and on a topic", async () => {
    const admin = await makeUser('admin', { isAdmin: true });
    const radar = await createRadar(admin, { name: `Admin ${Math.random()}` });
    const guest = freshEmail('guest');
    await shareRadar(admin, radar.id, guest, 'viewer');
    expect(await invitationBypassFor(guest)).toBe(true);
    expect((await findOrCreateUser(guest)).user.state).toBe('active');

    // A topic invitation is the same decision: an admin bringing a named person
    // into the product.
    const topic = await createTopic(admin, { name: `Admin topic ${Math.random()}` });
    const second = freshEmail('guest');
    await shareTopic(admin, topic.id, second, 'viewer');
    expect(await invitationBypassFor(second)).toBe(true);
    expect((await findOrCreateUser(second)).user.state).toBe('active');
  });

  it('the bypass dies with the inviter losing admin, and with them being suspended', async () => {
    const admin = await makeUser('admin', { isAdmin: true });
    const radar = await createRadar(admin, { name: `Demote ${Math.random()}` });
    const guest = freshEmail('guest');
    await shareRadar(admin, radar.id, guest, 'viewer');
    expect(await invitationBypassFor(guest)).toBe(true);

    // Demoted. The invitation is untouched — it is the live admin bit that is
    // being read, not a copy taken when the link was minted.
    await getDb()
      .update(schema.users)
      .set({ isAdmin: false })
      .where(eq(schema.users.id, admin.user.id));
    expect(await invitationBypassFor(guest)).toBe(false);
    expect((await findOrCreateUser(guest)).user.state).toBe('pending');

    // And an admin who is still an admin but has been suspended cannot let
    // anybody in either.
    const suspended = await makeUser('suspended-admin', { isAdmin: true });
    const other = await createRadar(suspended, { name: `Suspended ${Math.random()}` });
    const second = freshEmail('guest');
    await shareRadar(suspended, other.id, second, 'viewer');
    expect(await invitationBypassFor(second)).toBe(true);
    await getDb()
      .update(schema.users)
      .set({ state: 'suspended' })
      .where(eq(schema.users.id, suspended.user.id));
    expect(await invitationBypassFor(second)).toBe(false);
  });

  it('the bypass expires with the invitation, but the grant does not', async () => {
    const admin = await makeUser('admin', { isAdmin: true });
    const radar = await createRadar(admin, { name: `Stale ${Math.random()}` });
    const guest = freshEmail('guest');
    await shareRadar(admin, radar.id, guest, 'viewer');

    const invite = await inviteFor(guest);
    if (!invite) throw new Error('no invitation row was written');
    await getDb()
      .update(schema.radarInvites)
      .set({ createdAt: new Date(Date.now() - (INVITE.ttlDays + 1) * 24 * 60 * 60 * 1000) })
      .where(eq(schema.radarInvites.id, invite.id));

    expect(await invitationBypassFor(guest)).toBe(false);
    // The grant itself is untouched: the row is still there, unclaimed, and
    // still confers the radar the moment this person signs in.
    const stale = await inviteFor(guest);
    expect(stale?.acceptedAt).toBeNull();
    expect(stale?.role).toBe('viewer');
  });

  it('is bound to the invited address and cannot be pointed at another', async () => {
    const admin = await makeUser('admin', { isAdmin: true });
    const radar = await createRadar(admin, { name: `Bound ${Math.random()}` });
    const invited = freshEmail('invited');
    await shareRadar(admin, radar.id, invited, 'viewer');

    // Somebody else clicking the link and signing up as themselves gets an
    // ordinary account. The invitation stays where it was addressed.
    const bystander = freshEmail('bystander');
    expect(await invitationBypassFor(bystander)).toBe(false);
    expect((await findOrCreateUser(bystander)).user.state).toBe('pending');
    expect((await inviteFor(invited))?.acceptedAt).toBeNull();
  });

  it('normalizes the address, so capitalisation cannot miss the invitation', async () => {
    const admin = await makeUser('admin', { isAdmin: true });
    const radar = await createRadar(admin, { name: `Case ${Math.random()}` });
    const guest = freshEmail('guest');
    await shareRadar(admin, radar.id, ` ${guest.toUpperCase()} `, 'viewer');

    expect(await inviteFor(guest)).not.toBeNull();
    expect(await invitationBypassFor(guest)).toBe(true);
    expect((await findOrCreateUser(guest.toUpperCase())).user.state).toBe('active');
  });

  /* -------------------- accounts that already exist ----------------------- */

  it('an admin sharing with a waitlisted account approves it there and then', async () => {
    const admin = await makeUser('admin', { isAdmin: true });
    const radar = await createRadar(admin, { name: `Waiting ${Math.random()}` });
    const waiting = await makeUser('waiting', { state: 'pending' });

    const result = await shareRadar(admin, radar.id, waiting.user.email, 'viewer');
    expect(result.status).toBe('added');
    expect(result.approved).toBe(true);
    expect(await stateOf(waiting.user.email)).toBe('active');
  });

  it('an ordinary user sharing with a waitlisted account leaves them waiting', async () => {
    const owner = await makeUser('owner');
    const radar = await createRadar(owner, { name: `Still waiting ${Math.random()}` });
    const waiting = await makeUser('waiting', { state: 'pending' });

    const result = await shareRadar(owner, radar.id, waiting.user.email, 'viewer');
    expect(result.approved).toBe(false);
    expect(await stateOf(waiting.user.email)).toBe('pending');
  });

  it('never un-suspends: not by sharing, and not by signing in again', async () => {
    const admin = await makeUser('admin', { isAdmin: true });
    const radar = await createRadar(admin, { name: `Suspended ${Math.random()}` });
    const banned = await makeUser('banned', { state: 'suspended' });

    const result = await shareRadar(admin, radar.id, banned.user.email, 'viewer');
    expect(result.approved).toBe(false);
    expect(await stateOf(banned.user.email)).toBe('suspended');

    // Re-authenticating decides nothing either — `findOrCreateUser` only ever
    // decides an *initial* state, and an outstanding invitation must not become
    // a way around a suspension.
    expect((await findOrCreateUser(banned.user.email)).user.state).toBe('suspended');
  });

  /* ----------------------------- the agent line --------------------------- */

  it('refuses an agent inviting an address with no account, on radar and topic', async () => {
    const owner = await makeUser('owner', { isAdmin: true });
    const agent: Actor = { user: owner.user, kind: 'agent' };
    const radar = await createRadar(owner, { name: `Agent ${Math.random()}` });
    const topic = await createTopic(owner, { name: `Agent topic ${Math.random()}` });
    const stranger = freshEmail('stranger');

    await expect(shareRadar(agent, radar.id, stranger, 'viewer')).rejects.toThrow(
      /inviting somebody new/i,
    );
    await expect(shareTopic(agent, topic.id, stranger, 'viewer')).rejects.toThrow(
      /inviting somebody new/i,
    );

    // Nothing was written and no email could have gone out.
    expect(await inviteFor(stranger)).toBeNull();
  });

  it('lets an agent share with somebody who already has an account', async () => {
    const owner = await makeUser('owner');
    const agent: Actor = { user: owner.user, kind: 'agent' };
    const radar = await createRadar(owner, { name: `Agent ok ${Math.random()}` });
    const mate = await makeUser('mate');

    const result = await shareRadar(agent, radar.id, mate.user.email, 'viewer');
    expect(result.status).toBe('added');
  });

  it('an agent holding an admin token cannot approve a waitlisted account', async () => {
    const admin = await makeUser('admin', { isAdmin: true });
    const agent: Actor = { user: admin.user, kind: 'agent' };
    const radar = await createRadar(admin, { name: `Agent admin ${Math.random()}` });
    const waiting = await makeUser('waiting', { state: 'pending' });

    const result = await shareRadar(agent, radar.id, waiting.user.email, 'viewer');
    // The share itself is fine — that person already has an account, so this is
    // organising. Letting them into the product is not, and did not happen.
    expect(result.status).toBe('added');
    expect(result.approved).toBe(false);
    expect(await stateOf(waiting.user.email)).toBe('pending');
  });
  it('claiming a stale invitation never demotes an existing membership', async () => {
    const owner = await makeUser('claim-owner');
    const guest = await makeUser('claim-guest');
    const radar = await createRadar(owner, { name: `Claim ${Math.random()}` });

    // They are already an editor, by a direct share.
    await shareRadar(owner, radar.id, guest.user.email, 'editor');

    // An older `viewer` invitation for the same address, written straight to the
    // table. The API cannot currently produce this — `shareRadar` writes an
    // invite row only on its `!existingUser` branch — and that unstated
    // invariant, living in a different file, was the only thing making the old
    // `onConflictDoNothing` safe. Nothing enforced it and nothing tested it, so
    // this asserts the *policy* rather than the accident: most-permissive wins,
    // the same rule `services/access.ts` applies to owner / direct / topic.
    await getDb().insert(schema.radarInvites).values({
      radarId: radar.id,
      email: guest.user.email,
      role: 'viewer',
      invitedBy: owner.user.id,
    });

    await claimInvites(guest.user);

    const [row] = await getDb()
      .select({ role: schema.radarMembers.role })
      .from(schema.radarMembers)
      .where(
        and(
          eq(schema.radarMembers.radarId, radar.id),
          eq(schema.radarMembers.userId, guest.user.id),
        ),
      );
    expect(row?.role).toBe('editor');

    // And the converse: a stronger invitation does promote, so this is a
    // maximum rather than a refusal to write.
    await getDb().insert(schema.radarInvites).values({
      radarId: radar.id,
      email: guest.user.email,
      role: 'owner',
      invitedBy: owner.user.id,
    });
    await claimInvites(guest.user);
    const [after] = await getDb()
      .select({ role: schema.radarMembers.role })
      .from(schema.radarMembers)
      .where(
        and(
          eq(schema.radarMembers.radarId, radar.id),
          eq(schema.radarMembers.userId, guest.user.id),
        ),
      );
    expect(after?.role).toBe('owner');
  });
});
