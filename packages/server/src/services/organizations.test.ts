/**
 * Organizations (migration 0089), on real PostgreSQL: the invariants the triggers hold for
 * every writer, old release or new, and the read model an organization's admins get.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import { must } from '../errors.js';
import { assertAccountExportSchema } from './account-export-collector.js';
import { ACCOUNT_EXPORT_TABLES } from './account-export-tables.js';
import { homeOrganization, organizationMembers } from './organizations.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

const email = (label: string) => `${label}-${randomUUID()}@example.test`;
const makeUser = async (label: string): Promise<Actor> => {
  const [user] = await getDb()
    .insert(schema.users)
    .values({ email: email(label), name: `Name ${label}`, state: 'active' })
    .returning();
  return { user: must(user), kind: 'user' };
};
const homeOf = async (userId: string) => must(await homeOrganization(userId), 'a home org').id;
const exec = async (text: ReturnType<typeof sql>) => (await getDb().execute(text)).rows;

describe.skipIf(!hasDatabase)('organizations (real postgres)', () => {
  beforeAll(async () => {
    await runMigrations();
  }, 60_000);
  afterAll(async () => {
    await closeDb();
  });

  it('gives a new user a personal home org they own, at commit, with no part of them in its name', async () => {
    const a = await makeUser('home');
    const home = must(await homeOrganization(a.user.id));
    expect(home).toMatchObject({ kind: 'personal', name: 'Personal' });
    expect(home.slug).not.toContain(a.user.email.split('@')[0]);
    const [membership] = await getDb()
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, a.user.id));
    expect(membership).toMatchObject({ role: 'owner', isHome: true, deactivatedAt: null });
  });

  it('sign-up that creates a user and a container in one transaction lands the container in the home org', async () => {
    // The trigger that runs at commit is too late for the radar inserted before it: the
    // container trigger has to create the home org itself.
    const id = randomUUID();
    await getDb().transaction(async (tx) => {
      await tx.insert(schema.users).values({ id, email: email('signup'), state: 'active' });
      await tx.insert(schema.radars).values({ ownerId: id, slug: 'inbox', name: 'Inbox' });
    });
    const [radar] = await getDb().select().from(schema.radars).where(eq(schema.radars.ownerId, id));
    expect(radar?.organizationId).toBe(await homeOf(id));
    const orgs = await exec(
      sql`SELECT count(*)::int AS n FROM memberships WHERE user_id = ${id}::uuid`,
    );
    expect(orgs[0]).toEqual({ n: 1 });
  });

  it('does not add a personal org when the transaction gave the user a home of its own', async () => {
    const id = randomUUID();
    const orgId = randomUUID();
    await getDb().transaction(async (tx) => {
      await tx.insert(schema.users).values({ id, email: email('own-home'), state: 'active' });
      await tx
        .insert(schema.organizations)
        .values({ id: orgId, kind: 'team', name: 'Team', slug: `team-${orgId}` });
      await tx
        .insert(schema.memberships)
        .values({ orgId, userId: id, role: 'member', isHome: true });
    });
    expect(await homeOf(id)).toBe(orgId);
    const rows = await exec(
      sql`SELECT count(*)::int AS n FROM memberships WHERE user_id = ${id}::uuid`,
    );
    expect(rows[0]).toEqual({ n: 1 });
  });

  it('creates exactly one home org when many transactions ask for it at once', async () => {
    const id = randomUUID();
    // The app's pool is too small to overlap these; a pool of our own makes them concurrent.
    const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'], max: 4 });
    try {
      await getDb()
        .insert(schema.users)
        .values({ id, email: email('race'), state: 'active' });
      // Take away the home that commit gave them, so every caller finds none and must make it.
      await exec(sql`DELETE FROM memberships WHERE user_id = ${id}::uuid`);
      await exec(sql`DELETE FROM organizations WHERE slug = ${'personal-' + id}`);
      // Each caller holds its transaction open long enough for the others to arrive.
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await client.query('SELECT omr_ensure_home_org($1)', [id]);
            await client.query('SELECT pg_sleep(0.3)');
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw err;
          } finally {
            client.release();
          }
        }),
      );
    } finally {
      await pool.end();
    }
    const rows = await exec(
      sql`SELECT count(*)::int AS n FROM memberships WHERE user_id = ${id}::uuid AND is_home`,
    );
    expect(rows[0]).toEqual({ n: 1 });
    const orgs = await exec(
      sql`SELECT count(*)::int AS n FROM organizations WHERE slug = ${'personal-' + id}`,
    );
    expect(orgs[0]).toEqual({ n: 1 });
  });

  it('files a container written without an organization (the previous release) under its owner’s home org, on all six tables', async () => {
    const a = await makeUser('legacy-writer');
    const id = a.user.id;
    const home = await homeOf(id);
    // Exactly the column lists the previous release uses: no organization_id anywhere.
    await exec(sql`INSERT INTO radars (owner_id, slug, name) VALUES (${id}::uuid, 'r', 'R')`);
    await exec(sql`INSERT INTO topics (owner_id, slug, name) VALUES (${id}::uuid, 't', 'T')`);
    await exec(sql`INSERT INTO dashboards (owner_id, name) VALUES (${id}::uuid, 'D')`);
    await exec(sql`INSERT INTO agents (owner_id, slug, name) VALUES (${id}::uuid, 'a', 'A')`);
    await exec(
      sql`INSERT INTO api_tokens (user_id, name, prefix, token_hash) VALUES (${id}::uuid, 'p', ${randomUUID()}, ${randomUUID()})`,
    );
    await exec(sql`INSERT INTO oauth_tokens (access_token_hash, client_id, user_id, expires_at)
                    VALUES (${randomUUID()}, 'c', ${id}::uuid, now() + interval '1 day')`);
    for (const [table, owner] of [
      ['radars', 'owner_id'],
      ['topics', 'owner_id'],
      ['dashboards', 'owner_id'],
      ['agents', 'owner_id'],
      ['api_tokens', 'user_id'],
      ['oauth_tokens', 'user_id'],
    ] as const) {
      const rows = await exec(
        sql.raw(`SELECT organization_id FROM ${table} WHERE ${owner} = '${id}'`),
      );
      expect(rows, table).toEqual([{ organization_id: home }]);
    }
  });

  it('refuses a container filed under an organization its owner is not in, on insert and on update', async () => {
    const a = await makeUser('filer');
    const b = await makeUser('stranger');
    const bHome = await homeOf(b.user.id);
    await expect(
      getDb()
        .insert(schema.radars)
        .values({ ownerId: a.user.id, slug: 'x', name: 'X', organizationId: bHome }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    const [radar] = await getDb()
      .insert(schema.radars)
      .values({ ownerId: a.user.id, slug: 'y', name: 'Y' })
      .returning();
    await expect(
      getDb()
        .update(schema.radars)
        .set({ organizationId: bHome })
        .where(eq(schema.radars.id, must(radar).id)),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(
      exec(
        sql`UPDATE api_tokens SET organization_id = ${bHome}::uuid WHERE user_id = ${a.user.id}::uuid`,
      ),
    ).resolves.toBeDefined();
  });

  it('moves an agent handed to somebody outside its organization to the new owner’s home org', async () => {
    const from = await makeUser('giver');
    const to = await makeUser('taker');
    const [agent] = await getDb()
      .insert(schema.agents)
      .values({ ownerId: from.user.id, slug: 'bot', name: 'Bot' })
      .returning();
    expect(must(agent).organizationId).toBe(await homeOf(from.user.id));
    await getDb()
      .update(schema.agents)
      .set({ ownerId: to.user.id })
      .where(eq(schema.agents.id, must(agent).id));
    const [after] = await getDb()
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, must(agent).id));
    expect(after?.organizationId).toBe(await homeOf(to.user.id));
  });

  it('keeps an agent in its organization when the new owner is a member of it', async () => {
    const from = await makeUser('team-giver');
    const to = await makeUser('team-taker');
    const orgId = randomUUID();
    await getDb()
      .insert(schema.organizations)
      .values({ id: orgId, kind: 'team', name: 'T', slug: `t-${orgId}` });
    await getDb()
      .insert(schema.memberships)
      .values([
        { orgId, userId: from.user.id, role: 'member' },
        { orgId, userId: to.user.id, role: 'member' },
      ]);
    const [agent] = await getDb()
      .insert(schema.agents)
      .values({ ownerId: from.user.id, slug: 'teambot', name: 'Teambot', organizationId: orgId })
      .returning();
    await getDb()
      .update(schema.agents)
      .set({ ownerId: to.user.id })
      .where(eq(schema.agents.id, must(agent).id));
    const [after] = await getDb()
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, must(agent).id));
    expect(after?.organizationId).toBe(orgId);
  });

  it('allows one install org and no more', async () => {
    await getDb()
      .insert(schema.organizations)
      .values({ kind: 'install', name: 'Install', slug: `install-${randomUUID()}` });
    await expect(
      getDb()
        .insert(schema.organizations)
        .values({ kind: 'install', name: 'Two', slug: `install-${randomUUID()}` }),
    ).rejects.toMatchObject({ cause: { constraint: 'organizations_one_install' } });
    await getDb().delete(schema.organizations).where(eq(schema.organizations.kind, 'install'));
  });
});

describe.skipIf(!hasDatabase)('what an organization’s admins can read (real postgres)', () => {
  let owner: Actor;
  let member: Actor;
  let outsider: Actor;
  let orgId: string;
  const SECRET_RADAR = `confidential-roadmap-${randomUUID()}`;

  beforeAll(async () => {
    await runMigrations();
    owner = await makeUser('org-owner');
    member = await makeUser('org-member');
    outsider = await makeUser('outsider');
    orgId = randomUUID();
    await getDb()
      .insert(schema.organizations)
      .values({ id: orgId, kind: 'team', name: 'Acme', slug: `acme-${orgId}` });
    await getDb()
      .insert(schema.memberships)
      .values([
        { orgId, userId: owner.user.id, role: 'owner' },
        { orgId, userId: member.user.id, role: 'member' },
      ]);
    const [radar] = await getDb()
      .insert(schema.radars)
      .values({
        ownerId: member.user.id,
        slug: 'secret',
        name: SECRET_RADAR,
        organizationId: orgId,
      })
      .returning();
    await getDb()
      .insert(schema.blips)
      .values({
        radarId: must(radar).id,
        authorId: member.user.id,
        title: 'private title',
        body: 'private body text',
      });
  });
  afterAll(async () => {
    await closeDb();
  });

  it('shows an owner the names, roles and counts, and none of the content', async () => {
    const result = await organizationMembers(owner, orgId);
    expect(result.counts).toEqual({
      total: 2,
      active: 2,
      deactivated: 0,
      owner: 1,
      admin: 0,
      member: 1,
      guest: 0,
    });
    expect(result.members.map((m) => m.name).sort()).toEqual(['Name org-member', 'Name org-owner']);
    const text = JSON.stringify(result);
    for (const content of [SECRET_RADAR, 'private title', 'private body text'])
      expect(text).not.toContain(content);
  });

  it('answers 404 to a plain member, an outsider, an agent, nobody and a deactivated admin, alike', async () => {
    const missing = await organizationMembers(owner, randomUUID()).catch((e: unknown) => e);
    expect(missing).toMatchObject({ status: 404 });
    const agent: Actor = { ...owner, kind: 'agent', ceiling: 'owner', tokenId: 'test' };
    for (const actor of [member, outsider, agent, null]) {
      const err = await organizationMembers(actor, orgId).catch((e: unknown) => e);
      expect(err, String(actor?.kind)).toMatchObject({
        status: 404,
        message: (missing as Error).message,
      });
    }
    await exec(
      sql`UPDATE memberships SET deactivated_at = now() WHERE org_id = ${orgId}::uuid AND user_id = ${owner.user.id}::uuid`,
    );
    await expect(organizationMembers(owner, orgId)).rejects.toMatchObject({ status: 404 });
  });
});

describe('the account export classifies organizations, failing closed', () => {
  it('knows both new tables and every organization_id column', () => {
    const tables = new Map(ACCOUNT_EXPORT_TABLES.map((p) => [p.table, p]));
    expect(tables.get('memberships')?.where).toBe('r.user_id = $1');
    expect(tables.get('organizations')?.where).toContain('memberships WHERE user_id = $1');
    for (const t of ['agents', 'api_tokens', 'topics', 'radars', 'dashboards', 'oauth_tokens'])
      expect(tables.get(t)?.include, t).toContain('organization_id');
    expect(tables.get('audit_log')?.exclude).toContain('organization_id');
    expect(tables.get('audit_log')?.include).toEqual([]);
  });

  it('refuses an unclassified column on the new tables and a missing classification', () => {
    const classified = ACCOUNT_EXPORT_TABLES.flatMap((p) =>
      [...p.include, ...p.exclude].map((column) => ({ table: p.table, column })),
    );
    expect(() => assertAccountExportSchema(classified)).not.toThrow();
    for (const table of ['memberships', 'organizations'])
      expect(() =>
        assertAccountExportSchema([...classified, { table, column: 'new_private' }]),
      ).toThrow();
    expect(() =>
      assertAccountExportSchema(
        classified.filter((c) => !(c.table === 'memberships' && c.column === 'role')),
      ),
    ).toThrow();
  });
});
