import { eq, sql } from 'drizzle-orm';
import { normalizeEmail } from '@onmyradar/contract';
import { getDb, schema } from '../db/client.js';
import { forbidden } from '../http.js';

export async function accountOpen(userId: string): Promise<boolean> {
  const result = await getDb().execute<{ open: boolean }>(
    sql`SELECT omr_account_open(${userId}::uuid) AS open`,
  );
  return result.rows[0]?.open === true;
}
export async function assertAccountOpen(userId: string): Promise<void> {
  if (!(await accountOpen(userId))) throw forbidden('This account is being closed.');
}
export async function emailOpen(email: string): Promise<boolean> {
  const result = await getDb().execute<{ open: boolean }>(
    sql`SELECT omr_email_open(${normalizeEmail(email)}) AS open`,
  );
  return result.rows[0]?.open === true;
}
/** Hold the recipient fence until the bounded provider send settles. Closure
 * waits for an already admitted send; it cannot recall provider-accepted mail. */
export async function withOpenRecipient(email: string, send: () => Promise<void>): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [user] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, normalizeEmail(email)))
      .limit(1);
    if (user) {
      const fence = await tx.execute(
        sql`SELECT user_id FROM account_lifecycle_fences WHERE user_id=${user.id}::uuid FOR SHARE`,
      );
      if (!fence.rows.length) throw new Error('Account admission fence is missing');
      const result = await tx.execute<{ open: boolean }>(
        sql`SELECT omr_account_open(${user.id}::uuid) AS open`,
      );
      if (result.rows[0]?.open !== true) return;
    }
    await send();
  });
}
