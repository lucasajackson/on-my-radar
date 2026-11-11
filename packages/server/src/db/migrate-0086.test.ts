/**
 * Migration 0086 on the shape that broke its first draft: a Kanban radar with
 * its own custom lane called "contract" and two blips titled the same. The
 * uniqueness the migration adds is for boundary and contract blips only, so it
 * must neither fail on that data nor block more of it afterwards, and must
 * still hold for real elements.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { must } from '../errors.js';
import { migrationFiles } from './migrate.js';

const databaseUrl = process.env['DATABASE_URL'];
const DIR = join(import.meta.dirname, '../../drizzle');
const SCRATCH = `omr_m0086_${process.pid}_${Date.now().toString(36)}`;

describe.skipIf(!databaseUrl)('migration 0086', () => {
  let admin: pg.Pool | undefined;
  let db: pg.Pool | undefined;
  const sql = (text: string, values?: unknown[]) =>
    (db as pg.Pool).query<{ id: string; n: number }>(text, values);

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE DATABASE ${SCRATCH}`);
    const target = new URL(databaseUrl as string);
    target.pathname = `/${SCRATCH}`;
    db = new pg.Pool({ connectionString: target.toString(), max: 2 });
    db.on('error', () => undefined);
    const files = migrationFiles(await readdir(DIR));
    for (const file of files.filter((f) => f < '0086'))
      await sql(await readFile(join(DIR, file), 'utf8'));
  }, 120_000);

  afterAll(async () => {
    await db?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`).catch(() => undefined);
    await admin?.end();
  }, 60_000);

  const idOf = async (text: string, values?: unknown[]) =>
    must((await sql(text, values)).rows[0]).id;
  const radar = (template: string, owner: string, config = '{}') =>
    idOf(
      `INSERT INTO radars (owner_id, slug, name, template, template_config)
       VALUES ($1, $2, $2, $3, $4::jsonb) RETURNING id`,
      [owner, `r${Math.random().toString(36).slice(2)}`, template, config],
    );
  const blip = (radarId: string, owner: string, title: string, status: string) =>
    idOf(
      `INSERT INTO blips (radar_id, author_id, title, body, status) VALUES ($1, $2, $3, $3, $4) RETURNING id`,
      [radarId, owner, title, status],
    );

  it('applies over a Kanban radar with a custom "contract" lane and two blips of one title, and allows more', async () => {
    const owner = await idOf(
      `INSERT INTO users (email, name) VALUES ('m@example.test', 'M') RETURNING id`,
    );
    const kanban = await radar('kanban', owner, '{"lanes":[{"id":"contract","label":"Contract"}]}');
    await blip(kanban, owner, 'Renewal', 'contract');
    await blip(kanban, owner, 'Renewal', 'contract');

    await sql(await readFile(join(DIR, '0086_architecture_elements.sql'), 'utf8'));

    await blip(kanban, owner, 'Renewal', 'contract');
    await blip(kanban, owner, 'renewal', 'contract');
    const { rows } = await sql(`SELECT count(*)::int AS n FROM blips WHERE radar_id = $1`, [
      kanban,
    ]);
    expect(must(rows[0]).n).toBe(4);
  });

  it('still refuses two boundaries of one title (any case) on an architecture radar, and follows a rename', async () => {
    const owner = await idOf(`SELECT id FROM users LIMIT 1`);
    const arch = await radar('architecture', owner);
    const element = async (title: string) => {
      const id = await blip(arch, owner, title, 'boundary');
      await sql(`INSERT INTO blip_elements (blip_id) VALUES ($1)`, [id]);
      return id;
    };
    const first = await element('Billing');
    await expect(element('billing')).rejects.toMatchObject({
      constraint: 'blips_element_title_key',
    });
    await sql(`UPDATE blips SET title = 'Payments' WHERE id = $1`, [first]);
    await element('Billing');
    await expect(element('PAYMENTS')).rejects.toMatchObject({
      constraint: 'blips_element_title_key',
    });
  });
});
