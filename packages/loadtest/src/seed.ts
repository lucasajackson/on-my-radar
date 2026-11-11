/* eslint-disable no-console -- a command-line runner: its printed verdict is the product */
/**
 * Seeds a freshly migrated database with direct SQL: 50 users, 150 personal
 * access tokens, 20 shared radars with 50 members each, 50k blips (one 10k
 * board) and 20k comments. Uses only tables that exist on origin/main, so the
 * same seed runs before and after the fixes.
 *
 *   LOADTEST_PG_URL=postgres://postgres@localhost:55442/postgres pnpm --filter @onmyradar/loadtest seed
 *
 * Writes `fixtures.json` (plaintext tokens and ids for k6) into the output
 * directory; that file belongs to a throwaway database and is never committed.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  BLIPS,
  BOARD_BLIPS,
  BOARD_RADAR_INDEX,
  COMMENTS,
  databaseUrls,
  HOT_RADAR_INDEX,
  RADARS,
  SAMPLE_PER_RADAR,
  SESSION_SECRET,
  TOKENS_PER_USER,
  USERS,
} from './config.js';

export interface Fixtures {
  tokens: string[];
  sessions: string[];
  radars: Array<{ id: string; name: string; board: boolean; blips: string[] }>;
  hotRadarId: string;
  boardRadarId: string;
}

const hashSecret = (value: string) =>
  createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
const randomToken = () => randomBytes(32).toString('base64url');

export async function seed(appUrl: string, outDir: string): Promise<Fixtures> {
  const client = new pg.Client({ connectionString: appUrl });
  await client.connect();
  try {
    await client.query('BEGIN');

    const users = (
      await client.query<{ id: string }>(
        `INSERT INTO users (email, name, state)
         SELECT 'lt-user-' || lpad(g::text, 2, '0') || '@loadtest.invalid', 'LT User ' || g, 'active'
           FROM generate_series(1, $1::int) g
         RETURNING id`,
        [USERS],
      )
    ).rows.map((r) => r.id);

    // Three PATs per user.
    const tokens: string[] = [];
    const tokenUsers: string[] = [];
    for (const userId of users)
      for (let i = 0; i < TOKENS_PER_USER; i++) {
        tokens.push(`omr_pat_${randomToken()}`);
        tokenUsers.push(userId);
      }
    await client.query(
      `INSERT INTO api_tokens (user_id, name, prefix, token_hash)
       SELECT u, 'loadtest agent ' || n, p, h
         FROM unnest($1::uuid[], $2::int[], $3::text[], $4::text[]) AS t(u, n, p, h)`,
      [
        tokenUsers,
        tokens.map((_, i) => i),
        tokens.map((t) => t.slice(0, 14)),
        tokens.map(hashSecret),
      ],
    );

    // One browser session per user, for the UI pollers.
    const sessions = users.map(() => `omr_s_${randomToken()}`);
    await client.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at, client)
       SELECT u, h, now() + interval '7 days', 'web'
         FROM unnest($1::uuid[], $2::text[]) AS t(u, h)`,
      [users, sessions.map(hashSecret)],
    );

    // Radars: index 0 is the kanban board; owners round-robin over the users.
    const radarIds: string[] = [];
    for (let i = 0; i < RADARS; i++) {
      const owner = users[i % users.length];
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO radars (owner_id, slug, name, template)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [
          owner,
          `lt-radar-${String(i).padStart(2, '0')}`,
          i === BOARD_RADAR_INDEX
            ? 'LT Board (10k)'
            : i === HOT_RADAR_INDEX
              ? 'LT Hot radar'
              : `LT Radar ${i}`,
          i === BOARD_RADAR_INDEX ? 'kanban' : 'stream',
        ],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error('radar insert returned no row');
      radarIds.push(id);
    }

    // Every radar is shared with every user: the owner plus 49 editors.
    await client.query(
      `INSERT INTO radar_members (radar_id, user_id, role)
       SELECT r.id, u.id, 'editor'
         FROM radars r JOIN users u ON u.id <> r.owner_id
        WHERE r.id = ANY($1::uuid[])`,
      [radarIds],
    );

    // Blips: the board gets 10k, the other 19 radars share the rest.
    const rest = BLIPS - BOARD_BLIPS;
    const perRadar = Math.floor(rest / (RADARS - 1));
    for (let i = 0; i < RADARS; i++) {
      const count =
        i === BOARD_RADAR_INDEX
          ? BOARD_BLIPS
          : perRadar + (i === HOT_RADAR_INDEX ? rest - perRadar * (RADARS - 1) : 0);
      const board = i === BOARD_RADAR_INDEX;
      await client.query(
        `INSERT INTO blips (radar_id, author_id, kind, state, status, title, body, tags, pinned, created_at, updated_at)
         SELECT $1::uuid, ($2::uuid[])[1 + (g % $3::int)], 'note',
                CASE WHEN $4::boolean THEN (ARRAY['inbox','later','active','active','done'])[1 + (g % 5)]
                     ELSE (ARRAY['inbox','inbox','inbox','inbox','active','active','later','done','done','dropped'])[1 + (g % 10)] END,
                CASE WHEN $4::boolean THEN (ARRAY['backlog','todo','doing','blocked','done'])[1 + (g % 5)] END,
                'LT blip ' || g,
                (SELECT string_agg('w' || ((g * 7 + k * 13 + k * k) % 400), ' ') FROM generate_series(1, 25) k),
                ARRAY['t' || (g % 30), 'u' || (g % 7)],
                g % 500 = 0,
                now() - g * interval '1 minute',
                now() - g * interval '1 minute'
           FROM generate_series(1, $5::int) g`,
        [radarIds[i], users, users.length, board, count],
      );
    }

    await client.query(
      `INSERT INTO blip_comments (blip_id, radar_id, author_id, body, created_at, updated_at)
       SELECT b.id, b.radar_id, ($2::uuid[])[1 + (row_number() OVER ())::int % $3::int],
              'LT comment ' || row_number() OVER (),
              now() - (row_number() OVER ()) * interval '10 seconds',
              now() - (row_number() OVER ()) * interval '10 seconds'
         FROM (SELECT id, radar_id FROM blips ORDER BY random() LIMIT $1::int) b`,
      [COMMENTS, users, users.length],
    );

    await client.query('COMMIT');
    await client.query('ANALYZE');

    const fixtures: Fixtures = {
      tokens,
      sessions,
      radars: [],
      hotRadarId: radarIds[HOT_RADAR_INDEX] ?? '',
      boardRadarId: radarIds[BOARD_RADAR_INDEX] ?? '',
    };
    for (const [i, id] of radarIds.entries()) {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM blips WHERE radar_id = $1 ORDER BY random() LIMIT $2`,
        [id, SAMPLE_PER_RADAR],
      );
      fixtures.radars.push({
        id,
        name: `lt-radar-${i}`,
        board: i === BOARD_RADAR_INDEX,
        blips: rows.map((r) => r.id),
      });
    }
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'fixtures.json'), JSON.stringify(fixtures), { mode: 0o600 });
    return fixtures;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${resolve(process.argv[1])}`;
if (invokedDirectly) {
  const adminUrl = process.env['LOADTEST_PG_URL'];
  if (!adminUrl) throw new Error('Set LOADTEST_PG_URL (postgres://…@localhost:<port>/postgres).');
  const out = resolve(
    process.env['LOADTEST_OUT'] ?? fileURLToPath(new URL('../.out/', import.meta.url)),
  );
  const { app } = databaseUrls(adminUrl);
  seed(app, out)
    .then((f) => {
      console.log(
        `seeded: ${f.tokens.length} tokens, ${f.radars.length} radars → ${out}/fixtures.json`,
      );
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
