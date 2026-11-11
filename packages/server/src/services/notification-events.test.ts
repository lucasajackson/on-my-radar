import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import { createBlip } from './blips.js';
import { createRadar } from './radars.js';
import { enqueueNotificationEvent, pushNotificationContext } from './notifications.js';
import { drainOne } from './outbox.js';
import { must } from '../errors.js';
import { createRepoAgent } from './repo-agents.js';
import { hashSecret, newApiToken, tokenPrefix } from '../auth/crypto.js';
import { resolveBearerToken } from '../auth/bearer.js';
import { notificationAllowed } from './notification-preferences.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

async function fixture() {
  const db = getDb();
  const users = await db
    .insert(schema.users)
    .values(
      ['owner', 'reader'].map((name) => ({
        name,
        email: `${name}-${randomUUID()}@example.test`,
        state: 'active' as const,
      })),
    )
    .returning();
  const actor: Actor = { user: must(users[0]), kind: 'user' };
  const reader = must(users[1]);
  const radar = await createRadar(actor, { name: `event-${randomUUID()}`, template: 'stream' });
  await db
    .insert(schema.radarMembers)
    .values({ radarId: radar.id, userId: reader.id, role: 'viewer' });
  await db
    .insert(schema.radarNotificationPrefs)
    .values({ radarId: radar.id, userId: reader.id, level: 'all' });
  await db
    .insert(schema.userNotificationSettings)
    .values({ userId: reader.id, emailEnabled: false, pushEnabled: false });
  const [blip] = await db
    .insert(schema.blips)
    .values({ radarId: radar.id, authorId: actor.user.id, body: 'durable event' })
    .returning();
  const enqueueEvent = () =>
    db.transaction((tx) =>
      enqueueNotificationEvent(tx, {
        type: 'blip',
        actor,
        radarId: radar.id,
        blipId: must(blip).id,
      }),
    );
  const notifications = () =>
    db.select().from(schema.notifications).where(eq(schema.notifications.radarId, radar.id));
  return { db, actor, reader, radar, blip: must(blip), enqueueEvent, notifications };
}

// A real Postgres trigger injects failures at the commit boundary instead of
// mocking the service's transaction implementation.
async function trigger(
  table: 'outbox' | 'notifications',
  timing: 'INSERT' | 'DELETE',
  condition: string,
) {
  const name = `review_event_${randomUUID().replaceAll('-', '')}`;
  await getDb().execute(
    sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF ${condition} THEN RAISE EXCEPTION 'review injected failure'; END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END $$`),
  );
  await getDb().execute(
    sql.raw(
      `CREATE TRIGGER ${name} BEFORE ${timing} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    ),
  );
  return async () => {
    await getDb().execute(sql.raw(`DROP TRIGGER ${name} ON ${table}`));
    await getDb().execute(sql.raw(`DROP FUNCTION ${name}()`));
  };
}

async function retry(id: string) {
  await getDb()
    .update(schema.outbox)
    .set({ runAfter: new Date(0) })
    .where(eq(schema.outbox.id, id));
  await drainOne(id);
}

async function agentReplyFixture() {
  const f = await fixture();
  const human: Actor = { user: f.reader, kind: 'user' };
  const agent = await createRepoAgent(human, { name: `Reply ${randomUUID()}` });
  const secret = newApiToken();
  await f.db.insert(schema.apiTokens).values({
    userId: human.user.id,
    name: 'reply fixture',
    prefix: tokenPrefix(secret),
    tokenHash: hashSecret(secret),
    agentId: agent.id,
    voiceGrants: ['persona', 'principal'],
    defaultVoice: 'principal',
  });
  const bearer = must(await resolveBearerToken(secret));
  const actor: Actor = { ...bearer, kind: 'agent' };
  const enqueueReply = async (voice: 'persona' | 'principal' = 'persona') => {
    const [comment] = await f.db
      .insert(schema.blipComments)
      .values({
        radarId: f.radar.id,
        blipId: f.blip.id,
        authorId: human.user.id,
        agentId: agent.id,
        agentVoice: voice,
        body: `stored ${voice} reply`,
      })
      .returning();
    return f.db.transaction((tx) =>
      enqueueNotificationEvent(tx, {
        type: 'comment',
        actor,
        radarId: f.radar.id,
        blipId: f.blip.id,
        commentId: must(comment).id,
        body: must(comment).body,
        mentioned: [],
      }),
    );
  };
  const ownNotifications = async () =>
    (await f.notifications()).filter((row) => row.userId === human.user.id);
  return { ...f, human, enqueueReply, ownNotifications };
}

