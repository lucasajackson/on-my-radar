/**
 * Password hashing and the one table that holds the hashes.
 *
 * A hash is `scrypt$1$N$r$p$salt$key`, parameters included, so a cost bump later
 * verifies old hashes and reports `needsRehash` instead of locking anyone out.
 * Verification always costs exactly one scrypt, whether or not there is a hash to
 * compare against: a miss must not be cheaper than a hit, or it says which
 * addresses have a password. scrypt runs on libuv's four-thread pool, so the cost
 * is bounded to about 128 MiB at once however many requests arrive.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { getDb, schema } from '../db/client.js';

const COST = { N: 2 ** 15, r: 8, p: 1 } as const;
const KEY_BYTES = 64;
// scrypt refuses to run above 32 MiB by default, and N=2^15, r=8 needs 32 MiB plus a margin.
const MAX_MEMORY = 64 * 1024 * 1024;

const encode = (n: number, r: number, p: number, salt: Buffer, key: Buffer) =>
  `scrypt$1$${n}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`;

function derive(password: string, salt: Buffer, n: number, r: number, p: number, len: number) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, len, { N: n, r, p, maxmem: MAX_MEMORY }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return encode(
    COST.N,
    COST.r,
    COST.p,
    salt,
    await derive(password, salt, COST.N, COST.r, COST.p, KEY_BYTES),
  );
}

function parse(stored: string) {
  const [scheme, version, n, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || version !== '1' || !salt || !key) return null;
  const [N, R, P] = [Number(n), Number(r), Number(p)];
  if (![N, R, P].every(Number.isInteger)) return null;
  return {
    N,
    r: R,
    p: P,
    salt: Buffer.from(salt, 'base64url'),
    key: Buffer.from(key, 'base64url'),
  };
}

/** What a missing or unreadable hash is checked against. Its key matches no password. */
const DUMMY = { ...COST, salt: Buffer.alloc(16), key: Buffer.alloc(KEY_BYTES) };

/** `stored` is null when there is no hash to check; the answer is then always "no", at the same cost. */
export async function verifyPassword(
  password: string,
  stored: string | null,
): Promise<{ ok: boolean; needsRehash: boolean }> {
  const hash = (stored ? parse(stored) : null) ?? DUMMY;
  let key: Buffer;
  try {
    key = await derive(password, hash.salt, hash.N, hash.r, hash.p, hash.key.length);
  } catch {
    return { ok: false, needsRehash: false };
  }
  const ok = timingSafeEqual(key, hash.key);
  return { ok, needsRehash: ok && (hash.N < COST.N || hash.r < COST.r || hash.p < COST.p) };
}

export async function getPasswordHash(userId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ hash: schema.userPasswords.hash })
    .from(schema.userPasswords)
    .where(eq(schema.userPasswords.userId, userId))
    .limit(1);
  return row?.hash ?? null;
}

/**
 * A failed write must not carry the hash out: a query error names its parameters, and the
 * parameters are the hash. Whatever the driver said, the caller gets only the SQLSTATE.
 */
function scrubbed(err: unknown): Error {
  const code = (err as { cause?: { code?: string } }).cause?.code ?? 'unknown';
  return new Error(`saving a password failed (${code})`);
}

/** Returns the hash it stored. */
export async function savePassword(userId: string, password: string): Promise<string> {
  const hash = await hashPassword(password);
  try {
    await getDb()
      .insert(schema.userPasswords)
      .values({ userId, hash })
      .onConflictDoUpdate({
        target: schema.userPasswords.userId,
        set: { hash, updatedAt: new Date() },
      });
  } catch (err) {
    throw scrubbed(err);
  }
  return hash;
}

/**
 * Upgrade a hash after a successful sign-in, only if it is still the one that was verified: a
 * password changed in the meantime must not be overwritten by the old one. Null when it moved.
 */
export async function rehashPassword(
  userId: string,
  verifiedHash: string,
  password: string,
): Promise<string | null> {
  const hash = await hashPassword(password);
  try {
    const rows = await getDb()
      .update(schema.userPasswords)
      .set({ hash, updatedAt: new Date() })
      .where(
        and(eq(schema.userPasswords.userId, userId), eq(schema.userPasswords.hash, verifiedHash)),
      )
      .returning({ userId: schema.userPasswords.userId });
    return rows.length > 0 ? hash : null;
  } catch (err) {
    throw scrubbed(err);
  }
}

/**
 * Set a new password for a signed-in person, only if nothing moved since their proof was
 * checked: `verifiedHash` (null: they had none) is still the stored hash, and their session
 * still exists. Both are decided in one transaction, the session held `FOR SHARE` and the hash
 * by the compare-and-swap's own row lock, so a change that paused after verifying cannot
 * overwrite a recovery that finished meanwhile. False means nothing was changed.
 */
export async function changePassword(
  userId: string,
  sessionId: string,
  verifiedHash: string | null,
  password: string,
): Promise<boolean> {
  const hash = await hashPassword(password);
  try {
    return await getDb().transaction(async (tx) => {
      const [session] = await tx
        .select({ id: schema.sessions.id })
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.id, sessionId),
            eq(schema.sessions.userId, userId),
            gt(schema.sessions.expiresAt, new Date()),
          ),
        )
        .for('share');
      if (!session) return false;
      const rows =
        verifiedHash === null
          ? await tx
              .insert(schema.userPasswords)
              .values({ userId, hash })
              .onConflictDoNothing()
              .returning({ userId: schema.userPasswords.userId })
          : await tx
              .update(schema.userPasswords)
              .set({ hash, updatedAt: new Date() })
              .where(
                and(
                  eq(schema.userPasswords.userId, userId),
                  eq(schema.userPasswords.hash, verifiedHash),
                ),
              )
              .returning({ userId: schema.userPasswords.userId });
      return rows.length > 0;
    });
  } catch (err) {
    throw scrubbed(err);
  }
}
