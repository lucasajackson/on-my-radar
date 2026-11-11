import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { NOTIFICATIONS } from '@onmyradar/contract';
import { createApp } from '../app.js';
import { createSession, SESSION_COOKIE } from '../auth/session.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { must } from '../errors.js';
import type { Actor } from '../http.js';
import { hashSecret, newApiToken, tokenPrefix } from '../auth/crypto.js';
import { resolveBearerToken } from '../auth/bearer.js';
import { createRepoAgent, deleteRepoAgent, setArchived } from './repo-agents.js';
import { createRadar } from './radars.js';
import { createBlip } from './blips.js';
import { createComment } from './comments.js';
import { listNotifications, pushNotificationContext } from './notifications.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'synthetic-notification-attribution-secret';

async function fixture() {
  const db = getDb();
  const [user] = await db
    .insert(schema.users)
    .values({
      email: `attribution-${randomUUID()}@example.test`,
      name: 'Lucas',
      state: 'active',
    })
    .returning();
  const human: Actor = { user: must(user), kind: 'user' };
  await db
    .insert(schema.userNotificationSettings)
    .values({ userId: human.user.id, emailEnabled: false, pushEnabled: false });
  const radar = await createRadar(human, { name: 'Attribution' });
  const blip = await createBlip(human, radar.id, { body: 'a thought' });
  const actor = await agentFor(human, 'Lulu');
  const notification = async () =>
    must((await listNotifications(human)).items.find((n) => n.kind === 'comment'));
  const stored = async () =>
    must(
      (
        await db
          .select()
          .from(schema.notifications)
          .where(eq(schema.notifications.userId, human.user.id))
      )[0],
    );
  // The exact old writer's conflict fields: it knows neither attribution column.
  const oldWrite = async () =>
    db.execute(sql`
    INSERT INTO notifications (user_id, kind, radar_id, blip_id, group_key, count, actor_ids, subject, excerpt)
    VALUES (${human.user.id}::uuid, 'comment', ${radar.id}::uuid, ${blip.id}::uuid,
      ${`comment:${blip.id}`}, 1, ARRAY[${human.user.id}::uuid], 'a thought', 'older writer')
    ON CONFLICT (user_id, group_key) WHERE read_at IS NULL DO UPDATE SET
      count = notifications.count + 1,
      actor_ids = (ARRAY[${human.user.id}::uuid] || array_remove(notifications.actor_ids, ${human.user.id}::uuid))[1:8],
      subject = COALESCE(EXCLUDED.subject, notifications.subject), excerpt = EXCLUDED.excerpt,
      blip_id = EXCLUDED.blip_id, seen_at = NULL, updated_at = now()
  `);
  return { db, human, radar, blip, actor, notification, stored, oldWrite };
}

async function agentFor(
  human: Actor,
  name: string,
  defaultVoice: 'persona' | 'principal' = 'persona',
) {
  const db = getDb();
  const agent = await createRepoAgent(human, { name });
  const secret = newApiToken();
  await db.insert(schema.apiTokens).values({
    userId: human.user.id,
    name: 'synthetic',
    prefix: tokenPrefix(secret),
    tokenHash: hashSecret(secret),
    agentId: agent.id,
    voiceGrants: ['persona', 'principal'],
    defaultVoice,
  });
  const bearer = must(await resolveBearerToken(secret));
  const actor: Actor = { ...bearer, kind: 'agent' };
  return actor;
}

