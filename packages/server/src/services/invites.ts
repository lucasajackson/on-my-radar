/**
 * Share-by-email invitations: the signed link, and the waitlist bypass.
 *
 * Two things happen when a radar or a topic is shared with an address that has
 * no account, and it matters enormously that they are kept apart:
 *
 * 1. **The link.** The email carries a signed token so the click lands on the
 *    login screen with the invitation already attached — the right address
 *    filled in, the radar named, and somewhere to go afterwards.
 * 2. **The bypass.** Signup is waitlisted, and an invitation from an admin
 *    skips the queue.
 *
 * **The token carries navigation, never authority.** It is not consulted when
 * the bypass is decided; the bypass is derived from live database state at the
 * moment the account is created. That single choice settles most of the
 * failure paths at once:
 *
 * - A **replayed** token grants nothing, because it never granted anything. It
 *   resolves a preview until the invitation is claimed, revoked or expires.
 * - A token **used by another address** admits nobody: the landing page is the
 *   login form, and the only way past it is a code delivered to the address the
 *   invitation names. The invitation stays where it was addressed.
 * - A token that **outlives its invitation** — revoked, or the radar deleted
 *   (`ON DELETE CASCADE` takes the row with it) — stops resolving, and there is
 *   nothing left for the bypass to read either. Revoking a share revokes its
 *   invitation, by construction rather than by remembering to.
 * - A **forged** token fails the HMAC and is answered exactly like a token that
 *   was never issued. Note that the HMAC is keyed by `SESSION_SECRET`, so
 *   rotating it invalidates every outstanding invitation link along with every
 *   session and access token. The invitations themselves survive; only their
 *   links die, and an ordinary sign-in still claims them.
 *
 * The token names the **invitation row**, and nothing else — not the address,
 * not the radar. A second copy of the address inside the token is a second
 * chance for it to disagree with the row that decides who gets the grant, and a
 * radar id baked into a token outlives the reason it was put there.
 */
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { INVITE, INVITE_KINDS, type InviteKind, type InvitePreviewDto } from '@onmyradar/contract';
import { hashSecret, safeEqual, signFor } from '../auth/crypto.js';
import { getDb, schema, type Db } from '../db/client.js';
import { env } from '../env.js';
import { forbidden, type Actor } from '../http.js';

const TTL_MS = INVITE.ttlDays * 24 * 60 * 60 * 1000;

/**
 * The signed body. Parsed, not cast: the signature proves who wrote it, not
 * that a future (or past) build wrote this shape.
 */
const tokenBodySchema = z.object({
  /** Format version, so a future change to the shape is distinguishable. */
  v: z.literal(1),
  k: z.enum(INVITE_KINDS),
  /** Invitation row id. */
  i: z.string().min(1),
  /** Expiry, epoch seconds. */
  e: z.number(),
});
type TokenBody = z.infer<typeof tokenBodySchema>;

/**
 * `body.signature`, where the body is base64url JSON and the signature is an
 * HMAC over the encoded body — over the encoded form, not the parsed one, so
 * there is no room for a parser disagreement between signing and checking.
 */
export function sealInviteToken(kind: InviteKind, inviteId: string, createdAt: Date): string {
  const body: TokenBody = {
    v: 1,
    k: kind,
    i: inviteId,
    e: Math.floor((createdAt.getTime() + TTL_MS) / 1000),
  };
  const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  return `${encoded}.${signFor('invite', encoded)}`;
}

/**
 * Links signed before invitations had their own signature domain were signed
 * with the bare `hashSecret`. They are honoured until the last of them could
 * have expired — every such token carries an expiry at most `INVITE.ttlDays`
 * after it was sealed, and none was sealed after 2026-09-26 — so nobody's
 * emailed invitation dies with the deploy. Past this date the branch below can
 * accept nothing and should be deleted.
 */
const LEGACY_INVITE_SIGNATURES_EXPIRE = Date.parse('2026-10-11T00:00:00Z');

