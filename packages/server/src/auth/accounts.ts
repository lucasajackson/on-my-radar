import { assertAccountOpen } from '../services/account-lifecycle.js';
/**
 * Account provisioning: the waitlist policy, first-run workspace, and claiming
 * shares that were addressed to an email before that person had an account.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  DEFAULT_RADAR_ACCENT,
  DEFAULT_RADAR_GLYPH,
  normalizeEmail,
  slugify,
} from '@onmyradar/contract';
import { getDb, schema } from '../db/client.js';
import { env } from '../env.js';
import type { Actor } from '../http.js';
import { logger } from '../logger.js';
import { recordAudit } from '../services/audit.js';
import { invitationBypassFor } from '../services/invites.js';
import { approvedMessage, waitlistMessage } from '../services/mail.js';
import { enqueue, drainOne } from '../services/outbox.js';
import { claimTopicInvites } from '../services/topics.js';
import { ensureDropBox } from '../services/radars.js';
import { lockOwner } from '../services/owner-lock.js';
import { WELCOME_BLIP_BODY, WELCOME_RADAR } from './welcome.js';

export type UserRow = typeof schema.users.$inferSelect;

/**
 * With SIGNUP_MODE=open everyone is let straight in. Otherwise signup is
 * waitlisted: anyone may request access, and an admin decides. Two config lists
 * cut the queue — ADMIN_EMAILS (who also get the admin bit) and
 * AUTO_APPROVE_EMAILS, whose entries are either a full address or `@domain`.
 */
export function accessPolicyFor(email: string): { state: 'pending' | 'active'; isAdmin: boolean } {
  const normalized = normalizeEmail(email);
  const domain = normalized.slice(normalized.indexOf('@'));
  const e = env();

  const isAdmin = e.ADMIN_EMAILS.map(normalizeEmail).includes(normalized);
  if (isAdmin) return { state: 'active', isAdmin: true };

  if (e.SIGNUP_MODE === 'open') return { state: 'active', isAdmin: false };

  const autoApproved = e.AUTO_APPROVE_EMAILS.map(normalizeEmail).some(
    (entry) => entry === normalized || (entry.startsWith('@') && entry === domain),
  );
  return { state: autoApproved ? 'active' : 'pending', isAdmin: false };
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const rows = await getDb()
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, normalizeEmail(email)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findUserById(id: string): Promise<UserRow | null> {
  const rows = await getDb().select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Idempotent by email. A returning user keeps whatever state an admin has since
 * set — the policy only decides the *initial* state, so re-authenticating can
 * never quietly un-suspend or re-approve somebody.
 */
export async function findOrCreateUser(
  email: string,
  profile: { name?: string | null; avatarUrl?: string | null } = {},
): Promise<{ user: UserRow; created: boolean }> {
  const normalized = normalizeEmail(email);
  const existing = await findUserByEmail(normalized);
  if (existing) {
    await assertAccountOpen(existing.id);
    if (existing.state === 'pending') {
      const admitted = await admitOnOpenSignup(existing);
      if (admitted !== existing) return { user: admitted, created: false };
    }
    // Backfill a name/avatar we only learn from SSO, without overwriting a
    // display name the user has since chosen for themselves.
    const patch: Partial<UserRow> = {};
    if (!existing.name && profile.name) patch.name = profile.name;
    if (!existing.avatarUrl && profile.avatarUrl) patch.avatarUrl = profile.avatarUrl;
    if (Object.keys(patch).length > 0) {
      const [updated] = await getDb()
        .update(schema.users)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(schema.users.id, existing.id))
        .returning();
      return { user: updated ?? existing, created: false };
    }
    return { user: existing, created: false };
  }

  const policy = accessPolicyFor(normalized);
  // An outstanding invitation from a *currently* active admin skips the queue.
  // Evaluated here, at the only moment an initial state is decided, and derived
  // entirely from the database — nothing the person signing up can influence.
  // See `invitationBypassFor` and docs/DESIGN.md §19.
  const state =
    policy.state === 'pending' && (await invitationBypassFor(normalized)) ? 'active' : policy.state;
  let mailJob: string | undefined;
  const created = await getDb().transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.users)
      .values({
        email: normalized,
        name: profile.name ?? null,
        avatarUrl: profile.avatarUrl ?? null,
        state,
        isAdmin: policy.isAdmin,
      })
      // Two concurrent sign-ins for the same new address race here; the unique
      // index decides and the loser reads the winner's row back.
      .onConflictDoNothing({ target: schema.users.email })
      .returning();

    if (created?.state === 'pending') {
      mailJob = await enqueue(tx, 'email', { ...waitlistMessage(created.email) });
    }
    return created;
  });
  if (mailJob) void drainOne(mailJob).catch(() => undefined);

  if (!created) {
    const raced = await findUserByEmail(normalized);
    if (!raced) throw new Error(`user ${normalized} vanished between insert and read`);
    return { user: raced, created: false };
  }

  logger.info(
    { userId: created.id, state: created.state, viaInvite: state !== policy.state },
    'user created',
  );
  return { user: created, created: true };
}