describe.skipIf(!hasDatabase)('notification principal attribution', () => {
  beforeAll(async () => {
    await runMigrations();
  }, 30_000);
  afterAll(closeDb);

  it('names the actual agent in the shared notification sentence', async () => {
    const f = await fixture();
    await createComment(f.actor, f.blip.id, { body: 'I picked this up' });
    const item = must((await listNotifications(f.human)).items[0]);
    expect(item.title).toContain('Lulu (agent)');
    expect(item.title).not.toContain('Lucas');
    expect(item.principals).toEqual([
      { kind: 'agent', id: f.actor.agent?.agentId, displayName: 'Lulu' },
    ]);
    expect(item.hasUnattributedEvents).toBe(false);
    expect(Object.keys(must(item.principals?.[0])).sort()).toEqual(['displayName', 'id', 'kind']);
    const session = await createSession(f.human.user);
    const response = await createApp().request('/api/notifications', {
      headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [{ title: item.title, principals: item.principals }],
    });
  });

  it('keeps counters exact when old and new writers race on the same open group', async () => {
    const f = await fixture();
    await Promise.all([
      createComment(f.actor, f.blip.id, { body: 'new1' }),
      createComment(f.actor, f.blip.id, { body: 'new2' }),
      ...Array.from({ length: 5 }, () => f.oldWrite()),
    ]);
    expect(await f.stored()).toMatchObject({
      count: 7,
      attributedEventCount: 2,
      actorKeys: [`agent:${must(f.actor.agent?.agentId)}`],
    });
    expect((await f.notification()).hasUnattributedEvents).toBe(true);
  });

  it('uses the committed persona voice even when the credential defaults to the human voice', async () => {
    const f = await fixture();
    const actor = await agentFor(f.human, 'Mia', 'principal');
    await createComment(actor, f.blip.id, { body: 'Speaking as the agent', as: 'agent' });
    expect(await f.notification()).toMatchObject({
      principals: [{ kind: 'agent', id: actor.agent?.agentId, displayName: 'Mia' }],
      hasUnattributedEvents: false,
    });
    expect((await f.notification()).title).toContain('Mia (agent)');
    expect((await f.notification()).title).not.toContain('Lucas');
  });

  it('uses the same committed agent identity for comment mentions', async () => {
    const f = await fixture();
    const [user] = await f.db
      .insert(schema.users)
      .values({ email: `mention-${randomUUID()}@example.test`, name: 'Taylor', state: 'active' })
      .returning();
    const other: Actor = { user: must(user), kind: 'user' };
    await f.db
      .insert(schema.userNotificationSettings)
      .values({ userId: other.user.id, emailEnabled: false, pushEnabled: false });
    await f.db
      .insert(schema.radarMembers)
      .values({ radarId: f.radar.id, userId: other.user.id, role: 'viewer' });
    await createComment(f.actor, f.blip.id, {
      body: `I picked this up @${must(other.user.email.split('@')[0])}`,
    });
    const item = must((await listNotifications(other)).items.find((n) => n.kind === 'mention'));
    expect(item.title).toContain('Lulu (agent)');
    expect(item.principals).toEqual([
      { kind: 'agent', id: f.actor.agent?.agentId, displayName: 'Lulu' },
    ]);
  });

  it('detects old inserts and alternating old/new folds without attributing history', async () => {
    const f = await fixture();
    await f.oldWrite();
    expect(await f.stored()).toMatchObject({ count: 1, attributedEventCount: 0, actorKeys: [] });
    expect(await f.notification()).toMatchObject({ principals: [], hasUnattributedEvents: true });
    expect((await f.notification()).title).not.toContain('Lucas');
    await createComment(f.actor, f.blip.id, { body: 'new1' });
    await f.oldWrite();
    await createComment(f.actor, f.blip.id, { body: 'new2' });
    expect(await f.stored()).toMatchObject({
      count: 4,
      attributedEventCount: 2,
      actorKeys: [`agent:${must(f.actor.agent?.agentId)}`],
    });
    expect(await f.notification()).toMatchObject({ count: 4, hasUnattributedEvents: true });
    expect((await f.notification()).title).toContain('unattributed earlier activity');
    expect((await f.notification()).title).not.toMatch(/Lulu.*left 4 comments/);
  });

  it('detects an old fold into a new row even with repeated same-principal events', async () => {
    const f = await fixture();
    await createComment(f.actor, f.blip.id, { body: 'new1' });
    await createComment(f.actor, f.blip.id, { body: 'new2' });
    expect(await f.stored()).toMatchObject({ count: 2, attributedEventCount: 2 });
    expect((await f.notification()).hasUnattributedEvents).toBe(false);
    await f.oldWrite();
    expect(await f.stored()).toMatchObject({ count: 3, attributedEventCount: 2 });
    await createComment(f.actor, f.blip.id, { body: 'new3' });
    expect(await f.stored()).toMatchObject({ count: 4, attributedEventCount: 3 });
    expect((await f.notification()).hasUnattributedEvents).toBe(true);
    expect((await f.notification()).principals).toHaveLength(1);
  });

  it('keeps same-cosigner agents and principal voice separate, with visible agent labels', async () => {
    const f = await fixture();
    const [user] = await f.db
      .insert(schema.users)
      .values({ email: `other-${randomUUID()}@example.test`, name: 'Lulu', state: 'active' })
      .returning();
    const other: Actor = { user: must(user), kind: 'user' };
    await f.db
      .insert(schema.userNotificationSettings)
      .values({ userId: other.user.id, emailEnabled: false, pushEnabled: false });
    await f.db
      .insert(schema.radarMembers)
      .values({ radarId: f.radar.id, userId: other.user.id, role: 'editor' });
    const first = await agentFor(other, 'Lulu');
    const second = await agentFor(other, 'Mia');
    await createComment(first, f.blip.id, { body: 'persona1' });
    await createComment(second, f.blip.id, { body: 'persona2' });
    expect((await f.notification()).title).toContain('Mia (agent) and Lulu (agent)');
    await createComment(first, f.blip.id, { body: 'personal voice', as: 'me' });
    const item = await f.notification();
    expect(item.principals).toEqual([
      { kind: 'human', id: other.user.id, displayName: 'Lulu' },
      { kind: 'agent', id: second.agent?.agentId, displayName: 'Mia' },
      { kind: 'agent', id: first.agent?.agentId, displayName: 'Lulu' },
    ]);
    expect(item.count).toBe(3);
    expect(item.actors).toHaveLength(1);
    // Bring the equal-named agent to the front; repeated identity moves, not duplicates.
    await createComment(first, f.blip.id, { body: 'persona again' });
    expect((await f.notification()).title).toContain('Lulu (agent)');
    expect((await f.notification()).principals).toHaveLength(3);
  });

  it('caps principals, not event counts, and never guesses a participant total', async () => {
    const f = await fixture();
    for (let i = 0; i < NOTIFICATIONS.maxActors + 2; i++) {
      const actor = await agentFor(f.human, `Actor ${i}`);
      await createComment(actor, f.blip.id, { body: `reply${i}` });
    }
    const item = await f.notification();
    expect(item.count).toBe(NOTIFICATIONS.maxActors + 2);
    expect(item.principals).toHaveLength(NOTIFICATIONS.maxActors);
    expect(item.title).not.toMatch(/\d+ others/);
    expect(await f.stored()).toMatchObject({ count: 10, attributedEventCount: 10 });
  });

  it('resolves archived names live and never reconstructs deleted agent names', async () => {
    const f = await fixture();
    await createComment(f.actor, f.blip.id, { body: 'reply' });
    const id = must(f.actor.agent?.agentId);
    await setArchived(f.human, id, true);
    expect((await f.notification()).title).toContain('Lulu (agent)');
    await deleteRepoAgent(f.human, id);
    const item = await f.notification();
    expect(item.title).toContain('Former agent (agent)');
    expect(item.title).not.toContain('Lulu');
    expect(item.principals).toEqual([{ kind: 'agent', id, displayName: 'Former agent' }]);
    // Queue payload is still the same server sentence after a principal disappears.
    await f.db
      .update(schema.userNotificationSettings)
      .set({ pushEnabled: true })
      .where(eq(schema.userNotificationSettings.userId, f.human.user.id));
    expect((await pushNotificationContext(item.id))?.payload.title).toBe(item.title);
  });

  it('database rejects ambiguous principal arrays and impossible event counters', async () => {
    const f = await fixture();
    await createComment(f.actor, f.blip.id, { body: 'reply' });
    const row = await f.stored();
    for (const actorKeys of [
      ['All tools'],
      [`agent:${randomUUID()}`, `agent:${randomUUID()}`].map(() => `human:${f.human.user.id}`),
      Array(9).fill(`human:${f.human.user.id}`),
    ]) {
      await expect(
        f.db
          .update(schema.notifications)
          .set({ actorKeys })
          .where(eq(schema.notifications.id, row.id)),
      ).rejects.toThrow();
    }
    await expect(
      f.db
        .update(schema.notifications)
        .set({ attributedEventCount: 2 })
        .where(eq(schema.notifications.id, row.id)),
    ).rejects.toThrow();
    await expect(
      f.db
        .update(schema.notifications)
        .set({ attributedEventCount: -1 })
        .where(eq(schema.notifications.id, row.id)),
    ).rejects.toThrow();
  });
});
