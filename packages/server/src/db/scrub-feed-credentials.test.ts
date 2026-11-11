/**
 * `drizzle/0036_scrub_feed_credentials.sql`, run against fixtures written in
 * the old attribution format.
 *
 * The migration has already run on this database by the time the fixtures
 * exist, so its body is executed again here, inside a transaction exactly as
 * the migrator runs it. That is sound because it is written to be a no-op when
 * there is nothing to scrub — which the second run below asserts.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { desc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { loadEnv, setEnvForTesting } from '../env.js';
import { closeDb, getDb, getPool, schema } from './client.js';
import { runMigrations } from './migrate.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

const SQL = readFileSync(
  new URL('../../drizzle/0036_scrub_feed_credentials.sql', import.meta.url),
  'utf8',
);

describe.skipIf(!hasDatabase)('scrubbing feed credentials from imported blips', () => {
  // Its own database, so the migration it re-runs is the file as it is now:
  // a shared one would already have recorded 0036's checksum.
  const database = `omr_scrub_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
    await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(process.env['DATABASE_URL'] ?? '');
    url.pathname = `/${database}`;
    setEnvForTesting(
      loadEnv({
        ...process.env,
        DATABASE_URL: url.toString(),
        SESSION_SECRET: 'scrub-test-secret-not-used-anywhere-else',
      }),
    );
    await runMigrations();
  }, 30_000);
  afterAll(async () => {
    await closeDb();
    setEnvForTesting(null);
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end();
  });

  async function run(): Promise<Record<string, number>> {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(SQL);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const [latest] = await getDb()
      .select({ meta: schema.auditLog.meta })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'maintenance.feed_credentials_scrubbed'))
      .orderBy(desc(schema.auditLog.id))
      .limit(1);
    if (!latest) throw new Error('the scrub recorded no count');
    return latest.meta as Record<string, number>;
  }

  it('rewrites only the attribution line, only on a feed’s own entries, once', async () => {
    const [user] = await getDb()
      .insert(schema.users)
      .values({ email: `scrub-${randomUUID()}@example.test`, state: 'active' })
      .returning();
    const [other] = await getDb()
      .insert(schema.users)
      .values({ email: `scrub-other-${randomUUID()}@example.test`, state: 'active' })
      .returning();
    if (!user || !other) throw new Error('user insert returned no row');
    const [radar] = await getDb()
      .insert(schema.radars)
      .values({ ownerId: user.id, slug: `scrub-${randomUUID()}`, name: 'Feeds' })
      .returning();
    if (!radar) throw new Error('radar insert returned no row');
    const token = `hunter2-${randomUUID()}`;
    const secretUrl = `https://feeds.example/private.atom?token=${token}`;
    const clean = 'https://feeds.example/private.atom';
    const basicUrl = `https://reader:${token}@podcast.example/feed.xml`;
    await getDb()
      .insert(schema.radarFeeds)
      .values([
        { radarId: radar.id, createdBy: user.id, url: secretUrl, lookback: 'forever' },
        { radarId: radar.id, createdBy: user.id, url: basicUrl, lookback: 'forever' },
      ]);

    const line = (url: string) => `Imported from RSS feed: ${url}`;
    const blip = async (authorId: string, body: string) => {
      const [row] = await getDb()
        .insert(schema.blips)
        .values({ radarId: radar.id, authorId, kind: 'note', body })
        .returning({ id: schema.blips.id });
      if (!row) throw new Error('blip insert returned no row');
      return row.id;
    };
    const ids = {
      withPublished: await blip(
        user.id,
        `An article.\n\n${line(secretUrl)}\nPublished: 2026-09-20T10:00:00.000Z`,
      ),
      bare: await blip(user.id, line(secretUrl)),
      userInfo: await blip(user.id, `Episode.\n\n${line(basicUrl)}`),
      // A person appended their own note after the line: not guessed at.
      appended: await blip(user.id, `Article.\n\n${line(secretUrl)}\n\nMy own note.`),
      // A note exactly as long as the line, after a blank line: only the text
      // itself, not its position, can say what the line is.
      lookalike: await blip(
        user.id,
        `Article.\n\n${line(secretUrl)}\n\n${'x'.repeat(line(secretUrl).length)}`,
      ),
      // The same words, quoted by somebody who does not own that subscription.
      otherAuthor: await blip(other.id, `Look what I found:\n\n${line(secretUrl)}`),
    };
    const [notification] = await getDb()
      .insert(schema.notifications)
      .values({
        userId: user.id,
        kind: 'blip',
        groupKey: `scrub-${randomUUID()}`,
        excerpt: `An article. ${line(secretUrl)} Published: 2026`,
      })
      .returning({ id: schema.notifications.id });
    const [job] = await getDb()
      .insert(schema.outbox)
      .values({ kind: 'email', payload: { text: `${line(secretUrl)}\nPublished: x` } })
      .returning({ id: schema.outbox.id });

    if (!notification || !job) throw new Error('fixture insert returned no row');
    const counts = await run();
    expect(counts).toMatchObject({ blips: 3, notifications: 1, outbox: 1 });

    const bodies = new Map(
      (
        await getDb()
          .select({ id: schema.blips.id, body: schema.blips.body })
          .from(schema.blips)
          .where(inArray(schema.blips.id, Object.values(ids)))
      ).map((row) => [row.id, row.body]),
    );
    expect(bodies.get(ids.withPublished)).toBe(
      `An article.\n\n${line(clean)}\nPublished: 2026-09-20T10:00:00.000Z`,
    );
    expect(bodies.get(ids.bare)).toBe(line(clean));
    expect(bodies.get(ids.userInfo)).toBe(
      `Episode.\n\n${line('https://podcast.example/feed.xml')}`,
    );
    // Untouched: not provably the importer's line, or not that feed's entry.
    expect(bodies.get(ids.appended)).toContain(token);
    expect(bodies.get(ids.lookalike)).toBe(
      `Article.\n\n${line(secretUrl)}\n\n${'x'.repeat(line(secretUrl).length)}`,
    );
    expect(bodies.get(ids.otherAuthor)).toContain(token);

    const [excerpt] = await getDb()
      .select({ excerpt: schema.notifications.excerpt })
      .from(schema.notifications)
      .where(eq(schema.notifications.id, notification.id));
    expect(excerpt?.excerpt).not.toContain(token);
    const [queued] = await getDb()
      .select({ payload: schema.outbox.payload })
      .from(schema.outbox)
      .where(eq(schema.outbox.id, job.id));
    expect(JSON.stringify(queued?.payload)).not.toContain(token);
    await getDb().delete(schema.outbox).where(eq(schema.outbox.id, job.id));

    // Idempotent: a second run finds nothing it has not already done.
    expect(await run()).toMatchObject({ blips: 0, notifications: 0, outbox: 0 });
  });
});