/** Null for anything that is not a currently-valid token, with no distinction drawn. */
export function openInviteToken(token: string): { kind: InviteKind; id: string } | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const current = safeEqual(signature, signFor('invite', encoded));
  const legacy = !current && safeEqual(signature, hashSecret(encoded));
  if (!current && !legacy) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = tokenBodySchema.safeParse(raw);
  if (!parsed.success) return null;
  const body = parsed.data;
  if (legacy && !(body.e * 1000 <= LEGACY_INVITE_SIGNATURES_EXPIRE)) return null;
  if (body.e * 1000 <= Date.now()) return null;
  return { kind: body.k, id: body.i };
}

export function inviteUrl(kind: InviteKind, inviteId: string, createdAt: Date): string {
  return `${env().APP_URL}/invite/${sealInviteToken(kind, inviteId, createdAt)}`;
}

/**
 * Whether an invitation to this address currently skips the waitlist.
 *
 * Everything here is read live, and none of it comes from the caller:
 *
 * - the inviter must **still** be an admin, and must **still** be active — a
 *   demoted or suspended admin's outstanding invitations stop letting people
 *   in the moment their bit is cleared, rather than at some point after;
 * - the invitation must be unclaimed and within `INVITE.ttlDays` of being
 *   written, so an address handed round a year later is an ordinary signup;
 * - the address is the invitation row's own `email`, which is normalized on the
 *   way in, so the bypass cannot be pointed at a different address than the one
 *   the admin typed.
 *
 * A radar invitation and a topic invitation count the same. Both are an admin
 * deciding to bring a named person into the product.
 */
export async function invitationBypassFor(
  normalizedEmail: string,
  db: Pick<Db, 'select'> = getDb(),
): Promise<boolean> {
  const fresh = new Date(Date.now() - TTL_MS);

  const [radar] = await db
    .select({ id: schema.radarInvites.id })
    .from(schema.radarInvites)
    .innerJoin(schema.users, eq(schema.users.id, schema.radarInvites.invitedBy))
    .where(
      and(
        eq(schema.radarInvites.email, normalizedEmail),
        isNull(schema.radarInvites.acceptedAt),
        gt(schema.radarInvites.createdAt, fresh),
        eq(schema.users.isAdmin, true),
        eq(schema.users.state, 'active'),
      ),
    )
    .limit(1);
  if (radar) return true;

  const [topic] = await db
    .select({ id: schema.topicInvites.id })
    .from(schema.topicInvites)
    .innerJoin(schema.users, eq(schema.users.id, schema.topicInvites.invitedBy))
    .where(
      and(
        eq(schema.topicInvites.email, normalizedEmail),
        isNull(schema.topicInvites.acceptedAt),
        gt(schema.topicInvites.createdAt, fresh),
        eq(schema.users.isAdmin, true),
        eq(schema.users.state, 'active'),
      ),
    )
    .limit(1);
  return Boolean(topic);
}

/**
 * What an invitation link is willing to say about itself.
 *
 * Null for every failure — bad signature, expired token, revoked invitation,
 * deleted radar, invitation already claimed — because the landing page has one
 * honest thing to say in all of those cases ("this invitation is no longer
 * open, sign in normally") and telling them apart would only describe the
 * inside of somebody else's account to whoever is holding the link.
 */
