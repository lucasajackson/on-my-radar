/**
 * An audit write fails open — including inside somebody else's transaction.
 *
 * Outside a transaction, catching the failed insert is enough. Inside one it is
 * not: Postgres has already aborted the transaction, and the caller's COMMIT
 * comes back as a silent ROLLBACK. `createSubscription` returned a signing
 * secret for a subscription that was never stored. The audit insert now runs
 * in a savepoint, so its failure stays its own.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { recordAudit } from './audit.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

describe.skipIf(!hasDatabase)('audit inside a transaction (real postgres)', () => {
  beforeAll(async () => {
    await runMigrations();
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  it('keeps the caller’s write when the audit row cannot be stored', async () => {
    const email = `audit-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
    await getDb().transaction(async (tx) => {
      await tx.insert(schema.users).values({ email, state: 'active' });
      // jsonb refuses a NUL, so this insert fails inside the transaction.
      await recordAudit(null, 'audit.test', null, null, { bad: 'a\u0000b' }, tx);
      // And the transaction is still usable afterwards.
      await tx.update(schema.users).set({ name: 'kept' }).where(eq(schema.users.email, email));
    });
    const [row] = await getDb().select().from(schema.users).where(eq(schema.users.email, email));
    expect(row?.name).toBe('kept');
  });

  it('still records the row when nothing goes wrong', async () => {
    const action = `audit.ok.${Date.now()}`;
    await getDb().transaction(async (tx) => {
      await recordAudit(null, action, null, null, { fine: true }, tx);
    });
    const rows = await getDb()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, action));
    expect(rows).toHaveLength(1);
  });
});