/**
 * Let a waitlisted account into the app. The one approval path in the codebase.
 *
 * Two callers reach it: an admin clicking approve in the console, and an admin
 * sharing a radar or a topic with somebody who is already sitting on the
 * waitlist. Those are the same decision — an admin vouching for a named person
 * — and giving them one implementation is what stops the second one drifting
 * into something the first would not have allowed.
 *
 * **Only `pending` is touched.** A suspended account stays suspended: suspension
 * is a decision somebody took about a person, and an invitation must never be a
 * way to walk it back. Returns whether anything changed, so a caller can decide
 * whether it is worth saying so.
 *
 * (`auth/accounts.ts` and `services/radars.ts` import each other — this function
 * one way, `ensureDropBox` the other. That is a genuine cycle and it is safe:
 * neither module calls anything from the other while it is being evaluated, so
 * both bindings are live by the time either is used.)
 */
export async function activateUser(
  actor: Actor | null,
  user: UserRow,
  via: 'admin' | 'invitation' | 'open-signup',
): Promise<boolean> {
  if (user.state !== 'pending') return false;

  let mailJob: string | undefined;
  const updated = await getDb().transaction(async (tx) => {
    const [updated] = await tx
      .update(schema.users)
      .set({ state: 'active', updatedAt: new Date() })
      // Re-checked in the UPDATE, not only in the read above: two admins acting at
      // once must not both send the welcome email, and a suspension landing in
      // between must not be overwritten by a decision taken before it.
      .where(and(eq(schema.users.id, user.id), eq(schema.users.state, 'pending')))
      .returning();

    // Open signup admits somebody who is signing in or using the app right now;
    // an "you're approved" email would arrive after they are already in.
    if (updated && via !== 'open-signup')
      mailJob = await enqueue(tx, 'email', { ...approvedMessage(updated.email) });
    return updated;
  });
  if (mailJob) void drainOne(mailJob).catch(() => undefined);
  if (!updated) return false;

  await ensureDefaultWorkspace(updated);
  await recordAudit(actor, 'user.approve', 'user', updated.id, { email: updated.email, via });
  return true;
}

/**
 * Once signup is open, the waitlist is over for everybody still on it: a pending
 * account is admitted the next time it signs in or presents a live session, so
 * nobody has to approve the backlog by hand. Suspended accounts are untouched
 * (`activateUser` only moves `pending`). Returns the fresh row when it changed,
 * otherwise the row it was given.
 */
export async function admitOnOpenSignup(user: UserRow): Promise<UserRow> {
  if (user.state !== 'pending' || env().SIGNUP_MODE !== 'open') return user;
  await activateUser(null, user, 'open-signup');
  return (await findUserById(user.id)) ?? user;
}

/**
 * Turn every outstanding invite for this address into a real membership — radar
 * invites and topic invites alike. Run on every sign-in, not just the first: a
 * radar or a topic may be shared with an address that already has an account.
 */
