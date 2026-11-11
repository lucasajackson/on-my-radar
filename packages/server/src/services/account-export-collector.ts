/** Private account snapshot. All queries and field policies are reviewed statically. */
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg, { type PoolClient, type QueryResultRow } from 'pg';
import { clientStatusOf } from './helpdesk-projection.js';
import { getPool, schema } from '../db/client.js';
import { imageMigrationTables } from '../db/migrate.js';
import { logger } from '../logger.js';
import { ApiError, type Actor } from '../http.js';
import { env } from '../env.js';
import { getRadarAccess, readableRadarIds } from './access.js';
import { accountExportOwnerId, projectAccountExportRow } from './account-export-policy.js';
import type { ExportTablePolicy } from './account-export-tables.js';
import { accountExportPolicies } from './account-export-schema.js';
import type { ExportEntry } from './account-export-archive.js';
import { accountExportReadme, blipMarkdown, pathPart, text } from './account-export-layout.js';

export const ACCOUNT_EXPORT_LIMITS = {
  rows: 200_000,
  bytes: 64 * 1024 ** 3,
  durationMs: 30 * 60_000,
  pageSize: 16,
};

/**
 * Strict by default (the CI coverage tests). The runtime passes `imageTables`, the tables this
 * image's own migrations create: while a migration that adds a table rolls out (or after an
 * image-only rollback) the database holds a table this image has never heard of, and the newer
 * image classifies it. Those, and only those, are skipped with a warning; a table the image
 * knows that has no policy, and any unclassified column, still fail closed.
 */
export function assertAccountExportSchema(
  columns: readonly { table: string; column: string }[],
  imageTables?: ReadonlySet<string>,
): readonly ExportTablePolicy[] {
  const policies = accountExportPolicies(columns);
  const classified = new Set(policies.map((p) => p.table));
  const newer = new Set<string>();
  const actual = new Map<string, Set<string>>();
  for (const { table, column } of columns) {
    if (table === 'schema_migrations') continue;
    if (imageTables && !classified.has(table) && !imageTables.has(table)) {
      newer.add(table);
      continue;
    }
    if (!actual.has(table)) actual.set(table, new Set());
    actual.get(table)?.add(column);
  }
  if (newer.size > 0)
    logger.warn(
      { tables: [...newer].sort() },
      'Account export skipped tables newer than this image: a newer release classifies them',
    );
  if (actual.size !== policies.length)
    throw new Error('Account export table coverage differs from the database');
  for (const policy of policies) {
    const known = [...policy.include, ...policy.exclude];
    const present = actual.get(policy.table);
    if (
      new Set(known).size !== known.length ||
      !present ||
      present.size !== known.length ||
      known.some((column) => !present.has(column))
    )
      throw new Error(`Account export columns are unclassified: ${policy.table}`);
  }
  return policies;
}

