/**
 * Migration 0089 over a populated database: the shape of production when it is applied,
 * including the awkward member, an account that has been closed, whose rows
 * `account_closure_writer` (0057) refuses every write to.
 *
 * What is proved here: nothing is lost or duplicated, every user ends with exactly one home
 * organization and every container with its owner's, the closed account does not fail the
 * migration (and is still closed afterwards), and the SQL can run twice.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { must } from '../errors.js';
import { migrationFiles } from './migrate.js';

const databaseUrl = process.env['DATABASE_URL'];
const DIR = join(import.meta.dirname, '../../drizzle');
const SCRATCH = `omr_m0089_${process.pid}_${Date.now().toString(36)}`;

const CONTAINERS = [
  { table: 'radars', owner: 'owner_id' },
  { table: 'topics', owner: 'owner_id' },
  { table: 'dashboards', owner: 'owner_id' },
  { table: 'agents', owner: 'owner_id' },
  { table: 'api_tokens', owner: 'user_id' },
  { table: 'oauth_tokens', owner: 'user_id' },
] as const;

describe.skipIf(!databaseUrl)('migration 0089', () => {
  let admin: pg.Pool | undefined;
  let db: pg.Pool | undefined;
  const q = (text: string, values?: unknown[]) =>
    (db as pg.Pool).query<Record<string, string | number | boolean | null>>(text, values);
  const one = async (text: string, values?: unknown[]) => must((await q(text, values)).rows[0]);
  const n = async (text: string, values?: unknown[]) => Number((await one(text, values))['n']);

  let alice = '';
  let bob = '';
  let closed = '';
  const before: Record<string, number> = {};
  const COUNTED = [...CONTAINERS.map((c) => c.table), 'users', 'blips', 'audit_log'];

  const user = async (email: string) =>
    String(
      (await one(`INSERT INTO users (email, state) VALUES ($1, 'active') RETURNING id`, [email]))[
        'id'
      ],
    );
  const seed = async (owner: string, tag: string) => {
    const radar = String(
      (
        await one(`INSERT INTO radars (owner_id, slug, name) VALUES ($1, $2, $2) RETURNING id`, [
          owner,
          `r-${tag}`,
        ])
      )['id'],
    );
    await q(
      `INSERT INTO blips (radar_id, author_id, title, body) VALUES ($1, $2, 'a', 'secret body')`,
      [radar, owner],
    );
    await q(`INSERT INTO topics (owner_id, slug, name) VALUES ($1, $2, $2)`, [owner, `t-${tag}`]);
    await q(`INSERT INTO dashboards (owner_id, name) VALUES ($1, $2)`, [owner, `d-${tag}`]);
    await q(`INSERT INTO agents (owner_id, slug, name) VALUES ($1, $2, $2)`, [owner, `a-${tag}`]);
    await q(
      `INSERT INTO api_tokens (user_id, name, prefix, token_hash) VALUES ($1, 'pat', $2, $2)`,
      [owner, `p-${tag}`],
    );
    await q(
      `INSERT INTO oauth_tokens (access_token_hash, client_id, user_id, expires_at)
       VALUES ($1, 'client', $2, now() + interval '1 day')`,
      [`o-${tag}`, owner],
    );
    await q(`INSERT INTO audit_log (actor_id, action) VALUES ($1, 'seed')`, [owner]);
  };

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE DATABASE ${SCRATCH}`);
    const target = new URL(databaseUrl as string);
    target.pathname = `/${SCRATCH}`;
    db = new pg.Pool({ connectionString: target.toString(), max: 2 });
    db.on('error', () => undefined);
    for (const file of migrationFiles(await readdir(DIR)).filter((f) => f < '0089'))
      await q(await readFile(join(DIR, file), 'utf8'));

    alice = await user('alice@example.test');
    bob = await user('bob@example.test');
    closed = await user('closed@example.test');
    for (const [id, tag] of [
      [alice, 'alice'],
      [bob, 'bob'],
      [closed, 'closed'],
    ] as const)
      await seed(id, tag);
    // A user with nothing at all still gets a home.
    await user('empty@example.test');
    await q(
      `INSERT INTO account_closure_requests (id, user_id, confirmed_session_id, billing_snapshot)
       VALUES (gen_random_uuid(), $1, gen_random_uuid(), '{}'::jsonb)`,
      [closed],
    );
    for (const table of COUNTED) before[table] = await n(`SELECT count(*)::int AS n FROM ${table}`);
    await q(await readFile(join(DIR, '0089_organizations.sql'), 'utf8'));
  }, 120_000);

  afterAll(async () => {
    await db?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`).catch(() => undefined);
    await admin?.end();
  }, 60_000);

  it('keeps every row: nothing is lost or duplicated, and blips are not rewritten', async () => {
    for (const table of COUNTED)
      expect(await n(`SELECT count(*)::int AS n FROM ${table}`), table).toBe(before[table]);
    // The blips table has no organization column: it inherits its radar's by join.
    expect(
      await n(`SELECT count(*)::int AS n FROM information_schema.columns
                     WHERE table_name = 'blips' AND column_name = 'organization_id'`),
    ).toBe(0);
  });

  it('gives every user exactly one home organization, which they own and nobody else is in', async () => {
    const users = await n(`SELECT count(*)::int AS n FROM users`);
    expect(await n(`SELECT count(*)::int AS n FROM organizations`)).toBe(users);
    expect(await n(`SELECT count(*)::int AS n FROM memberships`)).toBe(users);
    expect(
      await n(
        `SELECT count(*)::int AS n FROM memberships WHERE is_home AND role = 'owner' AND deactivated_at IS NULL`,
      ),
    ).toBe(users);
    expect(await n(`SELECT count(DISTINCT user_id)::int AS n FROM memberships WHERE is_home`)).toBe(
      users,
    );
    expect(await n(`SELECT count(*)::int AS n FROM organizations WHERE kind <> 'personal'`)).toBe(
      0,
    );
    // A personal org's name and slug carry no part of the person.
    expect(
      await n(
        `SELECT count(*)::int AS n FROM organizations o WHERE o.name ~* 'alice|bob|closed|empty' OR o.slug ~* 'alice|bob|closed|empty'`,
      ),
    ).toBe(0);
  });

  it.each(CONTAINERS)(
    'files every $table row under its owner’s home organization',
    async ({ table, owner }) => {
      expect(await n(`SELECT count(*)::int AS n FROM ${table} WHERE organization_id IS NULL`)).toBe(
        0,
      );
      expect(
        await n(
          `SELECT count(*)::int AS n FROM ${table} t
          JOIN memberships m ON m.user_id = t.${owner} AND m.is_home
         WHERE t.organization_id <> m.org_id`,
        ),
      ).toBe(0);
      expect(
        (
          await one(
            `SELECT is_nullable FROM information_schema.columns
                        WHERE table_name = $1 AND column_name = 'organization_id'`,
            [table],
          )
        )['is_nullable'],
      ).toBe('NO');
    },
  );

  it('adds a nullable column to the audit log and does not backfill it', async () => {
    expect(
      await n(`SELECT count(*)::int AS n FROM audit_log WHERE organization_id IS NOT NULL`),
    ).toBe(0);
    expect(
      (
        await one(`SELECT is_nullable FROM information_schema.columns
                        WHERE table_name = 'audit_log' AND column_name = 'organization_id'`)
      )['is_nullable'],
    ).toBe('YES');
  });

  it('migrated the closed account without opening it: the guard is back on and still refuses its writes', async () => {
    for (const { table } of CONTAINERS) {
      expect(
        (
          await one(
            `SELECT tgenabled FROM pg_trigger WHERE tgrelid = $1::regclass AND tgname = 'account_closure_writer'`,
            [table],
          )
        )['tgenabled'],
        table,
      ).toBe('O');
    }
    await expect(
      q(`UPDATE radars SET name = 'x' WHERE owner_id = $1`, [closed]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      q(`INSERT INTO radars (owner_id, slug, name) VALUES ($1, 'new', 'new')`, [closed]),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('is re-runnable: the whole file a second time changes nothing', async () => {
    const snapshot = async () => ({
      orgs: await n(`SELECT count(*)::int AS n FROM organizations`),
      members: await n(`SELECT count(*)::int AS n FROM memberships`),
      homes: String(
        (await one(`SELECT string_agg(org_id::text, ',' ORDER BY user_id) AS s FROM memberships`))[
          's'
        ],
      ),
    });
    const first = await snapshot();
    await q(await readFile(join(DIR, '0089_organizations.sql'), 'utf8'));
    expect(await snapshot()).toEqual(first);
    for (const { table } of CONTAINERS)
      expect(
        await n(`SELECT count(*)::int AS n FROM ${table} WHERE organization_id IS NULL`),
        table,
      ).toBe(0);
  });
});
