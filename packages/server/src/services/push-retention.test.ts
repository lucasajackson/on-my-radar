import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import { purgePushDeliveries } from './push-delivery.js';
import { must } from '../errors.js';

const database = `omr_push_retention_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool | undefined;
beforeAll(async () => {
  if (!process.env['DATABASE_URL']) return;
  admin = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
  await admin.query(`CREATE DATABASE ${database}`);
  const url = new URL(process.env['DATABASE_URL']);
  url.pathname = `/${database}`;
  setEnvForTesting(
    loadEnv({
      ...process.env,
      DATABASE_URL: url.toString(),
      SESSION_SECRET: 'push-retention-test-only-secret-not-production',
    }),
  );
  await runMigrations();
  await runMigrations();
}, 30_000);
afterAll(async () => {
  if (!admin) return;
  await closeDb();
  await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
  await admin.end();
});
it.skipIf(!process.env['DATABASE_URL'])(
  'indexes all expired receipt states, preserves leases/jobs and deletes at most500',
  async () => {
    const db = getDb();
    const [user] = await db
      .insert(schema.users)
      .values({ email: 'retention@example.test', state: 'active' })
      .returning();
    const [notification] = await db
      .insert(schema.notifications)
      .values({ userId: must(user).id, kind: 'share', groupKey: 'retention' })
      .returning();
    await db.execute(sql`INSERT INTO push_deliveries(notification_id,destination_kind,destination_id,generation,expires_at,state)
 SELECT ${must(notification).id}::uuid,'apns',gen_random_uuid(),1,CASE WHEN n<=1200 THEN now()-interval '32 days' ELSE now()+interval '1 day' END,CASE WHEN n%2=0 THEN 'pending' ELSE 'accepted' END FROM generate_series(1,20000) n`);
    const [leased, referenced] = await db
      .insert(schema.pushDeliveries)
      .values([
        {
          notificationId: must(notification).id,
          destinationKind: 'apns',
          destinationId: randomUUID(),
          generation: 1,
          expiresAt: new Date(Date.now() - 33 * 86400000),
          leaseUntil: new Date(Date.now() + 60000),
        },
        {
          notificationId: must(notification).id,
          destinationKind: 'apns',
          destinationId: randomUUID(),
          generation: 1,
          expiresAt: new Date(Date.now() - 33 * 86400000),
        },
      ])
      .returning();
    await db
      .insert(schema.outbox)
      .values({ kind: 'push', payload: { deliveryId: must(referenced).id } });
    await db.execute(sql`ANALYZE push_deliveries`);
    const plan = await db.execute(
      sql`EXPLAIN (FORMAT JSON) SELECT d.id FROM push_deliveries d WHERE d.expires_at<now()-interval '30 days' AND (d.lease_until IS NULL OR d.lease_until<now()) AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.kind='push' AND o.payload->>'deliveryId'=d.id::text) ORDER BY d.expires_at,d.id LIMIT 500`,
    );
    expect(JSON.stringify(plan.rows)).toContain('push_deliveries_retention_idx');
    const index = await db.execute<{ predicate: string | null }>(
      sql`SELECT pg_get_expr(indpred,indrelid) AS predicate FROM pg_index WHERE indexrelid='push_deliveries_retention_idx'::regclass`,
    );
    expect(index.rows[0]?.predicate).toBeNull();
    await purgePushDeliveries();
    expect(
      (
        await db.execute<{ count: number }>(
          sql`SELECT count(*)::int AS count FROM push_deliveries WHERE expires_at<now()-interval '30 days'`,
        )
      ).rows[0]?.count,
    ).toBe(702);
    expect(
      await db
        .select()
        .from(schema.pushDeliveries)
        .where(eq(schema.pushDeliveries.id, must(leased).id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(schema.pushDeliveries)
        .where(eq(schema.pushDeliveries.id, must(referenced).id)),
    ).toHaveLength(1);
    await purgePushDeliveries();
    await purgePushDeliveries();
    const remaining = await db.execute<{ state: string; count: number }>(
      sql`SELECT state,count(*)::int AS count FROM push_deliveries WHERE expires_at<now()-interval '30 days' GROUP BY state`,
    );
    expect(remaining.rows).toEqual([{ state: 'pending', count: 2 }]);
  },
  15_000,
);
