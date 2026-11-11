import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, getTableName, sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { accountExportMetadata, accountExportTicket } from './account-export.js';
import { accountExportObjectMetadata, accountExportObjectUrl } from './storage.js';
import type * as Storage from './storage.js';
import { createSession } from '../auth/session.js';
import { hashSecret } from '../auth/crypto.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { imageMigrationTables, runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import { must } from '../errors.js';
import type { Actor } from '../http.js';
import { createRadar, shareRadar, removeMember } from './radars.js';
import { requireRadar } from './access.js';
import { createSupport } from './support.js';
import { createGuestSupport, startGuestSupport } from './guest-support.js';
import { createRepoAgent, updatePrompt, updateBrief, setArchived } from './repo-agents.js';
import { remember, forget } from './agent-memory.js';
import { createBlip } from './blips.js';
import { createToken } from './tokens.js';
import {
  assertAccountExportSchema,
  openAccountExport,
  assertAccountExportSession,
} from './account-export-collector.js';
import { ACCOUNT_EXPORT_TABLES } from './account-export-tables.js';
import {
  accountExportPolicies,
  CLOSURE_EXPORT_POLICIES,
  STORAGE_EXPORT_INTERNALS,
  GUEST_EXPORT_INTERNALS,
  BUILDER_EXPORT_INTERNALS,
  FEATURE_EXPORT_INTERNALS,
  STORAGE_EXPORT_HISTORY,
  STORAGE_EXPORT_PRIVATE,
} from './account-export-schema.js';

vi.mock('./storage.js', async (original) => ({
  ...(await original<typeof Storage>()),
  accountExportObjectMetadata: vi.fn(async () => ({ size: 5, etag: 'fixed-etag' })),
  accountExportObjectUrl: vi.fn(async () => 'https://storage.example.test/synthetic-file'),
}));

const classified = ACCOUNT_EXPORT_TABLES.flatMap((p) =>
  [...p.include, ...p.exclude].map((column) => ({ table: p.table, column })),
);
describe('account export schema coverage', () => {
  it('requires complete builder, principal and feature generations without exporting global identities', () => {
    const builder = [
      ...BUILDER_EXPORT_INTERNALS.flatMap((p) =>
        p.exclude.map((column) => ({ table: p.table, column })),
      ),
      { table: 'plan_catalog_revisions', column: 'format_version' },
      { table: 'plan_catalog_revisions', column: 'baseline_plan_id' },
      { table: 'billing_contracts', column: 'option_id' },
    ];
    const principals = ['actor_keys', 'attributed_event_count'].map((column) => ({
      table: 'notifications',
      column,
    }));
    const features = FEATURE_EXPORT_INTERNALS.flatMap((p) =>
      p.exclude.map((column) => ({ table: p.table, column })),
    );
    for (const extension of [
      builder,
      principals,
      [...builder, ...features],
      [...builder, ...principals, ...features],
    ]) {
      const columns = [...classified, ...extension];
      const policies = assertAccountExportSchema(columns);
      for (const missing of extension)
        expect(() => assertAccountExportSchema(columns.filter((c) => c !== missing))).toThrow();
      expect(() =>
        assertAccountExportSchema([
          ...columns,
          { table: 'billing_contracts', column: 'unreviewed_terms' },
        ]),
      ).toThrow();
      expect(policies.find((p) => p.table === 'notifications')?.include).not.toContain(
        'actor_keys',
      );
      for (const policy of [...BUILDER_EXPORT_INTERNALS, ...FEATURE_EXPORT_INTERNALS])
        if (columns.some((c) => c.table === policy.table))
          expect(policies.find((p) => p.table === policy.table)?.include).toEqual([]);
    }
    expect(() => assertAccountExportSchema([...classified, ...features])).toThrow();
  });

  it('requires the complete financial generation and exports none of it', () => {
    const financial = [
      ...[
        'id',
        'user_id',
        'mode',
        'contract_id',
        'stripe_account_id',
        'subscription_id',
        'invoice_id',
        'digest',
        'summary',
        'facts',
        'observed_at',
      ].map((column) => ({ table: 'billing_financial_observations', column })),
      { table: 'billing_accounts', column: 'financial_attention' },
      { table: 'billing_events', column: 'object_id' },
    ];
    const columns = [...classified, ...financial];
    const policies = assertAccountExportSchema(columns);
    for (const table of ['billing_financial_observations', 'billing_accounts'])
      expect(policies.find((p) => p.table === table)?.include).toEqual([]);
    expect(policies.find((p) => p.table === 'billing_accounts')?.exclude).toContain(
      'financial_attention',
    );
    expect(policies.find((p) => p.table === 'billing_events')?.exclude).toContain('object_id');
    for (const missing of financial)
      expect(() => assertAccountExportSchema(columns.filter((c) => c !== missing))).toThrow();
    expect(() =>
      assertAccountExportSchema([
        ...columns,
        { table: 'billing_financial_observations', column: 'unreviewed_payment_payload' },
      ]),
    ).toThrow();
  });
  it('requires complete known lifecycle/support schemas and excludes their credential/provider internals', () => {
    const storage = [
      ...STORAGE_EXPORT_INTERNALS.flatMap((p) =>
        p.exclude.map((column) => ({ table: p.table, column })),
      ),
      ...[...STORAGE_EXPORT_HISTORY, ...STORAGE_EXPORT_PRIVATE].map((column) => ({
        table: 'storage_objects',
        column,
      })),
    ];
    const guest = [
      ...GUEST_EXPORT_INTERNALS.flatMap((p) =>
        p.exclude.map((column) => ({ table: p.table, column })),
      ),
      { table: 'helpdesk_requests', column: 'guest_capability_id' },
    ];
    for (const extension of [storage, guest, [...storage, ...guest]]) {
      const columns = [...classified, ...extension];
      const policies = assertAccountExportSchema(columns);
      for (const policy of [...STORAGE_EXPORT_INTERNALS, ...GUEST_EXPORT_INTERNALS])
        if (columns.some((c) => c.table === policy.table))
          expect(policies.find((p) => p.table === policy.table)?.include).toEqual([]);
      for (const missing of extension)
        expect(() => assertAccountExportSchema(columns.filter((c) => c !== missing))).toThrow();
      expect(() =>
        assertAccountExportSchema([
          ...columns,
          {
            table: extension === guest ? 'guest_support_capabilities' : 'storage_objects',
            column: 'unreviewed_secret',
          },
        ]),
      ).toThrow();
    }
    const combined = assertAccountExportSchema([...classified, ...storage, ...guest]);
    expect(combined.find((p) => p.table === 'storage_objects')?.include).toContain('released_at');
    expect(combined.find((p) => p.table === 'storage_objects')?.exclude).toContain(
      'tombstone_nonce',
    );
    expect(combined.find((p) => p.table === 'helpdesk_requests')?.exclude).toContain(
      'guest_capability_id',
    );
  });
  it('requires every closure column and keeps confirmation and lifecycle internals private', () => {
    const closure = CLOSURE_EXPORT_POLICIES.flatMap((p) =>
      [...p.include, ...p.exclude].map((column) => ({ table: p.table, column })),
    );
    const columns = [...classified, ...closure];
    const policies = assertAccountExportSchema(columns);
    expect(policies.find((p) => p.table === 'account_closure_requests')).toMatchObject({
      include: ['id', 'user_id', 'requested_at', 'phase'],
      exclude: ['confirmed_session_id', 'billing_snapshot'],
      where: 'r.user_id = $1',
    });
    for (const table of ['account_closure_challenges', 'account_lifecycle_fences'])
      expect(policies.find((p) => p.table === table)?.include).toEqual([]);
    for (const missing of closure)
      expect(() => assertAccountExportSchema(columns.filter((c) => c !== missing))).toThrow();
    expect(() =>
      assertAccountExportSchema([
        ...columns,
        { table: 'account_closure_requests', column: 'unreviewed_private_evidence' },
      ]),
    ).toThrow();
  });
  it('classifies every declared table and mapped field, refusing unknown tables and columns', () => {
    const declared: Array<{ table: string; column: string }> = [];
    for (const table of Object.values(schema)) {
      if (typeof table !== 'object' || Array.isArray(table)) continue;
      const name = getTableName(table as typeof schema.users);
      if (!schema.ALL_TABLE_NAMES.includes(name)) continue;
      const columns = getTableConfig(table as typeof schema.users).columns.map((c) => c.name);
      declared.push(...columns.map((column) => ({ table: name, column })));
    }
    // Drizzle omits SQL-generated fields; exact database coverage is checked
    // by the real-PG snapshot, while this check catches new declared fields.
    const policies = accountExportPolicies(declared);
    expect(policies.map((p) => p.table).sort()).toEqual([...schema.ALL_TABLE_NAMES].sort());
    for (const column of declared) {
      const policy = must(policies.find((p) => p.table === column.table));
      expect([...policy.include, ...policy.exclude], column.table).toContain(column.column);
    }
    expect(() => assertAccountExportSchema(classified)).not.toThrow();
    expect(() =>
      assertAccountExportSchema([...classified, { table: 'new_private_table', column: 'secret' }]),
    ).toThrow();
    expect(() =>
      assertAccountExportSchema([...classified, { table: 'users', column: 'new_secret' }]),
    ).toThrow();
    expect(() => assertAccountExportSchema(classified.slice(1))).toThrow();
  });

  it('skips tables newer than the image at runtime, but only those', async () => {
    const image = await imageMigrationTables();
    // The parser finds every table the policies classify, so a known table is never "newer".
    for (const table of schema.ALL_TABLE_NAMES) expect(image.has(table), table).toBe(true);
    const newer = [{ table: 'blip_pins_from_the_future', column: 'secret' }];
    expect(() => assertAccountExportSchema([...classified, ...newer], image)).not.toThrow();
    expect(() => assertAccountExportSchema([...classified, ...newer])).toThrow();
    // A table this image's migrations created, unclassified, still fails closed.
    const known = [{ table: 'decision_requests_copy', column: 'x' }];
    expect(() =>
      assertAccountExportSchema(
        [...classified, ...known],
        new Set([...image, 'decision_requests_copy']),
      ),
    ).toThrow();
    // A known table's unclassified column fails closed even with a newer table beside it.
    expect(() =>
      assertAccountExportSchema(
        [...classified, ...newer, { table: 'users', column: 'new_secret' }],
        image,
      ),
    ).toThrow();
  });
});

