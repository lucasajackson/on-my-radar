import { z } from 'zod';
import { accountExportOwnerId } from './account-export-policy.js';
import {
  openAccountExport,
  ACCOUNT_EXPORT_LIMITS,
  assertAccountExportSession,
} from './account-export-collector.js';
import { accountArchive } from './account-export-archive.js';
import { accountExportObjectMetadata, accountExportObjectUrl } from './storage.js';
import { requireRadar } from './access.js';
import { getPool } from '../db/client.js';
import { env } from '../env.js';
import { notFound, type Actor } from '../http.js';

export const accountExportTicketSchema = z
  .object({
    key: z.string().min(1).max(1024),
    etag: z.string().min(1).max(256),
  })
  .strict();

/** Current retained ownership or an authorized current reference, never a key alone. */
async function requireAccountExportObject(actor: Actor, key: string): Promise<void> {
  const owner = accountExportOwnerId(actor);
  const ledger = await getPool().query<{ owner_id: string; state: string; radar_id: string }>(
    'SELECT owner_id, state, radar_id FROM storage_objects WHERE bucket=$1 AND object_key=$2 AND deleted_at IS NULL',
    [env().S3_BUCKET, key],
  );
  if (['released', 'quarantined'].includes(ledger.rows[0]?.state ?? ''))
    throw notFound('Export file not found');
  if (ledger.rows[0]?.owner_id === owner && ledger.rows[0].state !== 'migration_source') {
    // The ledger names who stored it, not who may read it now. The file belongs to a radar,
    // and the ticket needs the same current access an ordinary attachment download does. A
    // radar that no longer exists gives nobody access, so its pending-cleanup files get none.
    await requireRadar(ledger.rows[0].radar_id, actor, 'read');
  } else {
    const references = await getPool().query<{ radar_id: string }>(
      `SELECT radar_id FROM attachments WHERE object_key=$1
       UNION SELECT b.radar_id FROM blip_emails e JOIN blips b ON b.id=e.blip_id WHERE e.payload_key=$1 OR e.original_key=$1
       UNION SELECT radar_id FROM email_capture_receipts WHERE completed_at IS NULL
          AND (email->>'payloadKey'=$1 OR email->>'originalKey'=$1 OR EXISTS (SELECT 1 FROM jsonb_array_elements(files) f WHERE f->>'key'=$1))`,
      [key],
    );
    let allowed = false;
    for (const reference of references.rows) {
      try {
        const access = await requireRadar(reference.radar_id, actor, 'read');
        if (
          ledger.rows[0]
            ? ledger.rows[0].owner_id !== access.radar.ownerId &&
              ledger.rows[0].state !== 'migration_source'
            : !key.startsWith(`radars/${reference.radar_id}/`)
        )
          continue;
        allowed = true;
        break;
      } catch (error) {
        if (!(error instanceof Error) || !('status' in error) || error.status !== 404) throw error;
      }
    }
    if (!allowed) throw notFound('Export file not found');
  }
}

/** A refreshed short-lived GET remains scoped to the human's current access.
 * The key is an identifier, never authority; a guessed key grants nothing. */
export async function accountExportTicket(
  actor: Actor,
  input: z.infer<typeof accountExportTicketSchema>,
) {
  await assertAccountExportSession(actor);
  await requireAccountExportObject(actor, input.key);
  const metadata = await accountExportObjectMetadata(input.key);
  if (metadata.etag !== input.etag) throw new Error('Export object changed after its snapshot');
  await assertAccountExportSession(actor);
  await requireAccountExportObject(actor, input.key);
  const url = await accountExportObjectUrl(input.key, input.etag);
  await assertAccountExportSession(actor);
  await requireAccountExportObject(actor, input.key);
  return { url };
}

/** This stream contains database records and file metadata only. Browser GETs
 * and archive assembly never carry attachment bytes through the application. */
export async function accountExportMetadata(actor: Actor) {
  const snapshot = await openAccountExport(actor);
  const started = Date.now();
  return {
    close: snapshot.close,
    records: (async function* () {
      try {
        // The metadata archive's complete receipt certifies database records only.
        for await (const record of accountArchive(snapshot.entries, ACCOUNT_EXPORT_LIMITS.bytes))
          yield record;
        await snapshot.close();
        for (const object of snapshot.objects.values()) {
          await snapshot.checkSession();
          await requireAccountExportObject(actor, object.key);
          if (Date.now() - started > ACCOUNT_EXPORT_LIMITS.durationMs)
            throw new Error('Account export exceeded its time budget');
          let observed;
          try {
            observed = await accountExportObjectMetadata(object.key, AbortSignal.timeout(30_000));
          } catch (error) {
            await snapshot.checkSession();
            await requireAccountExportObject(actor, object.key);
            if (
              object.reservation &&
              error &&
              typeof error === 'object' &&
              '$metadata' in error &&
              (error.$metadata as { httpStatusCode?: number }).httpStatusCode === 404
            ) {
              yield JSON.stringify({
                type: 'object-absent',
                key: object.key,
                path: `${object.path.replace(/\.bin$/, '')}.absent.json`,
                state: 'reserved',
                reason: 'No uploaded bytes existed when storage was checked.',
              }) + '\n';
              continue;
            }
            throw error;
          }
          await snapshot.checkSession();
          await requireAccountExportObject(actor, object.key);
          if (object.size !== null && object.size !== observed.size)
            throw new Error('Export object size disagrees with its snapshot');
          yield JSON.stringify({
            type: 'object',
            ...object,
            size: observed.size,
            etag: observed.etag,
          }) + '\n';
        }
        await snapshot.checkSession();
        for (const key of snapshot.objects.keys()) await requireAccountExportObject(actor, key);
        yield JSON.stringify({ type: 'metadata-complete', objects: snapshot.objects.size }) + '\n';
      } finally {
        await snapshot.close();
      }
    })(),
  };
}
