/**
 * What the charter link and version suites share: an isolated database, people, an Architecture
 * radar with a written charter, and the reads that look straight at the tables. Test code only.
 */
import pg from 'pg';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll } from 'vitest';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import { must } from '../errors.js';
import type { Actor } from '../http.js';
import { readArchitecture, upsertBoundary, writeCharter } from './architecture.js';
import { createRadar } from './radars.js';

/** A charter with a repeated sentence (for ambiguity), a table cell, and three sections. */
export const CHARTER = [
  '# Charter',
  '',
  '## Billing',
  '',
  'Stripe is the billing source of truth. Commander never stores card data.',
  '',
  '## Hosting',
  '',
  'Commander owns the hosting plan.',
  '',
  '| Component | Rule |',
  '| --- | --- |',
  '| Web | Runs on blue-kube |',
  '',
  '## Appendix',
  '',
  'Stripe is the billing source of truth.',
  '',
].join('\n');

type VersionRow = typeof schema.charterVersions.$inferSelect;
type AnchorRow = typeof schema.charterAnchors.$inferSelect;

export interface CharterKit {
  owner: Actor;
  admin: pg.Pool | undefined;
  scratch: pg.Pool | undefined;
  databaseUrl: string;
  q: <T extends pg.QueryResultRow = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ) => Promise<pg.QueryResult<T>>;
  db: () => ReturnType<typeof getDb>;
  user: (label: string) => Promise<Actor>;
  radar: (body?: string, owner?: Actor) => Promise<string>;
  write: (
    radarId: string,
    edit: (text: string) => string,
    actor?: Actor,
    options?: { checkpoint?: boolean; note?: string },
  ) => ReturnType<typeof writeCharter>;
  boundary: (
    radarId: string,
    title: string,
    actor?: Actor,
  ) => Promise<{ id: string; title: string }>;
  versionsOf: (radarId: string) => Promise<VersionRow[]>;
  anchorsOf: (radarId: string) => Promise<AnchorRow[]>;
}

export function charterDatabase(prefix: string): CharterKit {
  const database = `${prefix}_${process.pid}_${Date.now().toString(36)}`;
  const kit: CharterKit = {
    owner: undefined as unknown as Actor,
    admin: undefined,
    scratch: undefined,
    databaseUrl: '',
    q: (text, values) => must(kit.scratch).query(text, values),
    db: () => getDb(),
    user: async (label) => {
      const [row] = await getDb()
        .insert(schema.users)
        .values({ email: `${label}@${prefix}.test`, state: 'active', name: label })
        .returning();
      return { user: must(row), kind: 'user', sessionId: crypto.randomUUID() };
    },
    /** An Architecture radar owned by `owner`, its charter written. */
    radar: async (body = CHARTER, owner = kit.owner) => {
      const radar = await createRadar(owner, {
        name: `Arch ${Math.random()}`,
        template: 'architecture',
      });
      if (body.length > 0) await kit.write(radar.id, () => body, owner);
      return radar.id;
    },
    /** Read the head, give `edit` the text, save what it returns. */
    write: async (radarId, edit, actor = kit.owner, options = {}) => {
      const read = await readArchitecture(actor, radarId, { view: 'written' });
      return writeCharter(actor, radarId, {
        markdown: edit(read.charter[0]?.markdown ?? ''),
        baseRevision: must(read.revision),
        ...(options.checkpoint === undefined ? {} : { checkpoint: options.checkpoint }),
        ...(options.note ? { note: options.note } : {}),
      });
    },
    boundary: async (radarId, title, actor = kit.owner) =>
      (await upsertBoundary(actor, radarId, { title })).boundary,
    versionsOf: (radarId) =>
      getDb()
        .select()
        .from(schema.charterVersions)
        .where(eq(schema.charterVersions.radarId, radarId))
        .orderBy(schema.charterVersions.version),
    anchorsOf: (radarId) =>
      getDb()
        .select()
        .from(schema.charterAnchors)
        .where(eq(schema.charterAnchors.radarId, radarId))
        .orderBy(schema.charterAnchors.createdAt, schema.charterAnchors.id),
  };

  beforeAll(async () => {
    const connection = must(process.env['DATABASE_URL']);
    kit.admin = new pg.Pool({ connectionString: connection, max: 2 });
    await kit.admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(connection);
    url.pathname = `/${database}`;
    kit.databaseUrl = url.toString();
    kit.scratch = new pg.Pool({ connectionString: kit.databaseUrl, max: 2 });
    setEnvForTesting(
      loadEnv({
        ...process.env,
        DATABASE_URL: kit.databaseUrl,
        SESSION_SECRET: `${prefix}-test-secret-not-used-anywhere`,
        PUBLIC_URL: 'http://localhost:3500',
      }),
    );
    await runMigrations();
    kit.owner = await kit.user('owner');
  }, 60_000);

  afterAll(async () => {
    await kit.scratch?.end();
    await closeDb();
    setEnvForTesting(null);
    if (kit.admin) {
      await kit.admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await kit.admin.end();
    }
  });

  return kit;
}