async function* exportRows<T extends QueryResultRow>(
  client: PoolClient,
  query: string,
  values: unknown[],
  check: () => Promise<void>,
): AsyncGenerator<T> {
  const cursor = `export_${randomUUID().replaceAll('-', '')}`;
  await client.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR ${query}`, values);
  try {
    for (;;) {
      await check();
      const batch = await client.query<T>(
        `FETCH FORWARD ${ACCOUNT_EXPORT_LIMITS.pageSize} FROM ${cursor}`,
      );
      if (!batch.rows.length) break;
      yield* batch.rows;
    }
  } finally {
    await client.query(`CLOSE ${cursor}`);
  }
}

function jsonEntry(path: string, value: unknown): ExportEntry {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  return {
    path,
    size: bytes.length,
    bytes: Readable.from([bytes]),
  };
}

async function liveSession(actor: Actor, client: Pick<PoolClient, 'query'>) {
  const owner = accountExportOwnerId(actor);
  const result = await client.query(
    `SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.id=$1 AND s.user_id=$2 AND s.expires_at > now() AND u.state='active' AND omr_account_open(u.id)`,
    [actor.sessionId, owner],
  );
  if (!result.rowCount)
    throw new ApiError(401, 'unauthorized', 'Sign in again to download your account.');
}

export async function assertAccountExportSession(actor: Actor): Promise<void> {
  await liveSession(actor, getPool());
}

export type ExportObject = {
  key: string;
  path: string;
  size: number | null;
  sha256: string | null;
  reservation: boolean;
};

export type AccountExportSnapshot = {
  entries: AsyncGenerator<ExportEntry>;
  objects: Map<string, ExportObject>;
  checkSession: () => Promise<void>;
  close: () => Promise<void>;
};

/** Opens the snapshot before any response headers. A cursor bounds each batch;
 * object references are collected here; provider reads happen after closing it. */
export async function openAccountExport(actor: Actor): Promise<AccountExportSnapshot> {
  const owner = accountExportOwnerId(actor);
  const started = Date.now();
  const check = async () => {
    if (Date.now() - started > ACCOUNT_EXPORT_LIMITS.durationMs)
      throw new Error('Account export exceeded its time budget');
    await liveSession(actor, getPool());
  };
  await check();
  const client = await getPool().connect();
  let entries: AsyncGenerator<ExportEntry> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      try {
        // Cursor finally blocks must finish while this client is still ours.
        await entries?.return(undefined);
      } finally {
        try {
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
      }
    })();
    return closing;
  };
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '2min'");
    const locked = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired',
      [`account-export:${owner}`],
    );
    if (!locked.rows[0]?.acquired) {
      await close();
      await check();
      throw new ApiError(409, 'export_in_progress', 'An account download is already in progress.');
    }
    await liveSession(actor, client);
    const columns = await client.query<{ table: string; column: string }>(
      `SELECT c.relname AS table, a.attname AS column FROM pg_class c
       JOIN pg_namespace n ON n.oid=c.relnamespace
       JOIN pg_attribute a ON a.attrelid=c.oid
       WHERE n.nspname='public' AND c.relkind IN ('r','p')
         AND a.attnum>0 AND NOT a.attisdropped`,
    );
    const policies = assertAccountExportSchema(columns.rows, await imageMigrationTables());
    const db = drizzle(client, { schema });
    const radarIds = await readableRadarIds(owner, db);
    if (radarIds.length > ACCOUNT_EXPORT_LIMITS.rows)
      throw new Error('Account export is too large');
    const hiddenTopics = new Set<string>();
    const radarOwners = new Map<string, string>();
    for (const id of radarIds) {
      await check();
      const access = await getRadarAccess(id, actor, db);
      if (!access?.canRead) throw new Error('Account export radar authorization changed');
      if (!access.topicVisible) hiddenTopics.add(id);
      radarOwners.set(id, access.radar.ownerId);
    }
    // One readable folder per radar, named after it. Names are not unique, so a
    // repeated name gets a counter; the folder is never an identifier.
    const radarFolders = new Map<string, string>();
    const usedPaths = new Set<string>();
    const claimPath = (path: string): string => {
      let candidate = path;
      const dot = path.lastIndexOf('.');
      const slash = path.lastIndexOf('/');
      const [stem, extension] =
        dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ''];
      for (let n = 2; usedPaths.has(candidate); n++) candidate = `${stem}-${n}${extension}`;
      usedPaths.add(candidate);
      return candidate;
    };
    const names = await client.query<{ id: string; name: string }>(
      'SELECT id, name FROM radars WHERE id = ANY($1::uuid[]) ORDER BY created_at, id',
      [radarIds],
    );
    for (const radar of names.rows)
      radarFolders.set(radar.id, claimPath(`radars/${pathPart(radar.name, 60) || 'radar'}`));
    const folderOf = (radarId: string) => {
      const folder = radarFolders.get(radarId);
      if (!folder) throw new Error('Account export radar folder is missing');
      return folder;
    };
    // Paths the blip files link to, so each link names the file actually written.
    const attachmentPaths = new Map<string, string>();
    const emailPaths = new Map<string, { payload: string; original: string }>();
    const OTHER_FILES = 'other-files/';
    let otherFiles = 0;
    const objects = new Map<string, ExportObject>();
    const addObject = async (
      key: unknown,
      size: unknown,
      expectedOwner: string,
      radarId: string,
      source: 'reference' | 'ledger',
      sha256: unknown = null,
      reservation = false,
      readable?: string,
    ) => {
      if (key === null || key === undefined) return;
      if (typeof key !== 'string' || !key.startsWith('radars/') || key.includes('\0'))
        throw new Error('Account export object reference is invalid');
      if (typeof size === 'string' && /^[0-9]+$/.test(size)) size = Number(size);
      if (size !== null && (!Number.isSafeInteger(size) || (size as number) < 0))
        throw new Error('Account export object size is invalid');
      const ledger = await client.query<{
        owner_id: string;
        state: string;
        digest: string | null;
        bytes: string | null;
      }>(
        'SELECT owner_id, state, digest, bytes FROM storage_objects WHERE bucket=$1 AND object_key=$2',
        [env().S3_BUCKET, key],
      );
      // A shared migration source retains its historical ledger owner while
      // an authorized current reference can still need the original bytes.
      const retainedReference =
        source === 'reference' &&
        ledger.rows[0]?.state === 'migration_source' &&
        radarOwners.get(radarId) === expectedOwner;
      if (
        ledger.rows[0]
          ? ledger.rows[0].owner_id !== expectedOwner && !retainedReference
          : !key.startsWith(`radars/${radarId}/`)
      )
        throw new Error('Account export object ownership cannot be verified');
      const ledgerBytes = ledger.rows[0]?.bytes;
      if (ledgerBytes !== null && ledgerBytes !== undefined) {
        const measured = Number(ledgerBytes);
        if (!Number.isSafeInteger(measured) || measured < 0)
          throw new Error('Account export object size is invalid');
        if (size !== null && size !== measured)
          throw new Error('Account export object references disagree');
        size = measured;
      }
      const ledgerDigest = ledger.rows[0]?.digest;
      if (ledgerDigest) {
        if (sha256 !== null && sha256 !== undefined && sha256 !== ledgerDigest)
          throw new Error('Account export object digests disagree');
        sha256 = ledgerDigest;
      }
      const existing = objects.get(key);
      if (existing && existing.size !== null && size !== null && existing.size !== size)
        throw new Error('Account export object references disagree');
      if (
        sha256 !== null &&
        sha256 !== undefined &&
        (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256))
      )
        throw new Error('Account export object digest is invalid');
      const digest = typeof sha256 === 'string' ? sha256 : null;
      if (existing && existing.sha256 && digest && existing.sha256 !== digest)
        throw new Error('Account export object digests disagree');
      // A readable path (beside its radar's blips) replaces the generic one a
      // ledger row gave the same object before its reference was reached.
      // `readable` arrives already claimed.
      let path = existing?.path;
      if (!path || (readable && path.startsWith(OTHER_FILES))) {
        if (path) usedPaths.delete(path);
        path = readable ?? claimPath(`${OTHER_FILES}${++otherFiles}.bin`);
      }
      objects.set(key, {
        key,
        path,
        size: (existing?.size ?? size) as number | null,
        sha256: existing?.sha256 ?? digest,
        reservation: existing ? existing.reservation && reservation : reservation,
      });
    };
    /** The readable copy of one blip, beside its radar's files and emails. */
    const blipFile = async (row: Record<string, unknown>): Promise<ExportEntry> => {
      const id = row['id'] as string;
      const radarId = row['radar_id'] as string;
      const folder = folderOf(radarId);
      const related = await client.query<{
        files: Array<{ id: string; filename: string }>;
        email: { payload: boolean; original: boolean } | null;
      }>(
        `SELECT
           (SELECT COALESCE(json_agg(json_build_object('id', a.id, 'filename', a.filename) ORDER BY a.created_at, a.id), '[]'::json)
              FROM attachments a WHERE a.blip_id = $1 AND a.radar_id = ANY($2::uuid[])) AS files,
           (SELECT json_build_object('payload', e.payload_key IS NOT NULL, 'original', e.original_key IS NOT NULL)
              FROM blip_emails e WHERE e.blip_id = $1) AS email`,
        [id, radarIds],
      );
      const created = String(row['created_at']).slice(0, 10);
      const name = pathPart(text(row['title']) || text(row['body']).split('\n')[0] || '', 60);
      const path = claimPath(`${folder}/${created}-${name || 'blip'}.md`);
      const base = path.slice(folder.length + 1, -'.md'.length);
      const files = (related.rows[0]?.files ?? []).map((file) => {
        const path = claimPath(`${folder}/files/${pathPart(file.filename, 80) || 'file'}`);
        attachmentPaths.set(file.id, path);
        return { name: file.filename, link: path.slice(folder.length + 1) };
      });
      const email = related.rows[0]?.email;
      let emailLinks: { payload?: string; original?: string } = {};
      if (email) {
        const paths = {
          payload: claimPath(`${folder}/emails/${base}.json`),
          original: claimPath(`${folder}/emails/${base}.eml`),
        };
        emailPaths.set(id, paths);
        emailLinks = {
          ...(email.payload ? { payload: paths.payload.slice(folder.length + 1) } : {}),
          ...(email.original ? { original: paths.original.slice(folder.length + 1) } : {}),
        };
      }
      const bytes = Buffer.from(blipMarkdown(row, files, emailLinks));
      return { path, size: bytes.length, bytes: Readable.from([bytes]) };
    };
    entries = (async function* (): AsyncGenerator<ExportEntry> {
      let count = 0;
      const readme = Buffer.from(accountExportReadme(new Date(started)));
      yield { path: 'README.txt', size: readme.length, bytes: Readable.from([readme]) };
      yield jsonEntry('data/export-info.json', {
        format: 'onmyradar-account',
        version: 1,
        accountId: owner,
        snapshotAt: new Date(started).toISOString(),
        scope: 'Owned account records and currently readable shared radar content',
        tables: policies.map(({ table, reason, include, exclude }) => ({
          table,
          reason,
          includedColumns: include,
          excludedColumns: exclude,
        })),
        deletedContent:
          'Only retained records and objects are recoverable; permanently removed rows are not reconstructed.',
      });
      for (const policy of policies) {
        if (!policy.where) continue;
        // Identifier and predicate strings are static source policy, never input.
        const fields = policy.include.map((field) => `r."${field}"`).join(',');
        const cursor = `export_${randomUUID().replaceAll('-', '')}`;
        await client.query(
          `DECLARE ${cursor} NO SCROLL CURSOR FOR SELECT ${fields} FROM "${policy.table}" r WHERE $1::uuid IS NOT NULL AND (${policy.where})`,
          policy.where.includes('$2') ? [owner, radarIds] : [owner],
        );
        let index = 0;
        try {
          for (;;) {
            if (Date.now() - started > ACCOUNT_EXPORT_LIMITS.durationMs)
              throw new Error('Account export exceeded its time budget');
            // A fresh connection observes revocation instead of the old snapshot.
            await liveSession(actor, getPool());
            const batch = await client.query<Record<string, unknown>>({
              text: `FETCH FORWARD ${ACCOUNT_EXPORT_LIMITS.pageSize} FROM ${cursor}`,
              types: {
                getTypeParser: (oid: number) =>
                  oid === 20 || oid === 1184
                    ? (value: string) => value
                    : (pg.types.getTypeParser(oid) as (value: string) => unknown),
              },
            });
            if (!batch.rows.length) break;
            for (const raw of batch.rows) {
              if (++count > ACCOUNT_EXPORT_LIMITS.rows)
                throw new Error('Account export is too large');
              const row = projectAccountExportRow(raw, policy.include, []);
              if (policy.table === 'radars' && hiddenTopics.has(row['id'] as string))
                row['topic_id'] = null;
              if (policy.table === 'attachments')
                await addObject(
                  row['object_key'],
                  row['size'],
                  radarOwners.get(row['radar_id'] as string) ?? '',
                  row['radar_id'] as string,
                  'reference',
                  null,
                  false,
                  attachmentPaths.get(row['id'] as string) ??
                    claimPath(
                      `${folderOf(row['radar_id'] as string)}/files/${pathPart(String(row['filename']), 80) || 'file'}`,
                    ),
                );
              if (policy.table === 'blip_emails') {
                const [parent] = (
                  await client.query<{ radar_id: string }>(
                    'SELECT radar_id FROM blips WHERE id=$1',
                    [row['blip_id']],
                  )
                ).rows;
                if (!parent) throw new Error('Email export parent is missing');
                const email = emailPaths.get(row['blip_id'] as string);
                await addObject(
                  row['payload_key'],
                  null,
                  radarOwners.get(parent.radar_id) ?? '',
                  parent.radar_id,
                  'reference',
                  null,
                  false,
                  email?.payload,
                );
                await addObject(
                  row['original_key'],
                  null,
                  radarOwners.get(parent.radar_id) ?? '',
                  parent.radar_id,
                  'reference',
                  null,
                  false,
                  email?.original,
                );
              }
              if (policy.table === 'email_capture_receipts' && !row['completed_at']) {
                const email = row['email'] as { payloadKey: string; originalKey: string } | null;
                if (email) {
                  await addObject(
                    email.payloadKey,
                    null,
                    owner,
                    row['radar_id'] as string,
                    'reference',
                  );
                  await addObject(
                    email.originalKey,
                    null,
                    owner,
                    row['radar_id'] as string,
                    'reference',
                  );
                }
                for (const file of row['files'] as Array<{ key: string; size: number }>)
                  await addObject(
                    file.key,
                    file.size,
                    owner,
                    row['radar_id'] as string,
                    'reference',
                  );
              }
              if (policy.table === 'storage_objects' && row['deleted_at'] === null) {
                if (row['bucket'] !== env().S3_BUCKET)
                  throw new Error('Account export references an unconfigured object bucket');
                // A reservation may already contain uploaded bytes. The transport
                // records a provider-confirmed absence explicitly for reservations.
                // Migration sources are overhead history. Any still-current
                // attachment/email/receipt reference was collected separately.
                if (!['released', 'quarantined', 'migration_source'].includes(String(row['state'])))
                  await addObject(
                    row['object_key'],
                    row['state'] === 'reserved' ? null : row['bytes'],
                    owner,
                    row['radar_id'] as string,
                    'ledger',
                    row['digest'],
                    row['state'] === 'reserved',
                  );
              }
              yield jsonEntry(`data/${policy.table}/${++index}.json`, row);
              if (policy.table === 'blips') yield await blipFile(row);
            }
          }
        } finally {
          await client.query(`CLOSE ${cursor}`);
        }
      }
      const requests = exportRows<{
        id: string;
        title: string | null;
        body: string;
        category: string;
        status: string | null;
        template: string;
        template_config: unknown;
        created_at: Date;
      }>(
        client,
        `SELECT b.id,b.title,b.body,h.support_category AS category,b.status,r.template,r.template_config,b.created_at
         FROM helpdesk_requests h JOIN blips b ON b.id=h.blip_id JOIN radars r ON r.id=b.radar_id
         JOIN users u ON u.id=r.owner_id WHERE h.origin='support' AND h.native_requester_user_id=$1
         AND r.id=$2 AND r.owner_id=$3 AND u.state='active' AND u.is_admin
         AND r.visibility='private' AND r.template='helpdesk'`,
        [owner, env().SUPPORT_RADAR_ID ?? null, env().SUPPORT_OWNER_ID ?? null],
        check,
      );
      for await (const request of requests) {
        if (++count > ACCOUNT_EXPORT_LIMITS.rows) throw new Error('Account export is too large');
        yield jsonEntry(`support/${request.id}/request.json`, {
          id: request.id,
          title: request.title,
          body: request.body,
          category: request.category,
          status: clientStatusOf(
            { template: request.template, templateConfig: request.template_config },
            request.status,
          ),
          createdAt: request.created_at,
        });
        const replies = exportRows<{
          id: string;
          body: string;
          created_at: Date;
          from: string;
        }>(
          client,
          `SELECT id,body,COALESCE(released_at,created_at) AS created_at,CASE WHEN external_author IS NULL THEN 'support' ELSE 'you' END AS from
           FROM blip_comments WHERE blip_id=$1 AND visibility='client' ORDER BY COALESCE(released_at,created_at),id`,
          [request.id],
          check,
        );
        for await (const reply of replies) {
          if (++count > ACCOUNT_EXPORT_LIMITS.rows) throw new Error('Account export is too large');
          yield jsonEntry(`support/${request.id}/${reply.id}.json`, reply);
        }
      }
      yield jsonEntry('data/files.json', [...objects.values()]);
    })();
    return { entries, objects, checkSession: () => liveSession(actor, getPool()), close };
  } catch (error) {
    await close();
    throw error;
  }
}