describe.skipIf(!hasDatabase)('durable notification source events', () => {
  beforeAll(async () => {
    await runMigrations();
  }, 30_000);
  afterAll(closeDb);

  it('uses the persisted agent voice, not the token default, for cosigner replies', async () => {
    const f = await agentReplyFixture();
    await drainOne(await f.enqueueReply());
    expect(await f.ownNotifications()).toMatchObject([
      { kind: 'comment', count: 1, excerpt: 'stored persona reply' },
    ]);
    await drainOne(await f.enqueueReply('principal'));
    expect(await f.ownNotifications()).toMatchObject([{ count: 1 }]);
  });

  it('recovers agent reply fanout and coalesces distinct replies without replay duplication', async () => {
    const f = await agentReplyFixture();
    const id = await f.enqueueReply();
    const failInsert = await trigger(
      'notifications',
      'INSERT',
      `NEW.radar_id = '${f.radar.id}'::uuid`,
    );
    try {
      await drainOne(id);
    } finally {
      await failInsert();
    }
    expect(await f.ownNotifications()).toHaveLength(0);
    const failDelete = await trigger('outbox', 'DELETE', `OLD.id = '${id}'::uuid`);
    try {
      await retry(id);
    } finally {
      await failDelete();
    }
    expect(await f.ownNotifications()).toMatchObject([{ count: 1, attributedEventCount: 1 }]);
    await retry(id);
    expect(await f.ownNotifications()).toMatchObject([{ count: 1, attributedEventCount: 1 }]);
    await drainOne(await f.enqueueReply());
    expect(await f.ownNotifications()).toMatchObject([{ count: 2, attributedEventCount: 2 }]);
  });

  it('honors radar mute, revoked membership and inactive cosigners at fanout time', async () => {
    for (const change of ['mute', 'revoke', 'suspend'] as const) {
      const f = await agentReplyFixture();
      const id = await f.enqueueReply();
      if (change === 'mute')
        await f.db
          .update(schema.radarNotificationPrefs)
          .set({ level: 'none' })
          .where(eq(schema.radarNotificationPrefs.userId, f.human.user.id));
      if (change === 'revoke')
        await f.db
          .delete(schema.radarMembers)
          .where(eq(schema.radarMembers.userId, f.human.user.id));
      if (change === 'suspend')
        await f.db
          .update(schema.users)
          .set({ state: 'suspended' })
          .where(eq(schema.users.id, f.human.user.id));
      await drainOne(id);
      expect(await f.ownNotifications()).toHaveLength(0);
    }
  });

  it('rechecks channel preferences and access for a queued agent-reply delivery', async () => {
    const f = await agentReplyFixture();
    await drainOne(await f.enqueueReply());
    const row = must((await f.ownNotifications())[0]);
    expect(await pushNotificationContext(row.id)).toBeNull();
    await f.db
      .update(schema.userNotificationSettings)
      .set({
        emailEnabled: true,
        pushEnabled: true,
        kindPreferences: { comment: { email: false, push: false } },
      })
      .where(eq(schema.userNotificationSettings.userId, f.human.user.id));
    expect(
      await notificationAllowed(f.human.user.id, 'comment', f.radar.id, 'email'),
    ).toMatchObject({ allowed: false });
    expect(await pushNotificationContext(row.id)).toBeNull();
    await f.db
      .update(schema.userNotificationSettings)
      .set({ kindPreferences: {} })
      .where(eq(schema.userNotificationSettings.userId, f.human.user.id));
    expect(await pushNotificationContext(row.id)).not.toBeNull();
    await f.db
      .update(schema.radarNotificationPrefs)
      .set({ level: 'none' })
      .where(eq(schema.radarNotificationPrefs.userId, f.human.user.id));
    expect(await pushNotificationContext(row.id)).toBeNull();
    await f.db
      .update(schema.radarNotificationPrefs)
      .set({ level: 'all' })
      .where(eq(schema.radarNotificationPrefs.userId, f.human.user.id));
    await f.db.delete(schema.radarMembers).where(eq(schema.radarMembers.userId, f.human.user.id));
    expect(await pushNotificationContext(row.id)).toBeNull();
  });

  it('a committed event survives losing its immediate kick', async () => {
    const f = await fixture();
    const id = await f.enqueueEvent();
    expect(await f.notifications()).toHaveLength(0);
    await drainOne(id);
    expect(await f.notifications()).toMatchObject([{ count: 1, userId: f.reader.id }]);
    expect(await f.db.select().from(schema.outbox).where(eq(schema.outbox.id, id))).toHaveLength(0);
  });

  it('source rollback also rolls back its notification intent', async () => {
    const f = await fixture();
    const drop = await trigger(
      'outbox',
      'INSERT',
      `NEW.kind = 'notification-event' AND NEW.payload->>'radarId' = '${f.radar.id}'`,
    );
    try {
      await expect(
        createBlip(f.actor, f.radar.id, { body: 'must roll back' }),
      ).rejects.toMatchObject({
        cause: { message: 'review injected failure' },
      });
    } finally {
      await drop();
    }
    expect(
      await f.db
        .select()
        .from(schema.blips)
        .where(and(eq(schema.blips.radarId, f.radar.id), eq(schema.blips.body, 'must roll back'))),
    ).toHaveLength(0);
  });

  it('failed fanout stays queued, rolls back, and succeeds after recovery', async () => {
    const f = await fixture();
    const id = await f.enqueueEvent();
    const drop = await trigger('notifications', 'INSERT', `NEW.radar_id = '${f.radar.id}'::uuid`);
    try {
      await drainOne(id);
    } finally {
      await drop();
    }
    expect(await f.notifications()).toHaveLength(0);
    const [job] = await f.db.select().from(schema.outbox).where(eq(schema.outbox.id, id));
    expect(job?.attempts).toBe(1);
    expect(job?.payload['notificationEventDone']).not.toBe(true);
    await retry(id);
    expect(await f.notifications()).toMatchObject([{ count: 1 }]);
  });

  it('replaying after fanout commits cannot fold an event twice', async () => {
    const f = await fixture();
    const id = await f.enqueueEvent();
    const drop = await trigger('outbox', 'DELETE', `OLD.id = '${id}'::uuid`);
    try {
      await drainOne(id);
    } finally {
      await drop();
    }
    expect(await f.notifications()).toMatchObject([{ count: 1 }]);
    const [job] = await f.db.select().from(schema.outbox).where(eq(schema.outbox.id, id));
    expect(job?.payload['notificationEventDone']).toBe(true);
    await retry(id);
    expect(await f.notifications()).toMatchObject([{ count: 1 }]);
  });

  it('rechecks membership and moved sources before publishing an excerpt', async () => {
    const f = await fixture();
    const id = await f.enqueueEvent();
    await f.db.delete(schema.radarMembers).where(eq(schema.radarMembers.radarId, f.radar.id));
    await drainOne(id);
    expect(await f.notifications()).toHaveLength(0);
    await f.db
      .insert(schema.radarMembers)
      .values({ radarId: f.radar.id, userId: f.reader.id, role: 'viewer' });
    const movedId = await f.enqueueEvent();
    const other = await createRadar(f.actor, { name: 'private destination', template: 'stream' });
    await f.db
      .update(schema.blips)
      .set({ radarId: other.id })
      .where(eq(schema.blips.id, f.blip.id));
    await drainOne(movedId);
    expect(await f.notifications()).toHaveLength(0);
  });
});
