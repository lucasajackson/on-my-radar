/** A source mutation and the intent to notify about it must commit together. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, or, sql } from 'drizzle-orm';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import type * as OutboxModule from './outbox.js';

// Simulate a process losing every inline kick. Durable intent must still exist.
vi.mock('./outbox.js', async (original) => ({
  ...(await original<typeof OutboxModule>()),
  drainOne: async () => undefined,
}));

const { findOrCreateUser, findUserByEmail, activateUser } = await import('../auth/accounts.js');
const { createBlip, updateBlip } = await import('./blips.js');
const { createComment, updateComment } = await import('./comments.js');
const { createRadar, shareRadar } = await import('./radars.js');
const { setReaction } = await import('./reactions.js');
const { createTopic, shareTopic, setCascade } = await import('./topics.js');

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

async function person(name: string): Promise<Actor> {
  const [user] = await getDb()
    .insert(schema.users)
    .values({
      email: `${name.toLowerCase()}-${randomUUID()}@example.test`,
      name,
      state: 'active',
    })
    .returning();
  if (!user) throw new Error('user insert returned no row');
  return { kind: 'user', user };
}

async function fixture() {
  const owner = await person('Author');
  const target = await person('Target');
  const newcomer = await person('Newcomer');
  const radar = await createRadar(owner, { name: `Producer ${randomUUID()}` });
  const topic = await createTopic(owner, { name: `Producer ${randomUUID()}` });
  await getDb()
    .insert(schema.radarMembers)
    .values({ radarId: radar.id, userId: target.user.id, role: 'editor' });
  await getDb()
    .insert(schema.topicMembers)
    .values({ topicId: topic.id, userId: target.user.id, role: 'viewer' });
  const blip = await createBlip(owner, radar.id, { body: 'Original blip' });
  const comment = await createComment(owner, blip.id, { body: 'Original comment' });
  return { owner, target, newcomer, radar, topic, blip, comment };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function snapshot(f: Fixture) {
  const db = getDb();
  return Promise.all([
    db.select().from(schema.blips).where(eq(schema.blips.radarId, f.radar.id)),
    db.select().from(schema.blipComments).where(eq(schema.blipComments.radarId, f.radar.id)),
    db.select().from(schema.blipReactions).where(eq(schema.blipReactions.radarId, f.radar.id)),
    db.select().from(schema.mentions).where(eq(schema.mentions.radarId, f.radar.id)),
    db.select().from(schema.radarMembers).where(eq(schema.radarMembers.radarId, f.radar.id)),
    db.select().from(schema.topicMembers).where(eq(schema.topicMembers.topicId, f.topic.id)),
    db.select().from(schema.topics).where(eq(schema.topics.id, f.topic.id)),
    db
      .select()
      .from(schema.outbox)
      .where(sql`${schema.outbox.payload}->'actor'->'user'->>'id' = ${f.owner.user.id}`),
  ]);
}

// A trigger injects a real database failure precisely after the source write.
// Its predicate affects only this fixture; other suites can share the database.
async function refuseEvents(actorId: string, run: () => Promise<void>) {
  const suffix = randomUUID().replaceAll('-', '');
  const name = `review_event_${suffix}`;
  const db = getDb();
  await db.execute(
    sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.kind = 'notification-event' AND NEW.payload->'actor'->'user'->>'id' = '${actorId}' THEN
        RAISE EXCEPTION 'source event refused';
      END IF;
      RETURN NEW;
    END $$`),
  );
  await db.execute(
    sql.raw(
      `CREATE TRIGGER ${name} BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    ),
  );
  try {
    await run();
  } finally {
    await db.execute(sql.raw(`DROP TRIGGER ${name} ON outbox`));
    await db.execute(sql.raw(`DROP FUNCTION ${name}()`));
  }
}

describe.skipIf(!hasDatabase)('durable notification producers', () => {
  beforeAll(async () => {
    await runMigrations();
  }, 30_000);
  afterAll(closeDb);

  const mutations: [string, (f: Fixture) => Promise<unknown>][] = [
    ['blip capture', (f) => createBlip(f.owner, f.radar.id, { body: 'A new blip' })],
    ['blip mention edit', (f) => updateBlip(f.owner, f.blip.id, { body: 'Hi @target' })],
    ['comment capture', (f) => createComment(f.owner, f.blip.id, { body: 'A new comment' })],
    [
      'comment mention edit',
      (f) => updateComment({ ...f.owner, viaCookie: true }, f.comment.id, { body: 'Hi @target' }),
    ],
    ['reaction add', (f) => setReaction(f.owner, f.blip.id, 'up')],
    ['radar share', (f) => shareRadar(f.owner, f.radar.id, f.newcomer.user.email, 'viewer')],
    ['topic share', (f) => shareTopic(f.owner, f.topic.id, f.newcomer.user.email, 'viewer')],
    ['topic cascade', (f) => setCascade(f.owner, f.topic.id, true)],
  ];

  it.each(mutations)(
    '%s rolls back when durable fanout cannot be recorded',
    async (_label, mutate) => {
      const f = await fixture();
      const before = await snapshot(f);
      await refuseEvents(f.owner.user.id, async () => {
        await expect(mutate(f)).rejects.toMatchObject({
          cause: expect.objectContaining({ message: 'source event refused' }) as unknown,
        });
      });
      expect(await snapshot(f)).toEqual(before);
    },
  );

  it('commits signup and approval emails with the account state that caused them', async () => {
    const email = `account-mail-${randomUUID()}@example.test`;
    const name = `review_mail_${randomUUID().replaceAll('-', '')}`;
    const db = getDb();
    await db.execute(
      sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.kind = 'email' AND NEW.payload->>'to' = '${email}' THEN
          RAISE EXCEPTION 'account email refused';
        END IF;
        RETURN NEW;
      END $$`),
    );
    const enableFailure = () =>
      db.execute(
        sql.raw(
          `CREATE TRIGGER ${name} BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION ${name}()`,
        ),
      );
    const disableFailure = () => db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${name} ON outbox`));
    try {
      await enableFailure();
      await expect(findOrCreateUser(email)).rejects.toMatchObject({
        cause: expect.objectContaining({ message: 'account email refused' }) as unknown,
      });
      expect(await findUserByEmail(email)).toBeNull();
      await disableFailure();
      const { user } = await findOrCreateUser(email);
      expect(user.state).toBe('pending');
      await enableFailure();
      await expect(activateUser(null, user, 'admin')).rejects.toMatchObject({
        cause: expect.objectContaining({ message: 'account email refused' }) as unknown,
      });
      expect((await findUserByEmail(email))?.state).toBe('pending');
      await disableFailure();
      expect(await activateUser(null, user, 'admin')).toBe(true);
      const mail = await db
        .select()
        .from(schema.outbox)
        .where(
          and(eq(schema.outbox.kind, 'email'), sql`${schema.outbox.payload}->>'to' = ${email}`),
        );
      expect(mail).toHaveLength(2);
    } finally {
      await disableFailure();
      await db.execute(sql.raw(`DROP FUNCTION ${name}()`));
    }
  });

  it('retains source events and mention targets when every inline drain is lost', async () => {
    const f = await fixture();
    const created = await createComment(f.owner, f.blip.id, { body: 'Please review @target' });
    const jobs = await getDb()
      .select()
      .from(schema.outbox)
      .where(
        and(
          eq(schema.outbox.kind, 'notification-event'),
          sql`${schema.outbox.payload}->>'commentId' = ${created.id}`,
        ),
      );
    expect(jobs.map((j) => j.payload['type']).sort()).toEqual(['comment', 'mention']);
    const mention = jobs.find((j) => j.payload['type'] === 'mention');
    expect(mention?.payload['mentioned']).toEqual([
      expect.objectContaining({ userId: f.target.user.id }),
    ]);
    const rows = await getDb()
      .select()
      .from(schema.mentions)
      .where(eq(schema.mentions.commentId, created.id));
    expect(rows.map((row) => row.userId)).toEqual([f.target.user.id]);
  });

  it('persists invitation and share email jobs with their source writes', async () => {
    const f = await fixture();
    const invited = `invited-${randomUUID()}@example.test`;
    await shareRadar(f.owner, f.radar.id, invited, 'viewer');
    await shareTopic(f.owner, f.topic.id, invited, 'viewer');
    await shareRadar(f.owner, f.radar.id, f.newcomer.user.email, 'viewer');
    await shareTopic(f.owner, f.topic.id, f.newcomer.user.email, 'viewer');
    const jobs = await getDb()
      .select()
      .from(schema.outbox)
      .where(
        and(
          eq(schema.outbox.kind, 'email'),
          or(
            sql`${schema.outbox.payload}->>'to' = ${invited}`,
            sql`${schema.outbox.payload}->>'to' = ${f.newcomer.user.email}`,
          ),
        ),
      );
    expect(jobs).toHaveLength(4);
  });
});
