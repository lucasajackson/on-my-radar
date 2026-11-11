/**
 * "People shared on a single radar see its topic name? No, unless the topic is
 * shared." — the owner, 2026-09-26.
 *
 * A radar's topic is shown only to somebody who can read the topic: its owner
 * or a member, cascading or not. A collaborator the radar alone was shared with
 * sees no topic id and no topic name, on the sidebar list, the single radar,
 * and over the wire. Every radar surface — REST, MCP, the public page — builds
 * from the same DTO, so it is asserted there and at one transport.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createSession, SESSION_COOKIE } from '../auth/session.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import { requireRadar } from './access.js';
import { createRadar, getRadarDto, listRadars, shareRadar } from './radars.js';
import { createTopic, setRadarTopic, shareTopic } from './topics.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

async function makeUser(label: string): Promise<Actor> {
  const [user] = await getDb()
    .insert(schema.users)
    .values({
      email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      state: 'active',
    })
    .returning();
  if (!user) throw new Error('user insert returned no row');
  return { user, kind: 'user' };
}

describe.skipIf(!hasDatabase)('who is shown a radar’s topic (real postgres)', () => {
  let owner: Actor;
  let radarOnly: Actor;
  let topicMember: Actor;
  let radarId: string;
  let topicId: string;
  const topicName = `Acquisition plans ${Math.random()}`;

  beforeAll(async () => {
    await runMigrations();
    owner = await makeUser('tv-owner');
    radarOnly = await makeUser('tv-radar-only');
    topicMember = await makeUser('tv-topic-member');
    const topic = await createTopic(owner, { name: topicName });
    topicId = topic.id;
    radarId = (await createRadar(owner, { name: 'Filed radar' })).id;
    await setRadarTopic(owner, radarId, topicId);
    await shareRadar(owner, radarId, radarOnly.user.email, 'editor');
    // A member of a topic that does not cascade: grouped, granted nothing by it,
    // and given the radar directly.
    await shareTopic(owner, topicId, topicMember.user.email, 'viewer');
    await shareRadar(owner, radarId, topicMember.user.email, 'viewer');
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  const shown = async (actor: Actor) => {
    const listed = (await listRadars(actor)).find((radar) => radar.id === radarId);
    const single = await getRadarDto(await requireRadar(radarId, actor, 'read'), actor);
    return { listed, single };
  };

  it('shows the topic to its owner and to its members', async () => {
    for (const actor of [owner, topicMember]) {
      const { listed, single } = await shown(actor);
      expect(listed?.topic?.name).toBe(topicName);
      expect(single.topic?.name).toBe(topicName);
      expect(single.topicId).toBe(topicId);
    }
  });

  it('shows no topic to somebody the radar alone was shared with', async () => {
    const { listed, single } = await shown(radarOnly);
    // Positive control: they really do read this radar.
    expect(listed).toBeDefined();
    for (const dto of [listed, single]) {
      expect(dto?.topic).toBeNull();
      expect(dto?.topicId).toBeNull();
    }
  });

  it('does not say it over the wire either', async () => {
    const cookie = `${SESSION_COOKIE}=${(await createSession(radarOnly.user)).token}`;
    const app = createApp();
    for (const path of ['/api/radars', `/api/radars/${radarId}`]) {
      const res = await app.request(path, { headers: { cookie } });
      expect(res.status, path).toBe(200);
      const body = await res.text();
      expect(body, path).toContain(radarId);
      expect(body, path).not.toContain(topicName);
      expect(body, path).not.toContain(topicId);
    }
  });
});