describe.skipIf(!process.env['DATABASE_URL'])('account export snapshot (real PostgreSQL)', () => {
  const database = `omr_export_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool;
  let actor: Actor;
  let other: Actor;
  let ownRadar: string;
  let sharedRadar: string;
  let secretRadar: string;
  let ownedFile: string;
  let privateFile: string;
  let sharedFile: string;
  const cookies = new Map<string, string>();
  async function person(): Promise<Actor> {
    const [user] = await getDb()
      .insert(schema.users)
      .values({ email: `${randomUUID()}@example.test`, state: 'active' })
      .returning();
    const session = await createSession(must(user));
    cookies.set(must(user).id, `omr_session=${session.token}`);
    const [row] = await getDb()
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.tokenHash, hashSecret(session.token)));
    return { user: must(user), kind: 'user', sessionId: must(row).id, viaCookie: true };
  }
  async function closeAccount(target: Actor) {
    await getDb()
      .insert(schema.accountClosureRequests)
      .values({
        id: randomUUID(),
        userId: target.user.id,
        confirmedSessionId: must(target.sessionId),
        billingSnapshot: {},
      });
  }
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(must(process.env['DATABASE_URL']));
    url.pathname = `/${database}`;
    setEnvForTesting(
      loadEnv({
        DATABASE_URL: url.href,
        SESSION_SECRET: 'account-export-synthetic-test-secret',
        LOG_LEVEL: 'fatal',
        NODE_ENV: 'test',
      }),
    );
    await runMigrations();
    await runMigrations();
    actor = await person();
    other = await person();
    ownRadar = (await createRadar(actor, { name: 'Owned thought' })).id;
    await getDb()
      .update(schema.radars)
      .set({ archived: true })
      .where(eq(schema.radars.id, ownRadar));
    sharedRadar = (await createRadar(other, { name: 'Shared thought' })).id;
    secretRadar = (await createRadar(other, { name: 'Never shared secret' })).id;
    await shareRadar(other, sharedRadar, actor.user.email, 'viewer');
    await createBlip(actor, ownRadar, { body: 'OWNED-CONTENT-CANARY' });
    const sharedBlip = await createBlip(other, sharedRadar, { body: 'SHARED-CONTENT-CANARY' });
    const secretBlip = await createBlip(other, secretRadar, { body: 'PRIVATE-CROSS-OWNER-CANARY' });
    const fileBlip = await createBlip(actor, ownRadar, { body: 'FILE-BLIP-CANARY' });
    ownedFile = `radars/${ownRadar}/test/file.bin`;
    privateFile = `radars/${secretRadar}/test/private.bin`;
    sharedFile = `radars/${sharedRadar}/test/shared.bin`;
    await getDb()
      .insert(schema.attachments)
      .values([
        {
          blipId: sharedBlip.id,
          radarId: sharedRadar,
          objectKey: sharedFile,
          filename: 'shared.bin',
          contentType: 'application/octet-stream',
          size: 5,
        },
        {
          blipId: fileBlip.id,
          radarId: ownRadar,
          objectKey: ownedFile,
          filename: 'file.bin',
          contentType: 'application/octet-stream',
          size: 5,
        },
        {
          blipId: secretBlip.id,
          radarId: secretRadar,
          objectKey: privateFile,
          filename: 'private.bin',
          contentType: 'application/octet-stream',
          size: 5,
        },
      ]);
    await getDb()
      .insert(schema.blipEmails)
      .values({
        blipId: sharedBlip.id,
        subject: 'SHARED-EMAIL-CANARY',
        receivedAt: new Date(),
        originalKey: `radars/${sharedRadar}/email/original.eml`,
      });
    await getDb()
      .insert(schema.blipEmails)
      .values({
        blipId: fileBlip.id,
        subject: 'RETAINED-EMAIL-CANARY',
        receivedAt: new Date(),
        payloadKey: `radars/${ownRadar}/email/payload.json`,
        originalKey: `radars/${ownRadar}/email/original.eml`,
      });
    await getDb()
      .insert(schema.emailCaptureReceipts)
      .values({
        id: 'synthetic-pending-receipt',
        radarId: ownRadar,
        sender: actor.user.email,
        body: 'PENDING-EMAIL-CANARY',
        email: {
          subject: 'Pending email',
          senderName: null,
          sentAt: null,
          preview: '',
          hasHtml: false,
          attachmentCount: 1,
          payloadKey: `radars/${ownRadar}/pending/payload.json`,
          originalKey: `radars/${ownRadar}/pending/original.eml`,
        },
        files: [
          {
            key: `radars/${ownRadar}/pending/file.bin`,
            filename: 'pending.bin',
            contentType: 'application/octet-stream',
            size: 5,
          },
        ],
      });
    await getDb()
      .insert(schema.storageObjects)
      .values([
        {
          bucket: 'on-my-radar',
          objectKey: `radars/${sharedRadar}/email/original.eml`,
          ownerId: other.user.id,
          radarId: sharedRadar,
          blipId: sharedBlip.id,
          kind: 'legacy',
          state: 'live',
          bytes: 5,
          digest: createHash('sha256').update('email').digest('hex'),
        },
        {
          bucket: 'on-my-radar',
          objectKey: sharedFile,
          ownerId: other.user.id,
          radarId: sharedRadar,
          blipId: sharedBlip.id,
          kind: 'legacy',
          state: 'live',
          bytes: 5,
          digest: createHash('sha256').update('right').digest('hex'),
        },
        {
          bucket: 'on-my-radar',
          objectKey: `radars/${ownRadar}/retained/tombstone.bin`,
          ownerId: actor.user.id,
          radarId: ownRadar,
          kind: 'legacy',
          state: 'delete_pending',
          bytes: 5,
        },
        {
          bucket: 'on-my-radar',
          objectKey: `radars/${ownRadar}/retained/reservation.bin`,
          ownerId: actor.user.id,
          radarId: ownRadar,
          kind: 'browser',
          state: 'reserved',
          bytes: 5,
          writerExpiresAt: new Date(Date.now() + 300_000),
        },
        {
          bucket: 'on-my-radar',
          objectKey: `radars/${ownRadar}/removed/deleted.bin`,
          ownerId: actor.user.id,
          radarId: ownRadar,
          kind: 'legacy',
          state: 'delete_pending',
          bytes: 5,
          deletedAt: new Date(),
        },
      ]);
    const agent = await createRepoAgent(actor, { name: 'Retained thinker' });
    await updatePrompt(actor, agent.id, { body: 'OLD-PROMPT-CANARY', basedOn: 0 });
    await updatePrompt(actor, agent.id, { body: 'CURRENT-PROMPT-CANARY', basedOn: 1 });
    await remember(actor, agent.id, {
      name: 'retained-memory',
      mode: 'create',
      type: 'project',
      description: 'Retained',
      body: 'OLD-MEMORY-CANARY',
    });
    await remember(actor, agent.id, {
      name: 'retained-memory',
      mode: 'update',
      expectedRevision: 1,
      body: 'CURRENT-MEMORY-CANARY',
    });
    await forget(actor, agent.id, { name: 'retained-memory', reason: 'Synthetic forgotten state' });
    await updateBrief(actor, agent.id, 'retained-brief', {
      description: 'Retained',
      body: 'OLD-BRIEF-CANARY',
    });
    await updateBrief(actor, agent.id, 'retained-brief', {
      expectedRevision: 1,
      body: 'CURRENT-BRIEF-CANARY',
    });
    await setArchived(actor, agent.id, true);
    const billingRows = await getDb()
      .insert(schema.billingAccounts)
      .values({
        userId: actor.user.id,
        mode: 'sandbox',
        customerId: 'cus_PRIVATEQACUSTOMER',
        subscriptionId: 'sub_PRIVATEQASUBSCRIPTION',
        subscriptionStatus: 'active',
      })
      .returning();
    expect(billingRows).toHaveLength(1);
    await getDb()
      .update(schema.users)
      .set({ isAdmin: true })
      .where(eq(schema.users.id, other.user.id));
    const helpdesk = await createRadar(other, {
      name: 'Synthetic private support',
      template: 'helpdesk',
    });
    setEnvForTesting(
      loadEnv({
        DATABASE_URL: url.href,
        SESSION_SECRET: 'account-export-synthetic-test-secret',
        LOG_LEVEL: 'fatal',
        NODE_ENV: 'test',
        SUPPORT_RADAR_ID: helpdesk.id,
        SUPPORT_OWNER_ID: other.user.id,
      }),
    );
    const request = await createSupport(actor, {
      operationId: randomUUID(),
      category: 'privacy',
      title: 'Own support',
      body: 'OWN-SUPPORT-CANARY',
    });
    await getDb()
      .insert(schema.blipComments)
      .values([
        {
          radarId: helpdesk.id,
          blipId: request.id,
          authorId: other.user.id,
          body: 'RELEASED-SUPPORT-CANARY',
          visibility: 'client',
          releasedBy: other.user.id,
          releasedAt: new Date(),
          releasedBodySha256: createHash('sha256').update('RELEASED-SUPPORT-CANARY').digest('hex'),
        },
        {
          radarId: helpdesk.id,
          blipId: request.id,
          authorId: other.user.id,
          body: 'INTERNAL-SUPPORT-CANARY',
          visibility: 'internal',
        },
        {
          radarId: helpdesk.id,
          blipId: request.id,
          authorId: other.user.id,
          body: 'UNRELEASED-SUPPORT-CANARY',
          visibility: 'client_pending',
        },
      ]);
  }, 30_000);
  afterAll(async () => {
    await closeDb();
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
  });
  async function read() {
    const snapshot = await openAccountExport(actor);
    const rows: Array<{ path: string; value: Record<string, unknown> }> = [];
    try {
      for await (const entry of snapshot.entries) {
        if (!entry.path.endsWith('.json')) continue;
        const chunks = [];
        for await (const bytes of entry.bytes) chunks.push(Buffer.from(bytes));
        rows.push({
          path: entry.path,
          value: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
        });
      }
      return rows;
    } finally {
      await snapshot.close();
    }
  }
  it('exports archived owned content and current shared content without cross-owner secrets or credentials', async () => {
    const rows = await read();
    const text = JSON.stringify(rows);
    expect(text).toContain('OWNED-CONTENT-CANARY');
    expect(text).toContain('SHARED-CONTENT-CANARY');
    expect(text).not.toContain('PRIVATE-CROSS-OWNER-CANARY');
    expect(text).toContain(ownedFile);
    expect(text).not.toContain(privateFile);
    for (const canary of [
      'OLD-PROMPT-CANARY',
      'CURRENT-PROMPT-CANARY',
      'OLD-MEMORY-CANARY',
      'CURRENT-MEMORY-CANARY',
      'OLD-BRIEF-CANARY',
      'CURRENT-BRIEF-CANARY',
      'OWN-SUPPORT-CANARY',
      'RELEASED-SUPPORT-CANARY',
      'RETAINED-EMAIL-CANARY',
      'PENDING-EMAIL-CANARY',
    ])
      expect(text).toContain(canary);
    for (const canary of [
      'INTERNAL-SUPPORT-CANARY',
      'UNRELEASED-SUPPORT-CANARY',
      'price_fixture',
      'acct_fixture',
      'cus_PRIVATEQACUSTOMER',
      'sub_PRIVATEQASUBSCRIPTION',
    ])
      expect(text).not.toContain(canary);
    // Billing was retired: the legacy row above stays in the database and out of the download.
    expect(rows.some((r) => r.path.startsWith('data/billing_'))).toBe(false);
    expect(
      rows.some((r) => r.path.startsWith('data/agent_memories/') && r.value['forgotten_at']),
    ).toBe(true);
    const data = rows.filter((row) => row.path.startsWith('data/'));
    for (const { value } of data) {
      expect(value).not.toHaveProperty('token_hash');
      expect(value).not.toHaveProperty('access_token_hash');
      expect(value).not.toHaveProperty('refresh_token_hash');
    }
    expect(
      data.some(
        (r) =>
          r.path.startsWith('data/radars/') && r.value['id'] === ownRadar && r.value['archived'],
      ),
    ).toBe(true);
  });
  it('exports a decision request only while its card is still on the radar it was asked on', async () => {
    const kept = await createBlip(other, sharedRadar, { body: 'asked and still here' });
    const moved = await createBlip(other, sharedRadar, { body: 'asked, then moved away' });
    const ask = (blipId: string, context: string) =>
      getDb().execute(sql`
        INSERT INTO decision_requests (blip_id, radar_id, requester_user_id, addressee_user_id, context, question, template)
        VALUES (${blipId}::uuid, ${sharedRadar}::uuid, ${other.user.id}::uuid, ${other.user.id}::uuid, ${context}, 'q', 'stream')`);
    await ask(kept.id, 'DECISION-KEPT-CANARY');
    await ask(moved.id, 'DECISION-MOVED-CANARY');
    // The card leaves for a radar this reader cannot open; the request must not travel with it.
    await getDb().execute(
      sql`UPDATE blips SET radar_id = ${secretRadar}::uuid WHERE id = ${moved.id}::uuid`,
    );
    const text = JSON.stringify(await read());
    expect(text).toContain('DECISION-KEPT-CANARY');
    expect(text).not.toContain('DECISION-MOVED-CANARY');
  });
  it('lays the download out as a README and one readable folder per radar', async () => {
    const snapshot = await openAccountExport(actor);
    const files = new Map<string, string>();
    try {
      for await (const entry of snapshot.entries) {
        const chunks = [];
        for await (const bytes of entry.bytes) chunks.push(Buffer.from(bytes));
        files.set(entry.path, Buffer.concat(chunks).toString());
      }
    } finally {
      await snapshot.close();
    }
    const paths = [...files.keys()];
    expect(paths[0]).toBe('README.txt');
    expect(files.get('README.txt')).toContain('manifest.json');
    expect(paths.some((path) => path.includes('reader'))).toBe(false);
    const blip = paths.find((path) =>
      /^radars\/Owned-thought\/\d{4}-\d{2}-\d{2}-FILE-BLIP-CANARY\.md$/.test(path),
    );
    const markdown = files.get(must(blip)) ?? '';
    expect(markdown).toMatch(/^---\n/);
    expect(markdown).toContain('FILE-BLIP-CANARY');
    expect(markdown).toContain('[file.bin](<files/file.bin>)');
    const base = must(blip).slice('radars/Owned-thought/'.length, -'.md'.length);
    expect(markdown).toContain(`(<emails/${base}.eml>)`);
    expect(
      paths.some((path) => /^radars\/Shared-thought\/.*SHARED-CONTENT-CANARY\.md$/.test(path)),
    ).toBe(true);
    expect(paths.some((path) => path.startsWith('radars/Never-shared-secret'))).toBe(false);
    const objects = new Map(
      (
        JSON.parse(files.get('data/files.json') ?? '[]') as Array<{ key: string; path: string }>
      ).map((object) => [object.key, object.path]),
    );
    expect(objects.get(ownedFile)).toBe('radars/Owned-thought/files/file.bin');
    expect(objects.get(sharedFile)).toBe('radars/Shared-thought/files/shared.bin');
    expect(objects.get(`radars/${ownRadar}/email/original.eml`)).toBe(
      `radars/Owned-thought/emails/${base}.eml`,
    );
    expect(objects.get(`radars/${ownRadar}/email/payload.json`)).toBe(
      `radars/Owned-thought/emails/${base}.json`,
    );
    expect(new Set(objects.values()).size).toBe(objects.size);
  });
  it('retains the shared owner ledger integrity evidence without exporting their ledger row', async () => {
    const rows = await read();
    const index = rows.find((r) => r.path === 'data/files.json');
    const objects = index?.value as unknown as Array<{ key: string; size: number; sha256: string }>;
    const shared = objects.find((o) => o.key === sharedFile);
    expect(shared).toMatchObject({
      size: 5,
      sha256: createHash('sha256').update('right').digest('hex'),
    });
    expect(objects.find((o) => o.key === `radars/${sharedRadar}/email/original.eml`)).toMatchObject(
      {
        size: 5,
        sha256: createHash('sha256').update('email').digest('hex'),
      },
    );
    expect(
      rows.some(
        (r) => r.path.startsWith('data/storage_objects/') && r.value['owner_id'] === other.user.id,
      ),
    ).toBe(false);
  });
  it('excludes populated provider operations and guest threads even when guest email matches the account', async () => {
    const generation = randomUUID();
    const runId = randomUUID();
    const bindingId = randomUUID();
    const internalKey = 'PRIVATE-PROVIDER-OBJECT-CANARY';
    const lineage = 'PRIVATE-PROVIDER-LINEAGE-CANARY';
    await getDb().execute(sql`INSERT INTO storage_protocols
      (bucket,generation,endpoint_fingerprint,provider_report)
      VALUES ('on-my-radar',${generation}::uuid,'PRIVATE-ENDPOINT-CANARY',
        ${JSON.stringify({ detail: 'PRIVATE-PROVIDER-REPORT-CANARY' })}::jsonb)`);
    await getDb().execute(sql`INSERT INTO storage_inventory_runs
      (id,bucket,generation,state,cursor,error)
      VALUES (${runId}::uuid,'on-my-radar',${generation}::uuid,'failed',
        'PRIVATE-PROVIDER-CURSOR-CANARY','PRIVATE-PROVIDER-ERROR-CANARY')`);
    await getDb().execute(sql`INSERT INTO storage_inventory_objects
      (run_id,object_key,bytes,etag,content_type,closure_nonce)
      VALUES (${runId}::uuid,${internalKey},5,${lineage},
        'application/octet-stream','PRIVATE-CLOSURE-CANARY')`);
    const [blip] = await getDb()
      .select({ id: schema.blips.id })
      .from(schema.blips)
      .where(eq(schema.blips.radarId, ownRadar))
      .limit(1);
    await getDb().execute(sql`INSERT INTO storage_migration_bindings
      (id,bucket,source_key,blip_id,generation,owner_id,radar_id,destination_key,
       source_etag,source_bytes,source_content_type)
      VALUES (${bindingId}::uuid,'on-my-radar',${internalKey},${must(blip).id}::uuid,
        ${generation}::uuid,${actor.user.id}::uuid,${ownRadar}::uuid,
        'PRIVATE-MIGRATION-DESTINATION-CANARY',${lineage},5,'application/octet-stream')`);
    const credentials = await startGuestSupport('PRIVATE-GUEST-NETWORK-CANARY');
    const guest = await createGuestSupport(credentials.token, {
      operationId: randomUUID(),
      category: 'privacy',
      title: 'PRIVATE-UNVERIFIED-GUEST-TITLE-CANARY',
      body: 'PRIVATE-UNVERIFIED-GUEST-BODY-CANARY',
      email: actor.user.email,
    });
    const requestId = must(guest.thread).request.id;
    const [requestBlip] = await getDb()
      .select({ radarId: schema.blips.radarId })
      .from(schema.blips)
      .where(eq(schema.blips.id, requestId));
    const releasedBody = 'PRIVATE-UNVERIFIED-GUEST-RELEASED-CANARY';
    await getDb()
      .insert(schema.blipComments)
      .values({
        radarId: must(requestBlip).radarId,
        blipId: requestId,
        authorId: other.user.id,
        body: releasedBody,
        visibility: 'client',
        releasedBy: other.user.id,
        releasedAt: new Date(),
        releasedBodySha256: createHash('sha256').update(releasedBody).digest('hex'),
      });
    const hashes = await getDb()
      .select({
        token: schema.guestSupportCapabilities.tokenHash,
        recovery: schema.guestSupportCapabilities.recoveryHash,
      })
      .from(schema.guestSupportCapabilities);
    const operations = await getDb()
      .select({ hash: schema.guestSupportOperations.payloadHash })
      .from(schema.guestSupportOperations);
    expect(hashes).toHaveLength(1);
    expect(operations).toHaveLength(1);
    const limits = await getDb().select().from(schema.guestSupportLimits);
    expect(limits.length).toBeGreaterThan(0);
    const rows = await read();
    const archive = JSON.stringify(rows);
    expect(archive).toContain('OWNED-CONTENT-CANARY');
    expect(archive).toContain('OWN-SUPPORT-CANARY');
    for (const canary of [
      generation,
      runId,
      bindingId,
      internalKey,
      lineage,
      'PRIVATE-ENDPOINT-CANARY',
      'PRIVATE-PROVIDER-REPORT-CANARY',
      'PRIVATE-PROVIDER-CURSOR-CANARY',
      'PRIVATE-PROVIDER-ERROR-CANARY',
      'PRIVATE-CLOSURE-CANARY',
      'PRIVATE-MIGRATION-DESTINATION-CANARY',
      'PRIVATE-GUEST-NETWORK-CANARY',
      'PRIVATE-UNVERIFIED-GUEST-TITLE-CANARY',
      'PRIVATE-UNVERIFIED-GUEST-BODY-CANARY',
      releasedBody,
      credentials.token,
      credentials.recoveryCode,
      ...hashes.flatMap((row) => [row.token, row.recovery]),
      ...operations.map((row) => row.hash),
      ...limits.map((row) => row.key),
    ])
      expect(archive).not.toContain(canary);
    for (const policy of [...STORAGE_EXPORT_INTERNALS, ...GUEST_EXPORT_INTERNALS])
      expect(rows.some((row) => row.path.startsWith(`data/${policy.table}/`))).toBe(false);
  });
  it('retains terminal ledger history without requiring retired provider payloads', async () => {
    const states = ['released', 'quarantined', 'migration_source'];
    const keys = states.map((state) => `radars/${ownRadar}/retired-${state}-${randomUUID()}`);
    const nonce = randomUUID();
    for (const [index, state] of states.entries())
      await getDb().execute(sql`INSERT INTO storage_objects
        (bucket,object_key,owner_id,radar_id,kind,state,bytes,content_type,
         protocol_generation,tombstone_nonce,released_at,retired_at)
        VALUES (${'on-my-radar'},${keys[index]},${actor.user.id}::uuid,${ownRadar}::uuid,
          'legacy',${state},5,'application/octet-stream',
          ${state === 'released' ? randomUUID() : null}::uuid,
          ${state === 'released' ? nonce : null}::uuid,
          CASE WHEN ${state}='released' THEN now() END,
          CASE WHEN ${state}='quarantined' THEN now() END)`);
    await getDb().execute(sql`INSERT INTO storage_objects
      (bucket,object_key,owner_id,radar_id,kind,state,bytes,content_type)
      VALUES ('on-my-radar',${ownedFile},${actor.user.id}::uuid,${ownRadar}::uuid,
        'legacy','migration_source',5,'application/octet-stream')`);
    const rows = await read();
    const objects = rows.find((row) => row.path === 'data/files.json')?.value as unknown as Array<{
      key: string;
    }>;
    for (const key of keys) {
      expect(
        rows.some(
          (row) => row.path.startsWith('data/storage_objects/') && row.value['object_key'] === key,
        ),
      ).toBe(true);
      expect(objects.some((object) => object.key === key)).toBe(false);
    }
    expect(JSON.stringify(rows)).not.toContain(nonce);
    expect(objects.filter((object) => object.key === ownedFile)).toHaveLength(1);
    expect(
      rows.some(
        (row) =>
          row.path.startsWith('data/storage_objects/') &&
          row.value['object_key'] === ownedFile &&
          row.value['state'] === 'migration_source',
      ),
    ).toBe(true);
    // Permanent lifecycle history remains in the isolated database until teardown.
  });
  it('refuses agent/forged/revoked sessions on the service path and serializes concurrent downloads', async () => {
    await expect(openAccountExport({ ...actor, kind: 'agent' })).rejects.toThrow();
    await expect(openAccountExport({ ...actor, sessionId: must(other.sessionId) })).rejects.toThrow(
      'Sign in',
    );
    const secondSession = await createSession(actor.user);
    const [secondRow] = await getDb()
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.tokenHash, hashSecret(secondSession.token)));
    const revokedActor: Actor = { ...actor, sessionId: must(secondRow).id };
    const open = await openAccountExport(actor);
    try {
      await expect(openAccountExport(actor)).rejects.toMatchObject({
        status: 409,
        message: 'An account download is already in progress.',
      });
      await expect(
        openAccountExport({ ...actor, sessionId: must(other.sessionId) }),
      ).rejects.toMatchObject({ status: 401 });
      await getDb()
        .delete(schema.sessions)
        .where(eq(schema.sessions.id, must(revokedActor.sessionId)));
      await expect(openAccountExport(revokedActor)).rejects.toMatchObject({ status: 401 });
    } finally {
      await open.close();
    }
    const restored = await openAccountExport(actor);
    await restored.close();
  });
  it('serves private metadata on both REST versions and refuses bearer/anonymous tickets before storage', async () => {
    const app = createApp();
    for (const prefix of ['/api', '/api/v1']) {
      const response = await app.request(`${prefix}/account/export`, {
        headers: { cookie: must(cookies.get(actor.user.id)) },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      const text = await response.text();
      expect(text).toContain('metadata-complete');
      expect(text).not.toContain('PRIVATE-CROSS-OWNER-CANARY');
      expect(text).not.toContain('INTERNAL-SUPPORT-CANARY');
    }
    vi.mocked(accountExportObjectMetadata).mockClear();
    vi.mocked(accountExportObjectUrl).mockClear();
    expect((await app.request('/api/account/export')).status).toBe(401);
    const bearer = await createToken(actor, { name: 'Synthetic bearer refusal' });
    for (const path of ['/api/account/export', '/api/v1/account/export']) {
      const refused = await app.request(path, {
        headers: { authorization: `Bearer ${must(bearer.token)}` },
      });
      expect(refused.status).toBe(403);
    }
    await expect(
      accountExportTicket({ ...actor, kind: 'agent' }, { key: ownedFile, etag: 'fixed-etag' }),
    ).rejects.toThrow();
    await expect(
      accountExportTicket(
        { ...actor, sessionId: must(other.sessionId) },
        { key: ownedFile, etag: 'fixed-etag' },
      ),
    ).rejects.toThrow();
    await expect(
      accountExportTicket(actor, { key: privateFile, etag: 'fixed-etag' }),
    ).rejects.toThrow('not found');
    expect(accountExportObjectMetadata).not.toHaveBeenCalled();
    expect(accountExportObjectUrl).not.toHaveBeenCalled();
    await expect(
      accountExportTicket(actor, { key: ownedFile, etag: 'fixed-etag' }),
    ).resolves.toEqual({ url: 'https://storage.example.test/synthetic-file' });
  });
  it('does not finish a snapshot when an expected retained object is missing or changed', async () => {
    for (const mode of ['missing', 'changed']) {
      if (mode === 'missing')
        vi.mocked(accountExportObjectMetadata).mockRejectedValueOnce(new Error('missing object'));
      else
        vi.mocked(accountExportObjectMetadata).mockResolvedValueOnce({
          size: 6,
          etag: 'fixed-etag',
        });
      const source = await accountExportMetadata(actor);
      const records: string[] = [];
      await expect(async () => {
        for await (const line of source.records) records.push(line);
      }).rejects.toThrow();
      expect(records.join('')).not.toContain('metadata-complete');
    }
  });
  it('collects more than one cursor batch and refuses cross-owner retained object references', async () => {
    await getDb()
      .insert(schema.blips)
      .values(
        Array.from({ length: 97 }, (_, index) => ({
          radarId: ownRadar,
          authorId: actor.user.id,
          body: `PAGED-EXPORT-${index}`,
        })),
      );
    const rows = await read();
    expect(
      rows.filter(
        (row) =>
          row.path.startsWith('data/blips/') &&
          (row.value['body'] as string).startsWith('PAGED-EXPORT-'),
      ),
    ).toHaveLength(97);
    const [bad] = await getDb()
      .insert(schema.attachments)
      .values({
        blipId: must(
          rows.find((r) => r.path.startsWith('data/blips/') && r.value['radar_id'] === ownRadar),
        ).value['id'] as string,
        radarId: ownRadar,
        objectKey: privateFile + '/cross-owner-reference',
        filename: 'poisoned.bin',
        contentType: 'application/octet-stream',
        size: 5,
      })
      .returning();
    try {
      await expect(read()).rejects.toThrow('ownership');
    } finally {
      await getDb()
        .delete(schema.attachments)
        .where(eq(schema.attachments.id, must(bad).id));
    }
  });
  it('includes original email, pending email, retained tombstones and landed reservations, and explicitly records absent reservations', async () => {
    const source = await accountExportMetadata(actor);
    const records = [];
    for await (const line of source.records)
      records.push(JSON.parse(line) as { type: string; key?: string });
    const keys = records.filter((r) => r.type === 'object').map((r) => r.key);
    for (const suffix of [
      'email/payload.json',
      'email/original.eml',
      'pending/payload.json',
      'pending/original.eml',
      'pending/file.bin',
      'retained/tombstone.bin',
      'retained/reservation.bin',
    ])
      expect(keys).toContain(`radars/${ownRadar}/${suffix}`);
    expect(keys).not.toContain(`radars/${ownRadar}/removed/deleted.bin`);
    vi.mocked(accountExportObjectMetadata).mockImplementation(async (key) => {
      if (key.endsWith('/reservation.bin'))
        throw Object.assign(new Error('Not Found'), { $metadata: { httpStatusCode: 404 } });
      return { size: 5, etag: 'fixed-etag' };
    });
    try {
      const retry = await accountExportMetadata(actor);
      const lines: string[] = [];
      for await (const line of retry.records) lines.push(line);
      expect(lines.join('')).toContain('object-absent');
      expect(lines.join('')).toContain('metadata-complete');
    } finally {
      vi.mocked(accountExportObjectMetadata).mockImplementation(async () => ({
        size: 5,
        etag: 'fixed-etag',
      }));
    }
  });
  it('refuses a started cursor, session rechecks and new tickets after real closure with retained active user/session', async () => {
    const target = await person();
    const radar = await createRadar(target, { name: 'Closing export owner' });
    const snapshot = await openAccountExport(target);
    try {
      for (;;) {
        const entry = await snapshot.entries.next();
        if (entry.done) throw new Error('Fixture did not reach the user cursor');
        if (entry.value.path.startsWith('data/users/')) break;
      }
      await closeAccount(target);
      expect(
        (await getDb().select().from(schema.users).where(eq(schema.users.id, target.user.id)))[0]
          ?.state,
      ).toBe('active');
      expect(
        await getDb()
          .select()
          .from(schema.sessions)
          .where(eq(schema.sessions.id, must(target.sessionId))),
      ).toHaveLength(1);
      await expect(snapshot.checkSession()).rejects.toThrow('Sign in');
      await expect(snapshot.entries.next()).rejects.toThrow('Sign in');
      await expect(openAccountExport(target)).rejects.toThrow('Sign in');
      vi.mocked(accountExportObjectMetadata).mockClear();
      vi.mocked(accountExportObjectUrl).mockClear();
      await expect(
        accountExportTicket(target, { key: `radars/${radar.id}/closed.bin`, etag: 'fixed-etag' }),
      ).rejects.toThrow('Sign in');
      expect(accountExportObjectMetadata).not.toHaveBeenCalled();
      expect(accountExportObjectUrl).not.toHaveBeenCalled();
    } finally {
      await snapshot.close();
    }
    const otherOwnerRows = await read();
    expect(JSON.stringify(otherOwnerRows)).not.toContain(target.user.id);
    for (const table of [
      'account_closure_requests',
      'account_closure_challenges',
      'account_lifecycle_fences',
    ])
      expect(otherOwnerRows.some((row) => row.path.startsWith(`data/${table}/`))).toBe(false);
  });
  it('rechecks closure after in-flight object HEAD and signing before emitting metadata or returning a ticket', async () => {
    for (const operation of ['metadata', 'absent', 'ticket', 'ticket-sign'] as const) {
      const target = await person();
      const radar = await createRadar(target, { name: `Closing ${operation} owner` });
      const blip = await createBlip(target, radar.id, { body: 'Closing retained file' });
      const key = `radars/${radar.id}/closing.bin`;
      if (operation === 'absent') {
        await getDb()
          .insert(schema.storageObjects)
          .values({
            bucket: 'on-my-radar',
            objectKey: key,
            ownerId: target.user.id,
            radarId: radar.id,
            kind: 'browser',
            state: 'reserved',
            bytes: 5,
            writerExpiresAt: new Date(Date.now() + 300_000),
          });
      } else {
        await getDb().insert(schema.attachments).values({
          blipId: blip.id,
          radarId: radar.id,
          objectKey: key,
          filename: 'closing.bin',
          contentType: 'application/octet-stream',
          size: 5,
        });
      }
      vi.mocked(accountExportObjectUrl).mockClear();
      if (operation === 'ticket-sign') {
        vi.mocked(accountExportObjectUrl).mockImplementationOnce(async () => {
          await closeAccount(target);
          return 'https://storage.example.test/synthetic-file';
        });
      } else {
        vi.mocked(accountExportObjectMetadata).mockImplementationOnce(async () => {
          await closeAccount(target);
          if (operation === 'absent')
            throw Object.assign(new Error('missing object'), {
              $metadata: { httpStatusCode: 404 },
            });
          return { size: 5, etag: 'fixed-etag' };
        });
      }
      if (operation === 'ticket' || operation === 'ticket-sign') {
        await expect(accountExportTicket(target, { key, etag: 'fixed-etag' })).rejects.toThrow(
          'Sign in',
        );
        if (operation === 'ticket') expect(accountExportObjectUrl).not.toHaveBeenCalled();
        else expect(accountExportObjectUrl).toHaveBeenCalledOnce();
      } else {
        const source = await accountExportMetadata(target);
        const records: string[] = [];
        try {
          await expect(async () => {
            for await (const record of source.records) records.push(record);
          }).rejects.toThrow('Sign in');
          expect(records.join('')).not.toContain('metadata-complete');
          expect(records.join('')).not.toContain('"type":"object"');
          expect(records.join('')).not.toContain('"type":"object-absent"');
        } finally {
          await source.close();
        }
      }
    }
  });
  for (const cause of ['owner-close', 'membership-revoke'] as const) {
    for (const boundary of ['head', 'sign'] as const) {
      it(`refuses service/REST shared tickets after ${cause} during ${boundary} while requester remains open`, async () => {
        for (const transport of ['service', 'rest'] as const) {
          const owner = await person();
          const requester = await person();
          const radar = await createRadar(owner, { name: 'In-flight shared export' });
          await shareRadar(owner, radar.id, requester.user.email, 'viewer');
          const blip = await createBlip(owner, radar.id, { body: 'Shared file export' });
          const key = `radars/${radar.id}/shared.bin`;
          await getDb().insert(schema.attachments).values({
            blipId: blip.id,
            radarId: radar.id,
            objectKey: key,
            filename: 'shared.bin',
            contentType: 'application/octet-stream',
            size: 5,
          });
          await expect(requireRadar(radar.id, requester, 'read')).resolves.toBeDefined();
          const changeAccess = async () => {
            if (cause === 'owner-close') await closeAccount(owner);
            else await removeMember(owner, radar.id, requester.user.id);
          };
          vi.mocked(accountExportObjectUrl).mockClear();
          if (boundary === 'head') {
            vi.mocked(accountExportObjectMetadata).mockImplementationOnce(async () => {
              await changeAccess();
              return { size: 5, etag: 'fixed-etag' };
            });
          } else {
            vi.mocked(accountExportObjectUrl).mockImplementationOnce(async () => {
              await changeAccess();
              return 'https://storage.example.test/SHARED-PRIVATE-URL-CANARY';
            });
          }
          try {
            if (transport === 'service') {
              await expect(
                accountExportTicket(requester, { key, etag: 'fixed-etag' }),
              ).rejects.toMatchObject({ status: 404 });
            } else {
              const response = await createApp().request('/api/account/export/object', {
                method: 'POST',
                headers: {
                  cookie: must(cookies.get(requester.user.id)),
                  'content-type': 'application/json',
                },
                body: JSON.stringify({ key, etag: 'fixed-etag' }),
              });
              expect(response.status).toBe(404);
              const body = await response.text();
              expect(body).not.toContain('SHARED-PRIVATE-URL-CANARY');
              expect(body).not.toContain('"url"');
            }
            await expect(assertAccountExportSession(requester)).resolves.toBeUndefined();
            await expect(requireRadar(radar.id, requester, 'read')).rejects.toMatchObject({
              status: 404,
            });
            if (boundary === 'head') expect(accountExportObjectUrl).not.toHaveBeenCalled();
            else expect(accountExportObjectUrl).toHaveBeenCalledOnce();
          } finally {
            vi.mocked(accountExportObjectMetadata).mockImplementation(async () => ({
              size: 5,
              etag: 'fixed-etag',
            }));
            vi.mocked(accountExportObjectUrl).mockImplementation(
              async () => 'https://storage.example.test/synthetic-file',
            );
          }
        }
      });
    }
    it(`refuses shared-object and final metadata receipts after ${cause} during HEAD`, async () => {
      const owner = await person();
      const requester = await person();
      const radar = await createRadar(owner, { name: 'Shared metadata boundary' });
      await shareRadar(owner, radar.id, requester.user.email, 'viewer');
      const blip = await createBlip(owner, radar.id, { body: 'Shared metadata file' });
      const key = `radars/${radar.id}/shared-metadata.bin`;
      await getDb().insert(schema.attachments).values({
        blipId: blip.id,
        radarId: radar.id,
        objectKey: key,
        filename: 'shared-metadata.bin',
        contentType: 'application/octet-stream',
        size: 5,
      });
      const source = await accountExportMetadata(requester);
      vi.mocked(accountExportObjectMetadata).mockImplementationOnce(async () => {
        if (cause === 'owner-close') await closeAccount(owner);
        else await removeMember(owner, radar.id, requester.user.id);
        return { size: 5, etag: 'fixed-etag' };
      });
      const records: string[] = [];
      try {
        await expect(async () => {
          for await (const record of source.records) records.push(record);
        }).rejects.toMatchObject({ status: 404 });
        expect(records.join('')).not.toContain('"type":"object"');
        expect(records.join('')).not.toContain('"type":"object-absent"');
        expect(records.join('')).not.toContain('metadata-complete');
        await expect(assertAccountExportSession(requester)).resolves.toBeUndefined();
      } finally {
        await source.close();
        vi.mocked(accountExportObjectMetadata).mockImplementation(async () => ({
          size: 5,
          etag: 'fixed-etag',
        }));
      }
    });
  }
  it('stops a started export when the real human session is revoked', async () => {
    const snapshot = await openAccountExport(actor);
    const retained = await getDb()
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, must(actor.sessionId)));
    await getDb()
      .delete(schema.sessions)
      .where(eq(schema.sessions.id, must(actor.sessionId)));
    try {
      await expect(async () => {
        for await (const entry of snapshot.entries)
          for await (const _bytes of entry.bytes) {
            /* consume */
          }
      }).rejects.toThrow('Sign in');
    } finally {
      await snapshot.close();
      await getDb().insert(schema.sessions).values(must(retained[0]));
    }
  });
  it('exports and refreshes current shared migration sources without granting historical key access', async () => {
    const currentRadar = (await createRadar(actor, { name: 'Retained shared email source' })).id;
    const current = await createBlip(actor, currentRadar, { body: 'CURRENT-MIGRATION-REFERENCE' });
    const source = `radars/${secretRadar}/legacy/shared-${randomUUID()}.eml`;
    const privateSource = `radars/${secretRadar}/legacy/private-${randomUUID()}.eml`;
    const ownHistory = `radars/${currentRadar}/legacy/history-${randomUUID()}.eml`;
    const migrationDestination = 'PRIVATE-MIGRATION-DESTINATION-CANARY';
    const migrationEtag = 'PRIVATE-MIGRATION-ETAG-CANARY';
    const digest = createHash('sha256').update('email').digest('hex');
    await getDb().insert(schema.blipEmails).values({
      blipId: current.id,
      subject: 'Shared legacy source',
      receivedAt: new Date(),
      originalKey: source,
    });
    const foreign = await createBlip(other, secretRadar, { body: 'PRIVATE-MIGRATION-REFERENCE' });
    await getDb().insert(schema.blipEmails).values({
      blipId: foreign.id,
      subject: 'Private legacy source',
      receivedAt: new Date(),
      originalKey: privateSource,
    });
    // Optional lifecycle states are absent from the runtime TypeScript model.
    // Insert their exact final fixture states directly, keeping SQL constraints.
    await getDb().execute(sql`INSERT INTO storage_objects
      (bucket,object_key,owner_id,radar_id,blip_id,kind,state,bytes,digest,content_type)
      VALUES
        ('on-my-radar',${source},${other.user.id}::uuid,${secretRadar}::uuid,
          ${current.id}::uuid,'legacy','live',5,${digest},'message/rfc822'),
        ('on-my-radar',${privateSource},${other.user.id}::uuid,${secretRadar}::uuid,
          NULL,'legacy','migration_source',5,${digest},'message/rfc822'),
        ('on-my-radar',${ownHistory},${actor.user.id}::uuid,${currentRadar}::uuid,
          NULL,'legacy','migration_source',5,${digest},'message/rfc822')`);
    await getDb().execute(sql`UPDATE storage_objects
      SET migrated_to=${migrationDestination},migration_source_etag=${migrationEtag}
      WHERE bucket='on-my-radar' AND object_key=${ownHistory}`);
    // Ordinary foreign ledger ownership still refuses a mismatched reference.
    await expect(read()).rejects.toThrow('ownership');
    await expect(accountExportTicket(actor, { key: source, etag: 'fixed-etag' })).rejects.toThrow(
      'not found',
    );
    const sharedCurrent = await createBlip(other, sharedRadar, {
      body: 'READABLE-SHARED-MIGRATION-REFERENCE',
    });
    await getDb().insert(schema.blipEmails).values({
      blipId: sharedCurrent.id,
      subject: 'Readable shared source',
      receivedAt: new Date(),
      originalKey: source,
    });
    await getDb().execute(sql`UPDATE storage_objects SET state='migration_source'
      WHERE bucket='on-my-radar' AND object_key=${source}`);
    const rows = await read();
    const objects = rows.find((row) => row.path === 'data/files.json')?.value as unknown as Array<{
      key: string;
      size: number;
      sha256: string;
    }>;
    const history = rows.find(
      (row) =>
        row.path.startsWith('data/storage_objects/') && row.value['object_key'] === ownHistory,
    );
    expect(history?.value).toMatchObject({ owner_id: actor.user.id, state: 'migration_source' });
    expect(history?.value).not.toHaveProperty('migrated_to');
    expect(history?.value).not.toHaveProperty('migration_source_etag');
    expect(JSON.stringify(rows)).not.toContain(migrationDestination);
    expect(JSON.stringify(rows)).not.toContain(migrationEtag);
    expect(objects.find((object) => object.key === source)).toMatchObject({
      size: 5,
      sha256: digest,
    });
    expect(
      objects.some((object) => object.key === privateSource || object.key === ownHistory),
    ).toBe(false);
    expect(
      rows.some(
        (row) => row.path.startsWith('data/storage_objects/') && row.value['object_key'] === source,
      ),
    ).toBe(false);
    await expect(
      accountExportTicket(actor, { key: source, etag: 'fixed-etag' }),
    ).resolves.toHaveProperty('url');
    for (const key of [privateSource, ownHistory])
      await expect(accountExportTicket(actor, { key, etag: 'fixed-etag' })).rejects.toThrow(
        'not found',
      );
  });
  it('exports an account that still has legacy billing rows, and none of them', async () => {
    await getDb().execute(sql`UPDATE billing_accounts SET financial_attention=true
      WHERE user_id=${actor.user.id}::uuid AND mode='sandbox'`);
    const rows = await read();
    expect(rows.some((r) => r.path.startsWith('data/billing_'))).toBe(false);
    expect(rows.some((r) => r.path.startsWith('data/radars/'))).toBe(true);
    const exported = JSON.stringify(rows);
    for (const privateValue of ['cus_PRIVATEQACUSTOMER', 'sub_PRIVATEQASUBSCRIPTION'])
      expect(exported).not.toContain(privateValue);
  });
  it('uses a repeatable database snapshot and refuses a newly introduced field', async () => {
    const snapshot = await openAccountExport(actor);
    await createBlip(actor, ownRadar, { body: 'CAPTURED-AFTER-SNAPSHOT' });
    let text = '';
    try {
      for await (const entry of snapshot.entries)
        for await (const bytes of entry.bytes) text += Buffer.from(bytes).toString();
    } finally {
      await snapshot.close();
    }
    expect(text).not.toContain('CAPTURED-AFTER-SNAPSHOT');
    // Every table the migrated database holds is one this image's migrations create.
    const tables = await getDb().execute<{ t: string }>(
      sql`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
    );
    const image = await imageMigrationTables();
    expect(tables.rows.filter((r) => !image.has(r.t))).toEqual([]);
    // A table a newer migration added (the next image classifies it) does not break the export.
    await getDb().execute(sql`CREATE TABLE export_unknown_table (id uuid)`);
    try {
      const during = await openAccountExport(actor);
      await during.close();
    } finally {
      await getDb().execute(sql`DROP TABLE export_unknown_table`);
    }
    await getDb().execute(sql`ALTER TABLE users ADD COLUMN export_unclassified_secret text`);
    try {
      await expect(openAccountExport(actor)).rejects.toThrow('unclassified');
    } finally {
      await getDb().execute(sql`ALTER TABLE users DROP COLUMN export_unclassified_secret`);
    }
  });
});
