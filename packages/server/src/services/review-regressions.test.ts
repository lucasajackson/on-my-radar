import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import type { Actor } from '../http.js';
import type * as StorageModule from './storage.js';
import type * as OutboxModule from './outbox.js';
import type * as MailModule from './mail.js';
import type * as PushModule from './push-delivery.js';
import { createApp } from '../app.js';
import { createSession } from '../auth/session.js';
import { must } from '../errors.js';

const controls = vi.hoisted(() => ({
  head: { contentType: 'image/png', size: 12 },
  mail: vi.fn(),
  push: vi.fn(),
  preview: vi.fn(),
}));
vi.mock('./storage.js', async (original) => ({
  ...(await original<typeof StorageModule>()),
  headObject: async () => controls.head,
  deleteObjects: async () => undefined,
}));
vi.mock('./outbox.js', async (original) => ({
  ...(await original<typeof OutboxModule>()),
  drainOne: async () => undefined,
}));
vi.mock('./mail.js', async (original) => ({
  ...(await original<typeof MailModule>()),
  sendMail: controls.mail,
}));
vi.mock('./push-delivery.js', async (original) => ({
  ...(await original<typeof PushModule>()),
  queuePushDeliveries: controls.push,
}));
vi.mock('./unfurl.js', () => ({ unfurl: controls.preview }));

const { createBlip, updateBlip, deleteBlip, radarStream } = await import('./blips.js');
const { createRadar, updateRadar, setVisibility, deleteRadar } = await import('./radars.js');
const { createDashboard, updateDashboard } = await import('./dashboards.js');
const { requireRadar } = await import('./access.js');
const { createComment } = await import('./comments.js');
const { enqueue, drainDue } = await import('./outbox.js');
const { recordAudit } = await import('./audit.js');
const { createToken, revokeToken, listTokens } = await import('./tokens.js');
const { listNotifications, notificationCounts, markRead, markSeen } =
  await import('./notifications.js');
const { createTopic, setRadarTopic, setCascade } = await import('./topics.js');

