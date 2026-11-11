/** The agent ceiling and the owner lock on isolated PostgreSQL, with competing writers. */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_REPO, importAgentSchema } from '@onmyradar/contract';
import { getDb, closeDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import { must } from '../errors.js';
import type { Actor } from '../http.js';
import { ensureDefaultWorkspace } from '../auth/accounts.js';
import { WELCOME_RADAR } from '../auth/welcome.js';
import { createRadar, ensureDropBox } from './radars.js';
import { acceptTransfer, createRepoAgent, importAgent, offerTransfer } from './repo-agents.js';
import { dashboardWidgetResults } from './dashboards.js';

describe.skipIf(!process.env['DATABASE_URL'])('owner limits (isolated Postgres)', () => {
  const scratch = `omr_owner_limits_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool;
  let target: string;
  let owner: Actor;

  async function person(): Promise<Actor> {
    const [user] = await getDb()
      .insert(schema.users)
      .values({ email: `limits-${randomUUID()}@example.test`, state: 'active' })
      .returning();
    return { user: must(user), kind: 'user', sessionId: randomUUID() };
  }
  async function agentCount(actor: Actor) {
    const [row] = await getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.repoAgents)
      .where(eq(schema.repoAgents.ownerId, actor.user.id));
    return must(row).count;
  }
  async function seedAgents(actor: Actor, count: number) {
    await getDb()
      .insert(schema.repoAgents)
      .values(
        Array.from({ length: count }, (_, i) => ({
          ownerId: actor.user.id,
          name: `Seed ${i}`,
          slug: `seed-${i}`,
        })),
      );
  }

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: must(process.env['DATABASE_URL']), max: 1 });
    await admin.query(`CREATE DATABASE ${scratch}`);
    const url = new URL(must(process.env['DATABASE_URL']));
    url.pathname = `/${scratch}`;
    target = url.toString();
    setEnvForTesting(
      loadEnv({
        ...process.env,
        DATABASE_URL: target,
        SESSION_SECRET: 'local-only-owner-limits-test-secret',
      }),
    );
    await runMigrations();
  }, 30_000);
  beforeEach(async () => {
    owner = await person();
  });
  afterAll(async () => {
    await closeDb();
    setEnvForTesting(null);
    await admin.query(`DROP DATABASE ${scratch} WITH (FORCE)`);
    await admin.end();
  });

  it('refuses the 101st agent, however it arrives', async () => {
    await seedAgents(owner, AGENT_REPO.agentsPerOwner);
    await expect(createRepoAgent(owner, { name: 'Too many' })).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    });
    const donor = await person();
    const offered = await createRepoAgent(donor, { name: 'Cannot bypass ceiling' });
    await offerTransfer(donor, offered.id, owner.user.email);
    await expect(acceptTransfer(owner, offered.id)).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    });
    expect(await agentCount(owner)).toBe(AGENT_REPO.agentsPerOwner);
  });

  it('lets exactly one of several concurrent creates and imports win at 99', async () => {
    await seedAgents(owner, AGENT_REPO.agentsPerOwner - 1);
    const imported = importAgentSchema.parse({ name: 'Imported', prompt: 'Imported' });
    const results = await Promise.allSettled([
      createRepoAgent(owner, { name: 'Created A' }),
      createRepoAgent(owner, { name: 'Created B' }),
      importAgent(owner, imported),
      importAgent(owner, { ...imported, name: 'Imported B' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const result of results)
      if (result.status === 'rejected')
        expect(result.reason).toMatchObject({ status: 409, code: 'conflict' });
    expect(await agentCount(owner)).toBe(AGENT_REPO.agentsPerOwner);
  });

  it('makes agent creation wait on the owner lock, under the key older pods use', async () => {
    const holder = new pg.Client({ connectionString: target });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `quota-owner:${owner.user.id}`,
    ]);
    let created = false;
    const create = createRepoAgent(owner, { name: 'Waits for the lock' }).then(() => {
      created = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(created).toBe(false);
    await holder.query('COMMIT');
    await holder.end();
    await create;
    expect(await agentCount(owner)).toBe(1);
  });

  it('puts no ceiling on radars', async () => {
    await ensureDropBox(owner);
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => createRadar(owner, { name: `Radar ${i}` })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(12);
  });

  it('bootstraps exactly one complete welcome workspace under concurrent first sign-ins', async () => {
    await Promise.all(Array.from({ length: 8 }, () => ensureDefaultWorkspace(owner.user)));
    const radars = await getDb()
      .select()
      .from(schema.radars)
      .where(eq(schema.radars.ownerId, owner.user.id));
    const welcome = must(radars.filter((r) => !r.isDropBox)[0]);
    expect(radars).toHaveLength(2);
    expect(welcome.name).toBe(WELCOME_RADAR.name);
    const blips = await getDb()
      .select()
      .from(schema.blips)
      .where(eq(schema.blips.radarId, welcome.id));
    expect(blips).toHaveLength(1);
    const dashboards = await getDb()
      .select()
      .from(schema.dashboards)
      .where(eq(schema.dashboards.ownerId, owner.user.id));
    expect(dashboards).toHaveLength(1);
    const widgets = await getDb()
      .select()
      .from(schema.dashboardWidgets)
      .where(eq(schema.dashboardWidgets.dashboardId, must(dashboards[0]).id));
    expect(widgets).toHaveLength(3);
    const inbox = must(widgets.find((widget) => widget.config['title'] === 'Inbox'));
    expect((await dashboardWidgetResults(owner, must(dashboards[0]).id, inbox.id)).total).toBe(1);
  });

  it('rolls back the entire welcome workspace if a later dashboard write fails', async () => {
    await getDb().execute(
      sql`CREATE FUNCTION omr_limits_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture dashboard failure'; END $$`,
    );
    await getDb().execute(
      sql`CREATE TRIGGER omr_limits_fixture_failure BEFORE INSERT ON dashboards FOR EACH ROW EXECUTE FUNCTION omr_limits_fixture_failure()`,
    );
    try {
      await expect(ensureDefaultWorkspace(owner.user)).rejects.toThrow();
      expect(
        await getDb().select().from(schema.blips).where(eq(schema.blips.authorId, owner.user.id)),
      ).toHaveLength(0);
      const radars = await getDb()
        .select()
        .from(schema.radars)
        .where(eq(schema.radars.ownerId, owner.user.id));
      expect(radars.filter((r) => !r.isDropBox)).toHaveLength(0);
    } finally {
      await getDb().execute(sql`DROP TRIGGER omr_limits_fixture_failure ON dashboards`);
      await getDb().execute(sql`DROP FUNCTION omr_limits_fixture_failure()`);
    }
    await ensureDefaultWorkspace(owner.user);
    expect(
      await getDb()
        .select()
        .from(schema.dashboards)
        .where(eq(schema.dashboards.ownerId, owner.user.id)),
    ).toHaveLength(1);
  });
});
