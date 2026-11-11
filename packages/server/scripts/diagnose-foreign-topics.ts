/**
 * Read-only diagnostic: radars that sit in a topic with a different owner.
 *
 *   DATABASE_URL=postgres://… \
 *     pnpm --filter @onmyradar/server exec tsx scripts/diagnose-foreign-topics.ts [--json]
 *
 * A topic's cascade grants its members access to every radar in it, and
 * `access.ts` assumes the topic's owner is the radar's owner. Before the
 * `setRadarTopic` owner check, a co-owner of a radar could file it into a topic
 * of their own, and keep a grant path to it after being removed. Each row here is
 * such a placement: the radar, who owns it, the topic, who owns that, whether it
 * cascades, and how many other people are in the topic (the people who would
 * hold access through it).
 *
 * **Writes nothing.** One SELECT, run inside a READ ONLY transaction. Fixing a
 * row is a person's decision: move the radar out with `set_radar_topic`
 * (topicId null), which is what removing a co-owner now does by itself.
 */
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { closeDb, getPool } from '../src/db/client.js';

export interface ForeignTopicPlacement {
  radarId: string;
  radarName: string;
  radarOwnerEmail: string;
  topicId: string;
  topicName: string;
  topicOwnerEmail: string;
  cascade: boolean;
  /** Members of the topic other than its owner. */
  topicMembers: number;
  /** Whether the topic's owner still has a membership row on the radar. */
  topicOwnerHoldsRadarGrant: boolean;
}

export async function findForeignTopicPlacements(pool: Pool): Promise<ForeignTopicPlacement[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const { rows } = await client.query<{
      radar_id: string;
      radar_name: string;
      radar_owner_email: string;
      topic_id: string;
      topic_name: string;
      topic_owner_email: string;
      cascade: boolean;
      topic_members: number;
      topic_owner_holds_grant: boolean;
    }>(
      `SELECT r.id AS radar_id, r.name AS radar_name, ro.email AS radar_owner_email,
              t.id AS topic_id, t.name AS topic_name, tou.email AS topic_owner_email, t.cascade,
              (SELECT count(*)::int FROM topic_members tm WHERE tm.topic_id = t.id) AS topic_members,
              EXISTS (SELECT 1 FROM radar_members rm
                       WHERE rm.radar_id = r.id AND rm.user_id = t.owner_id) AS topic_owner_holds_grant
         FROM radars r
         JOIN topics t ON t.id = r.topic_id
         JOIN users ro ON ro.id = r.owner_id
         JOIN users tou ON tou.id = t.owner_id
        WHERE t.owner_id <> r.owner_id
        ORDER BY t.cascade DESC, r.created_at, r.id`,
    );
    await client.query('ROLLBACK');
    return rows.map((r) => ({
      radarId: r.radar_id,
      radarName: r.radar_name,
      radarOwnerEmail: r.radar_owner_email,
      topicId: r.topic_id,
      topicName: r.topic_name,
      topicOwnerEmail: r.topic_owner_email,
      cascade: r.cascade,
      topicMembers: r.topic_members,
      topicOwnerHoldsRadarGrant: r.topic_owner_holds_grant,
    }));
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

export function formatPlacements(rows: readonly ForeignTopicPlacement[]): string {
  if (rows.length === 0) return 'No radar sits in a topic with a different owner.';
  const lines = [`${rows.length} radar(s) sit in a topic with a different owner:`, ''];
  for (const r of rows) {
    lines.push(
      `radar ${r.radarId} "${r.radarName}" (owner ${r.radarOwnerEmail})`,
      `  in topic ${r.topicId} "${r.topicName}" (owner ${r.topicOwnerEmail})`,
      `  cascade: ${r.cascade ? 'ON' : 'off'}; other topic members: ${r.topicMembers}; ` +
        `topic owner still holds a grant on the radar: ${r.topicOwnerHoldsRadarGrant ? 'yes' : 'no'}`,
      '',
    );
  }
  return lines.join('\n').trimEnd();
}

async function main(argv: readonly string[]): Promise<number> {
  if (!process.env['DATABASE_URL']) {
    console.error('DATABASE_URL is required.');
    return 2;
  }
  try {
    const rows = await findForeignTopicPlacements(getPool());
    console.log(argv.includes('--json') ? JSON.stringify(rows, null, 2) : formatPlacements(rows));
    return 0;
  } finally {
    await closeDb();
  }
}

/** Whether this module is the one Node was asked to run (compared as URLs). */
export function isEntry(moduleUrl: string, argv1: string | undefined): boolean {
  return argv1 !== undefined && moduleUrl === pathToFileURL(argv1).href;
}

if (isEntry(import.meta.url, process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  });
}
