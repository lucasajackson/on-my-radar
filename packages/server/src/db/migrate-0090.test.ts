/**
 * Migration 0090 over a populated database: a connection that loaded an agent before this ran
 * must carry that agent's limit from the moment its owner sets one, so the table that records
 * it is filled from the load sessions that already exist.
 *
 * What is proved here: pat and oauth sessions become one fence each (however many times they
 * loaded), a browser session becomes none, a closed account (whose writes
 * `account_closure_writer` refuses) does not fail the migration, and the SQL can run twice.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { must } from '../errors.js';
import { migrationFiles } from './migrate.js';

const databaseUrl = process.env['DATABASE_URL'];
const DIR = join(import.meta.dirname, '../../drizzle');
const SCRATCH = `omr_m0090_${process.pid}_${Date.now().toString(36)}`;

describe.skipIf(!databaseUrl)('migration 0090', () => {
  let admin: pg.Pool | undefined;
  let db: pg.Pool | undefined;
  const q = (text: string, values?: unknown[]) =>
    (db as pg.Pool).query<Record<string, string | number | boolean | null>>(text, values);
  const id = async (text: string, values: unknown[]) =>
    String(must((await q(text, values)).rows[0])['id']);
  let alice = '';
  let closed = '';
  let agent = '';

  const session = (user: string, owner: string, kind: string, connection: string) =>
    q(
      `INSERT INTO agent_sessions (agent_id, user_id, connection_kind, connection_id, prompt_version)
       VALUES ($1, $2, $3, $4, 1)`,
      [owner, user, kind, connection],
    );

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE DATABASE ${SCRATCH}`);
    const target = new URL(databaseUrl as string);
    target.pathname = `/${SCRATCH}`;
    db = new pg.Pool({ connectionString: target.toString(), max: 2 });
    db.on('error', () => undefined);
    for (const file of migrationFiles(await readdir(DIR)).filter((f) => f < '0090'))
      await q(await readFile(join(DIR, file), 'utf8'));

    alice = await id(
      `INSERT INTO users (email, state) VALUES ('alice@m0090.test', 'active') RETURNING id`,
      [],
    );
    closed = await id(
      `INSERT INTO users (email, state) VALUES ('closed@m0090.test', 'active') RETURNING id`,
      [],
    );
    agent = await id(
      `INSERT INTO agents (owner_id, slug, name) VALUES ($1, 'a', 'A') RETURNING id`,
      [alice],
    );
    // Alice's PAT loaded it twice, one connected app loaded it, and a browser session did too.
    await session(alice, agent, 'pat', 'token-1');
    await session(alice, agent, 'pat', 'token-1');
    await session(alice, agent, 'oauth', 'client-1');
    await session(alice, agent, 'session', 'browser-1');
    // A closed account's connection, written before it closed.
    await session(closed, agent, 'oauth', 'client-closed');
    await q(
      `INSERT INTO account_closure_requests (id, user_id, confirmed_session_id, billing_snapshot)
       VALUES (gen_random_uuid(), $1, gen_random_uuid(), '{}'::jsonb)`,
      [closed],
    );
    await q(await readFile(join(DIR, '0090_agent_radar_grants.sql'), 'utf8'));
  }, 120_000);

  afterAll(async () => {
    await db?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`).catch(() => undefined);
    await admin?.end();
  }, 60_000);

  const fences = async () =>
    (
      await q(
        `SELECT connection_kind, connection_id, agent_id::text AS agent
           FROM connection_agent_fences ORDER BY connection_kind, connection_id`,
      )
    ).rows;

  it('records each pat and connected app that already loaded an agent, once', async () => {
    expect(await fences()).toEqual([
      { connection_kind: 'oauth', connection_id: 'client-1', agent },
      { connection_kind: 'oauth', connection_id: 'client-closed', agent },
      { connection_kind: 'pat', connection_id: 'token-1', agent },
    ]);
  });

  it('can run twice without duplicating anything or failing on the closed account', async () => {
    await q(await readFile(join(DIR, '0090_agent_radar_grants.sql'), 'utf8'));
    expect(await fences()).toHaveLength(3);
    expect(
      Number(
        must((await q(`SELECT count(*)::int AS n FROM users WHERE id = $1`, [closed])).rows[0])[
          'n'
        ],
      ),
    ).toBe(1);
  });
});