export async function claimInvites(user: UserRow): Promise<number> {
  const db = getDb();
  const topics = await claimTopicInvites(user.id, user.email);
  const invites = await db
    .select()
    .from(schema.radarInvites)
    .where(and(eq(schema.radarInvites.email, user.email), isNull(schema.radarInvites.acceptedAt)));

  if (invites.length === 0) return topics;

  for (const invite of invites) {
    await db
      .insert(schema.radarMembers)
      .values({
        radarId: invite.radarId,
        userId: user.id,
        role: invite.role,
        invitedBy: invite.invitedBy,
      })
      /*
       * Most-permissive wins, which is the house rule for combining two grants
       * on the same radar — `services/access.ts` states it and applies it to
       * owner / direct / topic. Applying it here too means this branch can
       * never demote somebody, whichever way the collision arose.
       *
       * This was `onConflictDoNothing`, commented "the existing membership
       * wins", which reads like a chosen policy and was really an accident that
       * happened to be safe. It was safe only via an unstated invariant living
       * in a different file: `shareRadar` writes an invite row *only* on its
       * `!existingUser` branch, so an invite can only exist for an address with
       * no account, and by the time it is claimed the account is brand new and
       * cannot already hold a membership. Nothing enforced that, nothing tested
       * it, and the comment did not mention it — so the first change to
       * `shareRadar` that wrote an invite for an existing account would have
       * silently started discarding the role the owner chose.
       *
       * Flipping blindly to `onConflictDoUpdate` would have inverted the loss
       * rather than removing it: an old `viewer` invite claimed late would
       * demote a current editor. Taking the stronger of the two loses neither.
       */
      .onConflictDoUpdate({
        target: [schema.radarMembers.radarId, schema.radarMembers.userId],
        set: {
          role: sql`CASE WHEN array_position(ARRAY['viewer','editor','owner']::text[], excluded.role)
                            > array_position(ARRAY['viewer','editor','owner']::text[], ${schema.radarMembers.role})
                       THEN excluded.role ELSE ${schema.radarMembers.role} END`,
        },
      });
    await db
      .update(schema.radarInvites)
      .set({ acceptedAt: new Date() })
      .where(eq(schema.radarInvites.id, invite.id));
  }

  logger.info({ userId: user.id, radars: invites.length, topics }, 'invites claimed');
  return invites.length + topics;
}

/**
 * Every account starts with one radar holding one welcome blip, and one
 * dashboard tab showing it. The blip is an ordinary blip: deleting it is
 * expected, and nothing in the app treats it as special afterwards.
 */
export async function ensureDefaultWorkspace(user: UserRow): Promise<void> {
  const db = getDb();

  // The drop box is created for everybody, including accounts that predate it —
  // which is why it is outside the "brand new account" branch below. It is
  // idempotent and guarded by a unique index, so calling it on every sign-in is
  // one indexed read in the steady state.
  await ensureDropBox({ user, kind: 'user' }).catch((err: unknown) => {
    // A missing drop box must never block a sign-in; the next capture re-tries.
    logger.warn({ err, userId: user.id }, 'drop box could not be ensured');
  });

  await db.transaction(async (tx) => {
    await lockOwner(tx, user.id);
    const [{ count } = { count: 0 }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.radars)
      .where(and(eq(schema.radars.ownerId, user.id), eq(schema.radars.isDropBox, false)));
    // A workspace has an owned non-Drop-Box radar. Serializing this check also
    // makes concurrent first sign-ins create exactly one complete welcome workspace.
    if (count > 0) return;

    const [radar] = await tx
      .insert(schema.radars)
      .values({
        ownerId: user.id,
        slug: slugify(WELCOME_RADAR.name),
        name: WELCOME_RADAR.name,
        tagline: WELCOME_RADAR.tagline,
        description: WELCOME_RADAR.description,
        accent: DEFAULT_RADAR_ACCENT,
        glyph: DEFAULT_RADAR_GLYPH,
      })
      .returning();
    if (!radar) return;

    await tx.insert(schema.blips).values({
      radarId: radar.id,
      authorId: user.id,
      kind: 'essay',
      state: 'inbox',
      title: 'Welcome to On My Radar',
      body: WELCOME_BLIP_BODY,
      tags: ['welcome', 'guide'],
      pinned: true,
    });

    const [dashboard] = await tx
      .insert(schema.dashboards)
      .values({ ownerId: user.id, name: 'Mission Control', position: 0 })
      .returning();

    if (dashboard) {
      await tx.insert(schema.dashboardWidgets).values([
        { dashboardId: dashboard.id, radarId: radar.id, x: 0, y: 0, w: 6, h: 10 },
        {
          dashboardId: dashboard.id,
          x: 6,
          y: 0,
          w: 6,
          h: 3,
          config: { type: 'query', title: 'Inbox', query: 'is:inbox', display: 'count', limit: 12 },
        },
        {
          dashboardId: dashboard.id,
          x: 6,
          y: 3,
          w: 6,
          h: 7,
          config: {
            type: 'query',
            title: 'Active work',
            query: 'is:active',
            display: 'lanes',
            limit: 12,
          },
        },
      ]);
    }

    logger.info({ userId: user.id, radarId: radar.id }, 'default workspace created');
  });
}

export async function touchLastSeen(userId: string): Promise<void> {
  await getDb()
    .update(schema.users)
    .set({ lastSeenAt: new Date() })
    .where(and(eq(schema.users.id, userId), sql`omr_account_open(${schema.users.id})`));
}