export async function resolveInvite(token: string): Promise<InvitePreviewDto | null> {
  const opened = openInviteToken(token);
  if (!opened) return null;
  const db = getDb();

  const row =
    opened.kind === 'radar'
      ? (
          await db
            .select({
              email: schema.radarInvites.email,
              role: sql<string>`${schema.radarInvites.role}`,
              createdAt: schema.radarInvites.createdAt,
              invitedBy: schema.radarInvites.invitedBy,
              name: schema.radars.name,
              targetId: schema.radars.id,
            })
            .from(schema.radarInvites)
            .innerJoin(schema.radars, eq(schema.radars.id, schema.radarInvites.radarId))
            .where(
              and(
                eq(schema.radarInvites.id, opened.id),
                isNull(schema.radarInvites.acceptedAt),
                gt(schema.radarInvites.createdAt, new Date(Date.now() - TTL_MS)),
              ),
            )
            .limit(1)
        )[0]
      : (
          await db
            .select({
              email: schema.topicInvites.email,
              role: sql<string>`${schema.topicInvites.role}`,
              createdAt: schema.topicInvites.createdAt,
              invitedBy: schema.topicInvites.invitedBy,
              name: schema.topics.name,
              targetId: schema.topics.id,
            })
            .from(schema.topicInvites)
            .innerJoin(schema.topics, eq(schema.topics.id, schema.topicInvites.topicId))
            .where(
              and(
                eq(schema.topicInvites.id, opened.id),
                isNull(schema.topicInvites.acceptedAt),
                gt(schema.topicInvites.createdAt, new Date(Date.now() - TTL_MS)),
              ),
            )
            .limit(1)
        )[0];

  if (!row) return null;

  const [inviter] = row.invitedBy
    ? await db
        .select({ name: schema.users.name, email: schema.users.email })
        .from(schema.users)
        .where(eq(schema.users.id, row.invitedBy))
        .limit(1)
    : [];

  const [account] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, row.email))
    .limit(1);

  return {
    kind: opened.kind,
    name: row.name,
    invitedBy: inviter?.name ?? inviter?.email ?? 'Somebody',
    role: row.role,
    email: row.email,
    hasAccount: Boolean(account),
    // Re-derived here rather than carried in the token, for the same reason it
    // is re-derived at signup: the inviter may have stopped being an admin
    // since the email went out, and the page must not promise otherwise.
    skipsWaitlist: await invitationBypassFor(row.email),
    expiresAt: new Date(row.createdAt.getTime() + TTL_MS).toISOString(),
    next: opened.kind === 'radar' ? `/radar/${row.targetId}` : `/array/${row.targetId}`,
  };
}

/**
 * Whether this actor may bring a person who has no account into the product.
 *
 * **An agent may not.** Sharing with somebody who already has an account is
 * organising: it moves access around between people who are already here, and
 * the person on the other end can see it and undo it. Inviting an address with
 * no account behind it is a different act — an email going out in the user's
 * name to somebody who has never heard of this application, and, when the person
 * sharing is an admin, an account-creation path into a waitlisted app. That is
 * not organising by any reading, and it is a good deal more consequential than
 * the cascade tool topics already refused in both directions.
 *
 * The consent screen an agent passes through names the client. It cannot name
 * the people that client will later decide to email, because they do not exist
 * yet — so consent to connect an agent cannot be consent to this. The refusal is
 * loud and the recovery is two clicks on a real screen, which is the right shape
 * for something irreversible: an invitation cannot be unsent.
 *
 * Webhooks are refused for the same reason plus one more — a webhook actor is a
 * stored credential acting as its creator, with nobody present at all.
 */
export function assertMayInvite(actor: Actor): void {
  // Single-user mode has one human and no way for anyone else to sign in, so an
  // invitation to a new address would be a promise nobody can accept.
  if (env().SINGLE_USER_EMAIL)
    throw forbidden('This instance has one user, so there is nobody new to invite.');
  if (actor.kind === 'user') return;
  throw forbidden(
    'That address does not have an On My Radar account, and inviting somebody new ' +
      'is not something an agent may do. Share it with them from the app instead.',
  );
}

/**
 * Whether this actor's share may also approve a waitlisted account.
 *
 * The admin bit is read from the actor's own row, loaded fresh on every request,
 * so an admin demoted a minute ago is an ordinary user here. An agent is
 * excluded outright by the same argument as `assertMayInvite`: an agent holding
 * an admin's token must not be able to admit anybody to the app.
 */
export function mayBypassWaitlist(actor: Actor): boolean {
  return actor.kind === 'user' && actor.user.isAdmin && actor.user.state === 'active';
}
