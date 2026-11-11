import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSession } from '../auth/session.js';
import { hashSecret } from '../auth/crypto.js';
import { closeDb, getDb, getPool, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import { must } from '../errors.js';
import type { Actor } from '../http.js';
import { openAccountExport } from './account-export-collector.js';
import { createBlip, updateBlip } from './blips.js';
import { createRadar } from './radars.js';

describe.skipIf(!process.env['DATABASE_URL'])('account export on current runtime schema', () => {
  const database = `omr_export_current_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool | undefined;
  let actor: Actor;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(must(process.env['DATABASE_URL']));
    url.pathname = `/${database}`;
    setEnvForTesting(
      loadEnv({
        DATABASE_URL: url.href,
        SESSION_SECRET: 'current-account-export-synthetic-secret',
        LOG_LEVEL: 'fatal',
        NODE_ENV: 'test',
      }),
    );
    await runMigrations();
    await runMigrations();
    const [user] = await getDb()
      .insert(schema.users)
      .values({ email: `${randomUUID()}@example.test`, state: 'active' })
      .returning();
    const session = await createSession(must(user));
    const [sessionRow] = await getDb()
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.tokenHash, hashSecret(session.token)));
    actor = { kind: 'user', user: must(user), sessionId: must(sessionRow).id };
    const radar = await createRadar(actor, { name: 'Current owned records' });
    const owned = await createBlip(actor, radar.id, { body: 'OWNED-REVISION-PRIOR' });
    await updateBlip(actor, owned.id, { body: 'CURRENT-SCHEMA-OWNED-CONTENT' });
    const [foreignUser] = await getDb()
      .insert(schema.users)
      .values({ email: `${randomUUID()}@example.test`, state: 'active' })
      .returning();
    const foreign: Actor = { kind: 'user', user: must(foreignUser) };
    const privateRadar = await createRadar(foreign, { name: 'PRIVATE-OTHER-OWNER-RADAR' });
    const hidden = await createBlip(foreign, privateRadar.id, { body: 'PRIVATE-OTHER-PRIOR' });
    await updateBlip(foreign, hidden.id, { body: 'PRIVATE-OTHER-OWNER-CONTENT' });
    // A retired-billing leftover: the row stays in the database and out of the download.
    await getDb().insert(schema.billingAccounts).values({
      userId: actor.user.id,
      mode: 'sandbox',
      customerId: 'cus_PRIVATECONTRACT',
      subscriptionStatus: 'active',
    });
  });
  afterAll(async () => {
    await closeDb();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await admin.end();
    }
    setEnvForTesting(null);
  });
  async function read(who: Actor = actor) {
    const snapshot = await openAccountExport(who);
    const rows: Array<{ path: string; value: Record<string, unknown> }> = [];
    try {
      for await (const entry of snapshot.entries) {
        if (!entry.path.endsWith('.json')) continue;
        let body = '';
        for await (const chunk of entry.bytes) body += Buffer.from(chunk).toString();
        rows.push({ path: entry.path, value: JSON.parse(body) as Record<string, unknown> });
      }
    } finally {
      await snapshot.close();
    }
    return rows;
  }
  it('exports current owned data, and no retired billing rows', async () => {
    const rows = await read();
    expect(rows.some((row) => row.path.startsWith('data/billing_accounts/'))).toBe(false);
    const text = JSON.stringify(rows);
    expect(text).toContain('CURRENT-SCHEMA-OWNED-CONTENT');
    // The edit history of an owned blip travels with it; another account's does not.
    expect(rows.some((row) => row.path.startsWith('data/blip_revisions/'))).toBe(true);
    expect(text).toContain('OWNED-REVISION-PRIOR');
    for (const canary of [
      'PRIVATE-OTHER-OWNER-RADAR',
      'PRIVATE-OTHER-OWNER-CONTENT',
      'PRIVATE-OTHER-PRIOR',
      'cus_PRIVATECONTRACT',
    ])
      expect(text).not.toContain(canary);
    for (const table of [
      'plan_catalog_revisions',
      'plan_catalog_plan_ids',
      'plan_feature_terms',
      'billing_financial_observations',
      'storage_protocols',
    ])
      expect(rows.some((row) => row.path.startsWith(`data/${table}/`))).toBe(false);
    expect(rows.find((row) => row.path === 'data/export-info.json')?.value['tables']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'billing_financial_observations' }),
      ]),
    );
  });
  it('exports no text from before a card moved onto a radar the exporter reads', async () => {
    const [reader] = await getDb()
      .insert(schema.users)
      .values({ email: `${randomUUID()}@example.test`, state: 'active' })
      .returning();
    const privateA = await createRadar(actor, { name: 'Private A' });
    const sharedB = await createRadar(actor, { name: 'Shared B' });
    await getDb()
      .insert(schema.radarMembers)
      .values({ radarId: sharedB.id, userId: must(reader).id, role: 'viewer' });
    const card = await createBlip(actor, privateA.id, {
      title: 'SECRET-PRE-MOVE-TITLE',
      body: 'SECRET-PRE-MOVE-TEXT',
    });
    await updateBlip(actor, card.id, { body: 'sanitized', title: 'clean' });
    await updateBlip(actor, card.id, { radarId: sharedB.id });
    await updateBlip(actor, card.id, { body: 'edited on B' });
    const session = await createSession(must(reader));
    const [sessionRow] = await getDb()
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.tokenHash, hashSecret(session.token)));
    const exported = JSON.stringify(
      await read({ kind: 'user', user: must(reader), sessionId: must(sessionRow).id }),
    );
    expect(exported).toContain('edited on B');
    expect(exported).not.toContain('SECRET-PRE-MOVE');
  });
  it('closes a paused cursor before its connection can be reused by another transaction', async () => {
    const snapshot = await openAccountExport(actor);
    for (;;) {
      const next = await snapshot.entries.next();
      if (next.done) throw new Error('Fixture never reached an open account cursor');
      if (next.value.path.startsWith('data/users/')) break;
    }
    await snapshot.close();
    const reused = await getPool().connect();
    try {
      await reused.query('BEGIN');
      await expect(snapshot.entries.return(undefined)).resolves.toMatchObject({ done: true });
      expect((await reused.query('SELECT 1 AS healthy')).rows).toEqual([{ healthy: 1 }]);
    } finally {
      await reused.query('ROLLBACK');
      reused.release();
      await snapshot.close();
    }
  });
});
