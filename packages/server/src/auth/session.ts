import { sql } from 'drizzle-orm';
/** Session issue / resolve / revoke, and the cookie that carries one. */
import { and, desc, eq, gt, ne } from 'drizzle-orm';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { SESSION_TTL_DAYS, type SessionClient } from '@onmyradar/contract';
import { getDb, schema } from '../db/client.js';
import { env } from '../env.js';
import { hashSecret, newSessionToken } from './crypto.js';
import type { UserRow } from './accounts.js';

export const SESSION_COOKIE = 'omr_session';

function cookieOptions() {
  const secure = env().PUBLIC_URL.startsWith('https://');
  return {
    httpOnly: true,
    secure,
    // Lax, not Strict: the OIDC provider and the email client both land the user
    // here by top-level navigation, and Strict would drop the cookie on arrival.
    sameSite: 'Lax' as const,
    path: '/',
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  };
}

export interface IssuedSession {
  token: string;
  expiresAt: Date;
}

/** A password sign-in whose password was changed or reset before its session could be issued. */
export class PasswordChangedError extends Error {}

export async function createSession(
  user: UserRow,
  meta: {
    userAgent?: string | null;
    ip?: string | null;
    client?: SessionClient;
    label?: string | null;
    /**
     * The hash a password sign-in verified. The session is issued only if that is still the
     * user's hash: the row is held `FOR SHARE` through the insert, so a password change (which
     * updates the row, then revokes sessions) either runs after this session exists and revokes
     * it, or runs first and this throws. Without it a login that paused after verifying could
     * outlive the change that was meant to end it.
     */
    passwordHash?: string;
  } = {},
): Promise<IssuedSession> {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await getDb().transaction(async (tx) => {
    if (meta.passwordHash) {
      const [current] = await tx
        .select({ hash: schema.userPasswords.hash })
        .from(schema.userPasswords)
        .where(
          and(
            eq(schema.userPasswords.userId, user.id),
            eq(schema.userPasswords.hash, meta.passwordHash),
          ),
        )
        .for('share');
      if (!current) throw new PasswordChangedError();
    }
    await tx.insert(schema.sessions).values({
      userId: user.id,
      tokenHash: hashSecret(token),
      userAgent: meta.userAgent?.slice(0, 400) ?? null,
      ip: meta.ip ?? null,
      client: meta.client ?? 'web',
      label: meta.label?.slice(0, 120) ?? null,
      expiresAt,
    });
  });
  return { token, expiresAt };
}

export interface ResolvedSession {
  sessionId: string;
  user: UserRow;
  client: SessionClient;
}

/** Returns null for an unknown, expired, or orphaned token. */
export async function resolveSession(token: string): Promise<ResolvedSession | null> {
  const rows = await getDb()
    .select({ session: schema.sessions, user: schema.users })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(
      and(
        eq(schema.sessions.tokenHash, hashSecret(token)),
        sql`omr_account_open(${schema.users.id})`,
        gt(schema.sessions.expiresAt, new Date()),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  // Best-effort recency for the sessions list; never block the request on it.
  //
  // A bearer client also renews here, on a sliding window: past the halfway
  // mark the expiry is pushed out again. A browser can be handed a fresh cookie
  // on any response and a native client cannot, so without this an app in daily
  // use would still sign somebody out on the thirtieth day for no reason they
  // could see. An abandoned client still expires on schedule, because nothing
  // renews a session that stops authenticating.
  const now = new Date();
  const ttlMs = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
  const renew =
    row.session.client !== 'web' && row.session.expiresAt.getTime() - now.getTime() < ttlMs / 2;

  void getDb()
    .update(schema.sessions)
    .set({ lastUsedAt: now, ...(renew ? { expiresAt: new Date(now.getTime() + ttlMs) } : {}) })
    .where(eq(schema.sessions.id, row.session.id))
    .catch(() => undefined);

  return {
    sessionId: row.session.id,
    user: row.user,
    client: row.session.client as SessionClient,
  };
}

export interface SessionSummary {
  id: string;
  client: SessionClient;
  label: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
}

/** Every live session for one person, newest first. Never includes a token. */
export async function listSessions(userId: string): Promise<SessionSummary[]> {
  const rows = await getDb()
    .select({
      id: schema.sessions.id,
      client: schema.sessions.client,
      label: schema.sessions.label,
      userAgent: schema.sessions.userAgent,
      createdAt: schema.sessions.createdAt,
      lastUsedAt: schema.sessions.lastUsedAt,
      expiresAt: schema.sessions.expiresAt,
    })
    .from(schema.sessions)
    .where(and(eq(schema.sessions.userId, userId), gt(schema.sessions.expiresAt, new Date())))
    .orderBy(desc(schema.sessions.createdAt));

  return rows.map((r) => ({ ...r, client: r.client as SessionClient }));
}

/**
 * Revoke one of a person's own sessions. Scoped by `userId` in the statement
 * rather than checked first, so there is no window between the two and no way
 * to revoke somebody else's by guessing an id.
 */
export async function revokeSessionFor(userId: string, sessionId: string): Promise<boolean> {
  const rows = await getDb()
    .delete(schema.sessions)
    .where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, userId)))
    .returning({ id: schema.sessions.id });
  return rows.length > 0;
}

export async function revokeSession(sessionId: string): Promise<void> {
  await getDb().delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await getDb().delete(schema.sessions).where(eq(schema.sessions.userId, userId));
}

/** Every session of a person but the one making the request: a changed password ends the rest. */
export async function revokeOtherSessions(userId: string, keepSessionId: string): Promise<void> {
  await getDb()
    .delete(schema.sessions)
    .where(and(eq(schema.sessions.userId, userId), ne(schema.sessions.id, keepSessionId)));
}

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, cookieOptions());
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export function readSessionCookie(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}