describe.skipIf(!process.env['DATABASE_URL'])('2026-09 review regressions', () => {
  let admin: pg.Pool;
  const database = `omr_review_regression_${Date.now()}`;
  let owner: Actor;
  let stranger: Actor;
  let scratchUrl: string;

  beforeAll(async () => {
    const connectionString = must(process.env['DATABASE_URL']);
    admin = new pg.Pool({ connectionString });
    await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(connectionString);
    url.pathname = `/${database}`;
    scratchUrl = url.toString();
    setEnvForTesting(
      loadEnv({
        ...process.env,
        DATABASE_URL: url.toString(),
        SESSION_SECRET: 'review-only-session-secret-not-used-anywhere-else',
        RESEND_API_KEY: 'test',
        VAPID_PUBLIC_KEY: 'test',
        VAPID_PRIVATE_KEY: 'test',
        PUBLIC_URL: 'http://localhost:3500',
      }),
    );
    await runMigrations();
    for (const which of ['owner', 'stranger']) {
      const [user] = await getDb()
        .insert(schema.users)
        .values({ email: `${which}@review.test`, state: 'active' })
        .returning();
      if (!user) throw new Error('Missing fixture');
      if (which === 'owner') owner = { user, kind: 'user' };
      else stranger = { user, kind: 'user' };
    }
  }, 30_000);

  beforeEach(async () => {
    await getDb().delete(schema.outbox);
    await getDb().delete(schema.notifications);
    controls.head = { contentType: 'image/png', size: 12 };
    controls.mail.mockReset().mockResolvedValue(undefined);
    controls.push
      .mockReset()
      .mockImplementation(async (row: typeof schema.notifications.$inferSelect) => {
        await getDb()
          .update(schema.notifications)
          .set({ pushedAt: new Date() })
          .where(eq(schema.notifications.id, row.id));
      });
    controls.preview.mockReset().mockResolvedValue({
      title: 'Old URL preview',
      description: null,
      siteName: null,
      imageUrl: null,
      fetchedAt: new Date().toISOString(),
    });
  });

  afterAll(async () => {
    await closeDb();
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end();
  });

  it('checks token management at the service boundary before reading or writing credentials', async () => {
    const token = await createToken(owner, { name: 'Human connection' });
    const delegate: Actor = { ...owner, kind: 'agent', ceiling: 'owner' };
    await expect(createToken(delegate, { name: 'Escalated' })).rejects.toThrow('while signed in');
    await expect(listTokens(delegate)).rejects.toThrow('while signed in');
    await expect(revokeToken(delegate, token.id)).rejects.toThrow('while signed in');
    expect((await listTokens(owner)).some((row) => row.id === token.id)).toBe(true);
    await revokeToken(owner, token.id);
    expect((await listTokens(owner)).some((row) => row.id === token.id)).toBe(false);
  });

  it('serialises widget-only saves on the dashboard row, even for an empty layout', async () => {
    const radar = await createRadar(owner, { name: randomUUID() });
    const dashboard = await createDashboard(owner, 'Concurrent layouts');
    const locker = new pg.Client({ connectionString: scratchUrl });
    await locker.connect();
    await locker.query('BEGIN');
    await locker.query('SELECT id FROM dashboards WHERE id = $1 FOR NO KEY UPDATE', [dashboard.id]);
    let completed = false;
    const save = updateDashboard(owner, dashboard.id, {
      expectedRevision: dashboard.revision,
      widgets: [{ radarId: radar.id, x: 0, y: 0, w: 6, h: 10 }],
    }).then((result) => {
      completed = true;
      return result;
    });
    try {
      await expect
        .poll(async () => {
          const result = await locker.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
          );
          return result.rows[0]?.n ?? 0;
        })
        .toBeGreaterThan(0);
      expect(completed).toBe(false);
      expect(
        await getDb()
          .select()
          .from(schema.dashboardWidgets)
          .where(eq(schema.dashboardWidgets.dashboardId, dashboard.id)),
      ).toHaveLength(0);
    } finally {
      await locker.query('COMMIT');
      await locker.end();
      await save;
    }
    expect((await save).widgets).toHaveLength(1);
  });

  it('hides stale radar/topic snapshots after access loss and cancels their delivery', async () => {
    const radar = await createRadar(owner, { name: randomUUID() });
    const topic = await createTopic(owner, { name: randomUUID() });
    await setRadarTopic(owner, radar.id, topic.id);
    await setCascade(owner, topic.id, true);
    await getDb()
      .insert(schema.topicMembers)
      .values({ topicId: topic.id, userId: stranger.user.id, role: 'viewer' });
    const notifications = await getDb()
      .insert(schema.notifications)
      .values([
        {
          userId: stranger.user.id,
          radarId: radar.id,
          kind: 'share' as const,
          groupKey: randomUUID(),
          actorIds: [owner.user.id],
          subject: 'Private radar',
          excerpt: 'Private thought',
        },
        {
          userId: stranger.user.id,
          topicId: topic.id,
          kind: 'topic_share' as const,
          groupKey: randomUUID(),
          actorIds: [owner.user.id],
          subject: 'Private topic',
          excerpt: 'Private topic snapshot',
        },
      ])
      .returning();
    expect((await listNotifications(stranger)).items).toHaveLength(2);
    expect((await notificationCounts(stranger)).total).toBe(2);
    // Retain snapshots deliberately: a queued fan-out can finish after cleanup.
    await getDb().delete(schema.topicMembers).where(eq(schema.topicMembers.topicId, topic.id));
    expect((await listNotifications(stranger)).items).toHaveLength(0);
    expect((await notificationCounts(stranger)).total).toBe(0);
    expect(await markRead(stranger, { all: true })).toEqual({ updated: 0 });
    expect(await markSeen(stranger)).toEqual({ updated: 0 });
    for (const row of notifications)
      await enqueue(getDb(), 'notification', { notificationId: row.id });
    await drainDue(20);
    expect(controls.mail).not.toHaveBeenCalled();
    expect(controls.push).not.toHaveBeenCalled();
    // A surviving direct grant still permits the radar notification.
    await getDb()
      .insert(schema.radarMembers)
      .values({ radarId: radar.id, userId: stranger.user.id, role: 'viewer' });
    expect((await listNotifications(stranger)).items.map((row) => row.radar?.id)).toEqual([
      radar.id,
    ]);
  });

  it('does not send queued notification snapshots to a suspended recipient', async () => {
    const [row] = await getDb()
      .insert(schema.notifications)
      .values({
        userId: stranger.user.id,
        kind: 'share',
        groupKey: randomUUID(),
        actorIds: [owner.user.id],
        subject: 'Queued notice',
      })
      .returning();
    await enqueue(getDb(), 'notification', { notificationId: must(row).id });
    await getDb()
      .update(schema.users)
      .set({ state: 'suspended' })
      .where(eq(schema.users.id, stranger.user.id));
    try {
      await drainDue(20);
      expect(controls.mail).not.toHaveBeenCalled();
      expect(controls.push).not.toHaveBeenCalled();
    } finally {
      await getDb()
        .update(schema.users)
        .set({ state: 'active' })
        .where(eq(schema.users.id, stranger.user.id));
    }
  });

  it('rejects unsafe actual upload metadata before saving a blip', async () => {
    const radar = await createRadar(owner, { name: randomUUID() });
    controls.head.contentType = 'text/html';
    await expect(
      createBlip(owner, radar.id, {
        body: 'file',
        attachments: [
          {
            key: `radars/${radar.id}/${randomUUID()}/file.png`,
            filename: 'file.png',
            contentType: 'image/png',
            size: 12,
          },
        ],
      }),
    ).rejects.toThrow('file type');
    expect(
      await getDb().select().from(schema.blips).where(eq(schema.blips.radarId, radar.id)),
    ).toHaveLength(0);
  });

  it('refuses attachment keys that are not exactly one issued key for this radar', async () => {
    const radar = await createRadar(owner, { name: randomUUID() });
    const other = await createRadar(owner, { name: randomUUID() });
    const id = randomUUID();
    const bad = [
      `radars/${radar.id}/${id}/../../${other.id}/${id}/x.png`,
      `radars/${radar.id}/${id}/a/b.png`,
      `radars/${radar.id}/${id}/..`,
      `radars/${radar.id}/not-a-uuid/x.png`,
      `radars/${radar.id}/x.png`,
      `radars/${radar.id}/${id}/x.png/`,
      `radars/${other.id}/${id}/x.png`,
      `radars/${radar.id}/${id}/%2e%2e%2fx.png`,
      `prefix/radars/${radar.id}/${id}/x.png`,
    ];
    for (const key of bad) {
      await expect(
        createBlip(owner, radar.id, {
          body: 'file',
          attachments: [{ key, filename: 'x.png', contentType: 'image/png', size: 12 }],
        }),
        key,
      ).rejects.toThrow('does not belong to this radar');
    }
    const ok = await createBlip(owner, radar.id, {
      body: 'file',
      attachments: [
        {
          key: `radars/${radar.id}/${id}/x.png`,
          filename: 'x.png',
          contentType: 'image/png',
          size: 12,
        },
      ],
    });
    expect(ok.id).toBeTruthy();
  });

  it('rolls back every dependent move when the final blip UPDATE fails', async () => {
    const source = await createRadar(owner, { name: randomUUID() });
    const destination = await createRadar(owner, { name: randomUUID() });
    const blip = await createBlip(owner, source.id, { body: 'Keep this private' });
    const comment = await createComment(owner, blip.id, { body: 'A reply' });
    await getDb().insert(schema.attachments).values({
      blipId: blip.id,
      radarId: source.id,
      objectKey: randomUUID(),
      filename: 'x',
      contentType: 'image/png',
      size: 12,
    });
    await getDb().execute(
      sql.raw(
        `CREATE FUNCTION refuse_review_move() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${blip.id}'::uuid AND NEW.radar_id <> OLD.radar_id THEN RAISE EXCEPTION 'injected final move failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER refuse_review_move BEFORE UPDATE ON blips FOR EACH ROW EXECUTE FUNCTION refuse_review_move();`,
      ),
    );
    try {
      await expect(updateBlip(owner, blip.id, { radarId: destination.id })).rejects.toThrow();
      expect(
        (await getDb().select().from(schema.blips).where(eq(schema.blips.id, blip.id)))[0]?.radarId,
      ).toBe(source.id);
      expect(
        (
          await getDb()
            .select()
            .from(schema.blipComments)
            .where(eq(schema.blipComments.id, comment.id))
        )[0]?.radarId,
      ).toBe(source.id);
      expect(
        (
          await getDb()
            .select()
            .from(schema.attachments)
            .where(eq(schema.attachments.blipId, blip.id))
        )[0]?.radarId,
      ).toBe(source.id);
    } finally {
      await getDb().execute(
        sql.raw('DROP TRIGGER refuse_review_move ON blips; DROP FUNCTION refuse_review_move();'),
      );
    }
  });

  it('rechecks the current radar after waiting for a concurrent move', async () => {
    const shared = await createRadar(owner, { name: randomUUID() });
    const privateRadar = await createRadar(owner, { name: randomUUID() });
    await getDb()
      .insert(schema.radarMembers)
      .values({ radarId: shared.id, userId: stranger.user.id, role: 'editor' });
    const blip = await createBlip(owner, shared.id, { body: 'Original' });
    const mover = new pg.Client({ connectionString: scratchUrl });
    await mover.connect();
    await mover.query('BEGIN');
    try {
      await mover.query('UPDATE blips SET radar_id = $1 WHERE id = $2', [privateRadar.id, blip.id]);
      const edit = updateBlip(stranger, blip.id, { body: 'Unauthorized after move' });
      const refused = expect(edit).rejects.toThrow('Radar not found');
      await expect
        .poll(async () => {
          const result = await mover.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
          );
          return result.rows[0]?.n ?? 0;
        })
        .toBeGreaterThan(0);
      await mover.query('COMMIT');
      await refused;
      expect(
        (await getDb().select().from(schema.blips).where(eq(schema.blips.id, blip.id)))[0]?.body,
      ).toBe('Original');
    } finally {
      await mover.query('ROLLBACK');
      await mover.end();
    }
  });

  it('public-link callers cannot recover archived streams, comments or attachments', async () => {
    const radar = await createRadar(owner, { name: randomUUID(), template: 'kanban' });
    await setVisibility(owner, radar.id, 'public');
    const access = await requireRadar(radar.id, owner);
    const slug = must(access.radar.publicSlug);
    const blip = await createBlip(owner, radar.id, { body: 'Archived secret', state: 'done' });
    await createComment(owner, blip.id, { body: 'Archived reply' });
    const [attachment] = await getDb()
      .insert(schema.attachments)
      .values({
        blipId: blip.id,
        radarId: radar.id,
        objectKey: randomUUID(),
        filename: 'x',
        contentType: 'image/png',
        size: 12,
      })
      .returning();
    await getDb().execute(
      sql`UPDATE blips SET created_at = now() - interval '90 days', updated_at = now() - interval '90 days' WHERE id = ${blip.id}`,
    );
    await getDb().execute(
      sql`UPDATE blip_comments SET created_at = now() - interval '90 days', updated_at = now() - interval '90 days' WHERE blip_id = ${blip.id}`,
    );
    expect(
      (await radarStream(await requireRadar(slug, stranger), stranger, { includeArchived: true }))
        .items,
    ).toHaveLength(0);
    const app = createApp();
    const session = await createSession(stranger.user);
    const response = await app.request(`/api/radars/${slug}/blips?includeArchived=true`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { items: unknown[] }).items).toHaveLength(0);
    expect((await app.request(`/api/public/radars/${slug}/blips/${blip.id}/comments`)).status).toBe(
      404,
    );
    expect(
      (await app.request(`/api/public/radars/${slug}/attachments/${must(attachment).id}`)).status,
    ).toBe(404);
    expect((await radarStream(access, owner, { includeArchived: true })).items).toHaveLength(1);
  });

  it('an old unfurl job cannot restore a cleared URL preview', async () => {
    const radar = await createRadar(owner, { name: randomUUID() });
    const blip = await createBlip(owner, radar.id, {
      body: 'link',
      url: 'https://example.com/old',
    });
    await updateBlip(owner, blip.id, { url: null });
    await drainDue(20);
    expect(controls.preview).toHaveBeenCalled();
    expect(
      (await getDb().select().from(schema.blips).where(eq(schema.blips.id, blip.id)))[0]?.preview,
    ).toBeNull();
  });

  it('retains failed notification delivery and does not repeat successful push', async () => {
    const [notification] = await getDb()
      .insert(schema.notifications)
      .values({
        userId: owner.user.id,
        kind: 'share',
        groupKey: randomUUID(),
        actorIds: [stranger.user.id],
        subject: 'Review radar',
      })
      .returning();
    controls.mail.mockRejectedValueOnce(new Error('Transient mail failure'));
    await enqueue(getDb(), 'notification', { notificationId: must(notification).id });
    await drainDue(20);
    expect(await getDb().select().from(schema.outbox)).toHaveLength(1);
    expect(
      (
        await getDb()
          .select()
          .from(schema.notifications)
          .where(eq(schema.notifications.id, must(notification).id))
      )[0]?.pushedAt,
    ).not.toBeNull();
    await getDb().execute(sql`UPDATE outbox SET run_after = now()`);
    await drainDue(20);
    expect(await getDb().select().from(schema.outbox)).toHaveLength(0);
    expect(controls.push).toHaveBeenCalledTimes(1);
    expect(controls.mail).toHaveBeenCalledTimes(2);
  });

  it('a failed cleanup enqueue rolls back blip and radar deletion', async () => {
    for (const aggregate of ['blip', 'radar']) {
      const radar = await createRadar(owner, { name: randomUUID() });
      const blip = await createBlip(owner, radar.id, { body: 'retain on failure' });
      await getDb().insert(schema.attachments).values({
        blipId: blip.id,
        radarId: radar.id,
        objectKey: randomUUID(),
        filename: 'x',
        contentType: 'image/png',
        size: 12,
      });
      await getDb().execute(
        sql.raw(
          "CREATE FUNCTION refuse_review_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected enqueue failure'; END $$; CREATE TRIGGER refuse_review_job BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION refuse_review_job();",
        ),
      );
      try {
        await expect(
          aggregate === 'blip' ? deleteBlip(owner, blip.id) : deleteRadar(owner, radar.id),
        ).rejects.toThrow();
        expect(
          await getDb().select().from(schema.blips).where(eq(schema.blips.id, blip.id)),
        ).toHaveLength(1);
        expect(
          await getDb()
            .select()
            .from(schema.attachments)
            .where(eq(schema.attachments.blipId, blip.id)),
        ).toHaveLength(1);
      } finally {
        await getDb().execute(
          sql.raw('DROP TRIGGER refuse_review_job ON outbox; DROP FUNCTION refuse_review_job();'),
        );
      }
    }
  });

  it('refused compound radar/dashboard requests preserve metadata', async () => {
    const radar = await createRadar(owner, { name: randomUUID() });
    await expect(
      updateRadar(owner, radar.id, { name: 'Must not save', topicId: randomUUID() }),
    ).rejects.toThrow();
    expect((await requireRadar(radar.id, owner)).radar.name).toBe(radar.name);
    const dashboard = await createDashboard(owner, 'Original');
    await expect(
      updateDashboard(owner, dashboard.id, {
        expectedRevision: dashboard.revision,
        name: 'Must not save',
        widgets: [{ radarId: randomUUID(), x: 0, y: 0, w: 6, h: 10 }],
      }),
    ).rejects.toThrow();
    expect(
      (
        await getDb().select().from(schema.dashboards).where(eq(schema.dashboards.id, dashboard.id))
      )[0]?.name,
    ).toBe('Original');
  });

  it('audit records identify the acting persona and its human', async () => {
    const [agent] = await getDb()
      .insert(schema.agents)
      .values({ ownerId: owner.user.id, name: 'Review bot', slug: 'review-bot' })
      .returning();
    if (!agent) throw new Error('Missing persona');
    const subject = randomUUID();
    await recordAudit(
      {
        ...owner,
        kind: 'agent',
        agent: {
          agentId: agent.id,
          ownerId: owner.user.id,
          name: agent.name,
          handle: agent.slug,
        },
      },
      'review.audit',
      'review',
      subject,
    );
    const [row] = await getDb()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.subjectId, subject));
    expect(row?.actorId).toBe(owner.user.id);
    expect(row?.agentId).toBe(agent.id);
  });

  it('keeps both authorship identities through text edits and triage, and names the editor', async () => {
    const radar = await createRadar(owner, { name: randomUUID() });
    await getDb()
      .insert(schema.radarMembers)
      .values({ radarId: radar.id, userId: stranger.user.id, role: 'editor' });
    const blip = await createBlip(owner, radar.id, { body: 'Original author' });
    const [agent] = await getDb()
      .insert(schema.agents)
      .values({ ownerId: stranger.user.id, name: 'Editing bot', slug: 'editing-bot' })
      .returning();
    if (!agent) throw new Error('Missing persona');
    const editor: Actor = {
      ...stranger,
      kind: 'agent',
      agent: {
        agentId: agent.id,
        ownerId: stranger.user.id,
        name: agent.name,
        handle: agent.slug,
      },
      voice: { granted: ['persona'], default: 'persona' },
    };
    const edited = await updateBlip(editor, blip.id, { body: 'Rewritten' });
    expect(edited.author?.id).toBe(owner.user.id);
    expect(edited.agent).toBeNull();
    expect(edited.lastEditedBy).toMatchObject({ userId: stranger.user.id, agentId: agent.id });
    const pinned = await updateBlip(owner, blip.id, { pinned: true });
    expect(pinned.author?.id).toBe(owner.user.id);
    expect(pinned.agent).toBeNull();
    // The creator editing their own card is not news.
    const humanEdit = await updateBlip(owner, blip.id, { title: 'Human title' });
    expect(humanEdit.author?.id).toBe(owner.user.id);
    expect(humanEdit.lastEditedBy).toBeUndefined();
  });

  it('concurrent transactional captures and edits do not exhaust the pool', async () => {
    const radar = await createRadar(owner, { name: randomUUID() });
    const blips = await Promise.all(
      Array.from({ length: 12 }, () =>
        createBlip(owner, radar.id, { body: '@owner A captured thought' }),
      ),
    );
    const updated = await Promise.all(
      blips.map((blip) => updateBlip(owner, blip.id, { body: '@owner An edited thought' })),
    );
    expect(updated).toHaveLength(12);
  }, 5000);
});
