/** Deletes stored objects once nothing references them. */
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { deleteObjects } from './storage.js';

/**
 * Runs from the `object-cleanup` outbox job after the referencing rows are gone.
 * `omr_storage_reference_lock` is the advisory lock the reference triggers take
 * (drizzle/0053), so a key re-referenced by a concurrent capture is never deleted.
 */
export async function cleanupStorageKeys(keys: string[]) {
  await getDb().transaction(async (tx) => {
    const sorted = [...new Set(keys)].sort();
    for (const key of sorted) await tx.execute(sql`SELECT omr_storage_reference_lock(${key})`);
    const eligible: string[] = [];
    for (const key of sorted) {
      const refs = await tx.execute(sql`SELECT 1 FROM attachments WHERE object_key=${key}
        UNION ALL SELECT 1 FROM blip_emails WHERE original_key=${key} OR payload_key=${key}
        UNION ALL SELECT 1 FROM email_capture_receipts WHERE completed_at IS NULL AND
          (email->>'originalKey'=${key} OR email->>'payloadKey'=${key} OR files @> ${JSON.stringify([{ key }])}::jsonb) LIMIT 1`);
      if (!refs.rowCount) eligible.push(key);
    }
    if (eligible.length) await deleteObjects(eligible);
  });
}
