/**
 * Notifications, against a real Postgres.
 *
 * Every property here is a database behaviour, and none of them is visible to a
 * mock:
 *
 * - **Coalescing is an index, not a code path.** Ten reactions on one blip must
 *   leave one row with a count of ten. That is `ON CONFLICT (user_id,
 *   group_key) WHERE read_at IS NULL` arbitrating a *partial* unique index, and
 *   whether Postgres accepts that inference at all is exactly the sort of thing
 *   CI's real database exists to catch (`omr_tags_text` was found the same way).
 *
 * - **Reading closes the window.** The next event after a read has to start a
 *   fresh row rather than folding into the one already dealt with. That is the
 *   index predicate doing it, so it can only be asserted for real.
 *
 * - **Recipients are re-derived from live membership.** Somebody whose share
 *   was revoked must stop being notified immediately — a notification carries an
 *   excerpt of the content, so this is a disclosure rule.
 *
 * - **You are never notified about your own act.**
 *
 * - **The per-radar level is honoured**, including the carve-out that makes a
 *   webhook delivery audible at the default level while a human's capture is not.
 *
 * Skipped when DATABASE_URL is absent, so `pnpm test` still runs with no
 * database. CI sets it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { NotificationDto, PageDto } from '@onmyradar/contract';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import { createBlip } from './blips.js';
import { createComment } from './comments.js';
import {
  fromRaw,
  listNotifications,
  markRead,
  markSeen,
  notificationCounts,
  getSettings,
  purgeOldNotifications,
  setRadarLevel,
  type RawNotificationRow,
} from './notifications.js';
import { createRadar, removeMember, shareRadar } from './radars.js';
import { setReaction } from './reactions.js';
import { createTopic, setCascade, setRadarTopic, shareTopic } from './topics.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

async function makeUser(label: string): Promise<Actor> {
  const [user] = await getDb()
    .insert(schema.users)
    .values({
      email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      name: label,
      state: 'active',
    })
    .returning();
  if (!user) throw new Error('user insert returned no row');
  return { user, kind: 'user' };
}

async function share(radarId: string, actor: Actor, role: 'viewer' | 'editor') {
  await getDb().insert(schema.radarMembers).values({ radarId, userId: actor.user.id, role });
}

/** Notifications this person is holding, newest first. */
async function inboxOf(actor: Actor) {
  const page = await listNotifications(actor, { limit: 100 });
  return page.items;
}

/**
 * Fresh people for every test.
 *
 * Deliberately not a shared `beforeAll` cast. Notifications *accumulate* on an
 * account, so reusing one across tests makes each assertion depend on every
 * test that ran before it — which is the same class of ordering bug the
 * migration race suite hit when it shared a database (25876c3), and it shows up
 * the same way: assertions that pass alone and fail in a suite.
 */
async function cast(): Promise<{ owner: Actor; mate: Actor; third: Actor }> {
  return {
    owner: await makeUser('owner'),
    mate: await makeUser('mate'),
    third: await makeUser('third'),
  };
}

describe.skipIf(!hasDatabase)('notifications (real postgres)', () => {
  beforeAll(async () => {
    await runMigrations();
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  /* ------------------------------- the events ---------------------------- */

  it('tells a blip author that somebody commented, and never tells the commenter', async () => {
    const { owner, mate } = await cast();
    const radar = await createRadar(owner, { name: `Comment ${Math.random()}` });
    await share(radar.id, mate, 'viewer');
    const blip = await createBlip(owner, radar.id, { body: 'what do we think' });

    await createComment(mate, blip.id, { body: 'I think yes' });

    const [note] = await inboxOf(owner);
    expect(note?.kind).toBe('comment');
    expect(note?.blipId).toBe(blip.id);
    expect(note?.title).toContain('mate');
    expect(note?.title).toContain('commented on');
    expect(note?.excerpt).toBe('I think yes');

    // Acting on something never notifies you about your own act.
    expect(await inboxOf(mate)).toHaveLength(0);
  });

  it('pulls everybody already in a thread back to it, and nobody else', async () => {
    const { owner, mate, third } = await cast();
    const radar = await createRadar(owner, { name: `Thread ${Math.random()}` });
    await share(radar.id, mate, 'viewer');
    await share(radar.id, third, 'viewer');
    const blip = await createBlip(owner, radar.id, { body: 'a question' });

    await createComment(mate, blip.id, { body: 'first' });
    // `third` can read the radar but has said nothing, so at the default level
    // this is not their conversation and must stay silent for them.
    expect(await inboxOf(third)).toHaveLength(0);

    await createComment(third, blip.id, { body: 'second' });
    // Now that they have spoken, the reply after theirs reaches them.
    await createComment(mate, blip.id, { body: 'third' });

    const forThird = await inboxOf(third);
    expect(forThird).toHaveLength(1);
    expect(forThird[0]?.kind).toBe('comment');
  });

  it('tells a blip author about a mark, and says nothing when it is taken back', async () => {
    const { owner, mate } = await cast();
    const radar = await createRadar(owner, { name: `React ${Math.random()}` });
    await share(radar.id, mate, 'viewer');
    const blip = await createBlip(owner, radar.id, { body: 'worth a look' });

    await setReaction(mate, blip.id, 'up');
    let inbox = await inboxOf(owner);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.kind).toBe('reaction');
    expect(inbox[0]?.count).toBe(1);

    // Un-reacting is not an event. It must not fold a second one in, and it
    // must not create a new row either.
    await setReaction(mate, blip.id, 'up');
    inbox = await inboxOf(owner);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.count).toBe(1);
  });

  it('tells somebody a radar was handed to them, once, on the grant and not the change', async () => {
    const { owner, mate } = await cast();
    const radar = await createRadar(owner, { name: `Handed ${Math.random()}` });
    await shareRadar(owner, radar.id, mate.user.email, 'viewer');

    let inbox = await inboxOf(mate);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.kind).toBe('share');
    expect(inbox[0]?.title).toContain('shared');

    // Promoting them is not the same event as handing them the radar, and
    // saying so twice is how a stream starts to feel like noise.
    await shareRadar(owner, radar.id, mate.user.email, 'editor');
    inbox = await inboxOf(mate);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.count).toBe(1);
  });

  /* ------------------------------- coalescing ---------------------------- */

  it('folds ten reactions on one blip into one notification', async () => {
    const { owner } = await cast();
    const radar = await createRadar(owner, { name: `Flood ${Math.random()}` });
    const blip = await createBlip(owner, radar.id, { body: 'popular' });

    // Ten different people, each putting one mark on the same blip.
    for (let i = 0; i < 10; i += 1) {
      const person = await makeUser(`fan${i}`);
      await share(radar.id, person, 'viewer');
      await setReaction(person, blip.id, 'up');
    }

    const inbox = await inboxOf(owner);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.count).toBe(10);
    // Capped principal identities do not establish a total participant count.
    expect(inbox[0]?.actors.length).toBeLessThanOrEqual(8);
    expect(inbox[0]?.title).toMatch(/other participants left 10 reactions/);
  });

  it('starts a fresh notification once the last one has been read', async () => {
    const { owner, mate } = await cast();
    const radar = await createRadar(owner, { name: `Fresh ${Math.random()}` });
    await share(radar.id, mate, 'viewer');
    const blip = await createBlip(owner, radar.id, { body: 'ongoing' });

    await createComment(mate, blip.id, { body: 'one' });
    await createComment(mate, blip.id, { body: 'two' });
    let inbox = await inboxOf(owner);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.count).toBe(2);

    await markRead(owner, { all: true });

    // Reading closes the coalescing window: the *next* remark is a new line, not
    // a third fold into something already dealt with. That is the partial index
    // predicate doing the deciding, which is why this is asserted for real.
    await createComment(mate, blip.id, { body: 'three' });
    inbox = await inboxOf(owner);
    expect(inbox).toHaveLength(2);
    expect(inbox[0]?.count).toBe(1);
    expect(inbox[0]?.read).toBe(false);
    expect(inbox[1]?.read).toBe(true);
  });

  it('keeps comments and reactions on the same blip apart', async () => {
    const { owner, mate } = await cast();
    const radar = await createRadar(owner, { name: `Both ${Math.random()}` });
    await share(radar.id, mate, 'viewer');
    const blip = await createBlip(owner, radar.id, { body: 'two kinds' });

    await createComment(mate, blip.id, { body: 'said something' });
    await setReaction(mate, blip.id, 'heart');

    const inbox = await inboxOf(owner);
    expect(inbox).toHaveLength(2);
    expect(new Set(inbox.map((n) => n.kind))).toEqual(new Set(['comment', 'reaction']));
  });

  /* ------------------------------- recipients ---------------------------- */

  it('stops notifying somebody the moment their access is revoked', async () => {
    const { owner, mate } = await cast();
    const radar = await createRadar(owner, { name: `Revoked ${Math.random()}` });
    await share(radar.id, mate, 'viewer');
    const blip = await createBlip(owner, radar.id, { body: 'confidential-ish' });

    // `mate` joins the conversation, which normally makes them a recipient of
    // everything that follows.
    await createComment(mate, blip.id, { body: 'I am here' });
    await markRead(mate, { all: true });

    await getDb()
      .delete(schema.radarMembers)
      .where(
        and(
          eq(schema.radarMembers.radarId, radar.id),
          eq(schema.radarMembers.userId, mate.user.id),
        ),
      );

    await createComment(owner, blip.id, { body: 'something they should not see' });

    // Recipients are re-derived from live membership every time. A notification
    // carries an excerpt of the content, so a stale recipient list would be a
    // disclosure rather than an untidiness.
    const inbox = await inboxOf(mate);
    expect(inbox.filter((n) => !n.read)).toHaveLength(0);
  });

  it('takes back the notifications when access is taken back', async () => {
    const { owner, mate } = await cast();
    const radar = await createRadar(owner, { name: `Removed ${Math.random()}` });
    await shareRadar(owner, radar.id, mate.user.email, 'viewer');
    const blip = await createBlip(owner, radar.id, { body: 'something private' });
    await createComment(mate, blip.id, { body: 'noted' });
    await createComment(owner, blip.id, { body: 'a remark they should not keep' });

    expect((await inboxOf(mate)).length).toBeGreaterThan(0);

    await removeMember(owner, radar.id, mate.user.id);

    // A notification carries a snapshot excerpt of the content, so leaving the
    // ones already written would hand a removed member a readable copy of a
    // conversation they can no longer open. Same reasoning as suspension
    // revoking every session immediately.
    expect(await inboxOf(mate)).toHaveLength(0);
  });

  it('says nothing at all to somebody who muted the radar', async () => {
    const { owner, mate } = await cast();
    const radar = await createRadar(owner, { name: `Muted ${Math.random()}` });
    // Editor, because `mate` captures the blip the others then act on.
    await share(radar.id, mate, 'editor');
    const blip = await createBlip(mate, radar.id, { body: 'mine' });

    await setRadarLevel(mate, radar.id, 'none');
    await createComment(owner, blip.id, { body: 'still talking' });
    await setReaction(owner, blip.id, 'up');

    expect(await inboxOf(mate)).toHaveLength(0);
  });

  /* ------------------------------ blips and level ------------------------ */

  it('is silent about a captured blip until the radar is turned up to `all`', async () => {
    const { owner, mate } = await cast();
    const radar = await createRadar(owner, { name: `Capture ${Math.random()}` });
    await share(radar.id, mate, 'editor');

    // The default. Capture is the primary action; a notification per captured
    // thought is precisely the flood that gets a stream muted permanently.
    await createBlip(owner, radar.id, { body: 'a thought' });
    expect(await inboxOf(mate)).toHaveLength(0);

    await setRadarLevel(mate, radar.id, 'all');
    await createBlip(owner, radar.id, { body: 'another thought' });
    await createBlip(owner, radar.id, { body: 'and another' });

    const inbox = await inboxOf(mate);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.kind).toBe('blip');
    // Grouped by radar, not by blip: twelve form submissions are one line.
    expect(inbox[0]?.count).toBe(2);
  });

  it('tells the radar owner about a webhook delivery even at the default level', async () => {
    const { owner, mate } = await cast();
    const radar = await createRadar(owner, { name: `Inbound ${Math.random()}` });
    await share(radar.id, mate, 'editor');

    // Exactly the actor `ingestWebhook` builds: the webhook's creator, tagged
    // `webhook` so the audit log can tell the three kinds apart.
    const delivery: Actor = { user: mate.user, kind: 'webhook', webhookId: 'test-webhook' };
    await createBlip(delivery, radar.id, { body: 'a form submission' });

    // A blip that arrived from outside is different in kind from one a person
    // captured: nobody was watching it land, which is the whole reason webhooks
    // exist. So the radar's owner hears about it without opting in.
    const inbox = await inboxOf(owner);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.kind).toBe('blip');
  });

  it('shows a link-only delivery as its link, not as an empty line', async () => {
    const { owner, mate } = await cast();
    const radar = await createRadar(owner, { name: `Link inbound ${Math.random()}` });
    await share(radar.id, mate, 'editor');
    const delivery: Actor = { user: mate.user, kind: 'webhook', webhookId: 'test-webhook' };
    // No body and no heading: the stored body is '', which `??` never skipped.
    await createBlip(delivery, radar.id, { url: 'https://example.invalid/form' });

    const inbox = await inboxOf(owner);
    expect(inbox[0]?.excerpt).toBe('https://example.invalid/form');
  });

  it('notifies an owner-attributed external capture but preserves self-capture silence and mute', async () => {
    const { owner } = await cast();
    const radar = await createRadar(owner, { name: `Own inbound ${Math.random()}` });
    await setRadarLevel(owner, radar.id, 'all');
    await createBlip(owner, radar.id, { body: 'My own thought stays quiet' });
    expect(await inboxOf(owner)).toHaveLength(0);
    await setRadarLevel(owner, radar.id, 'involved');
    await createBlip({ ...owner, kind: 'webhook' }, radar.id, { body: 'External delivery' });
    expect(await inboxOf(owner)).toMatchObject([{ kind: 'blip', count: 1 }]);
    await setRadarLevel(owner, radar.id, 'none');
    await createBlip({ ...owner, kind: 'webhook' }, radar.id, { body: 'Muted delivery' });
    expect(await inboxOf(owner)).toMatchObject([{ kind: 'blip', count: 1 }]);
  });

  /* --------------------------------- state ------------------------------- */

  it('separates seen from read: looking is not dealing with it', async () => {
    const { mate } = await cast();
    const actor = await makeUser('reader');
    const radar = await createRadar(actor, { name: `State ${Math.random()}` });
    await share(radar.id, mate, 'viewer');
    const blip = await createBlip(actor, radar.id, { body: 'ping me' });
    await createComment(mate, blip.id, { body: 'here' });

    let counts = await notificationCounts(actor);
    expect(counts.total).toBe(1);
    expect(counts.unseen).toBe(1);
    expect(counts.byRadar[radar.id]).toBe(1);

    // Opening the panel stops the ping. It does not claim you have dealt with
    // anything, so the badge keeps its count.
    await markSeen(actor);
    counts = await notificationCounts(actor);
    expect(counts.total).toBe(1);
    expect(counts.unseen).toBe(0);

    await markRead(actor, { radarId: radar.id });
    counts = await notificationCounts(actor);
    expect(counts.total).toBe(0);
    expect(counts.byRadar[radar.id]).toBeUndefined();
  });

  it('marks read by id, and can put one back', async () => {
    const { mate } = await cast();
    const actor = await makeUser('marker');
    const radar = await createRadar(actor, { name: `Marks ${Math.random()}` });
    await share(radar.id, mate, 'viewer');
    const blip = await createBlip(actor, radar.id, { body: 'x' });
    await createComment(mate, blip.id, { body: 'y' });

    const [note] = await inboxOf(actor);
    expect(note).toBeDefined();

    expect((await markRead(actor, { ids: [note?.id as string] })).updated).toBe(1);
    // Already read: nothing left to do, and the count says so rather than
    // silently churning the row.
    expect((await markRead(actor, { ids: [note?.id as string] })).updated).toBe(0);

    expect((await markRead(actor, { ids: [note?.id as string], read: false })).updated).toBe(1);
    expect((await notificationCounts(actor)).total).toBe(1);
  });

  it('will not let one account mark another account’s notification read', async () => {
    const { mate, third } = await cast();
    const victim = await makeUser('victim');
    const radar = await createRadar(victim, { name: `Theirs ${Math.random()}` });
    await share(radar.id, mate, 'viewer');
    const blip = await createBlip(victim, radar.id, { body: 'private business' });
    await createComment(mate, blip.id, { body: 'hello' });

    const [note] = await inboxOf(victim);
    // The WHERE clause leads with the caller's own user id, so this is not a
    // permission that has to be checked — it is a row the statement cannot see.
    expect((await markRead(third, { ids: [note?.id as string] })).updated).toBe(0);
    expect((await notificationCounts(victim)).total).toBe(1);
  });

  it('sweeps read notifications past retention and never touches unread ones', async () => {
    const { mate } = await cast();
    const actor = await makeUser('sweeper');
    const radar = await createRadar(actor, { name: `Old ${Math.random()}` });
    await share(radar.id, mate, 'viewer');
    const blip = await createBlip(actor, radar.id, { body: 'ancient' });
    await createComment(mate, blip.id, { body: 'long ago' });

    const [note] = await inboxOf(actor);
    const id = note?.id as string;

    // Read, and older than retention.
    await getDb()
      .update(schema.notifications)
      .set({ readAt: new Date('2020-01-01T00:00:00Z') })
      .where(eq(schema.notifications.id, id));

    // A delivery may briefly own the row. Retention deliberately skips locked
    // rows; the next bounded worker sweep must collect it once that work ends.
    await vi.waitFor(
      async () => {
        await purgeOldNotifications();
        expect(await inboxOf(actor)).toHaveLength(0);
      },
      { timeout: 2000, interval: 20 },
    );

    // An unread notification is never swept however old it is: an unanswered
    // question does not expire.
    await createComment(mate, blip.id, { body: 'again' });
    const [fresh] = await inboxOf(actor);
    await getDb()
      .update(schema.notifications)
      .set({ createdAt: new Date('2020-01-01T00:00:00Z') })
      .where(eq(schema.notifications.id, fresh?.id as string));

    await purgeOldNotifications();
    expect(await inboxOf(actor)).toHaveLength(1);
  });

  it('pages with a total cursor', async () => {
    const { mate } = await cast();
    const actor = await makeUser('pager');
    const radar = await createRadar(actor, { name: `Paged ${Math.random()}` });
    await share(radar.id, mate, 'viewer');

    // Five separate blips, so five separate group keys and five rows.
    for (let i = 0; i < 5; i += 1) {
      const blip = await createBlip(actor, radar.id, { body: `blip ${i}` });
      await createComment(mate, blip.id, { body: `on ${i}` });
    }

    // Stamped by hand, at **microsecond** precision, because that is the only
    // way to reproduce the defect this test exists for. `timestamptz` carries
    // microseconds; a JS `Date` carries milliseconds. A cursor round-tripped
    // through a `Date` therefore names an instant fractionally *before* the row
    // it came from, and this stream compares with `<` — so any row falling in
    // that sub-millisecond gap is skipped in silence.
    //
    // The gap is placed deliberately at a page boundary with `limit: 2`: the
    // boundary row is `.004900`, which truncates to `.004000`, and `.004100`
    // sits inside the gap. `fanOut` issues one INSERT per recipient in its own
    // transaction, so rows a few hundred microseconds apart are what production
    // actually produces during a burst.
    const ordered = await getDb()
      .select({ id: schema.notifications.id })
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, actor.user.id))
      .orderBy(sql`${schema.notifications.createdAt} DESC, ${schema.notifications.id} DESC`);
    expect(ordered).toHaveLength(5);

    const micros = ['.005000', '.004900', '.004100', '.003000', '.002000'];
    for (const [i, row] of ordered.entries()) {
      await getDb().execute(
        sql`UPDATE notifications SET created_at = ${`2026-02-02 12:00:00${micros[i] as string}+00`}::timestamptz WHERE id = ${row.id}::uuid`,
      );
    }
    const expected = ordered.map((r) => r.id);

    // Walk *every* page. Asserting only that no row repeats is what let the
    // skip ship: a page that quietly drops a row still has a unique id set.
    // Completeness is the property, and the guard counter turns a cursor that
    // fails to terminate into a wrong-length result rather than a hung suite.
    const walked: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const page: PageDto<NotificationDto> = await listNotifications(actor, {
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      walked.push(...page.items.map((n) => n.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }

    // Every row, exactly once, in the order the stream promises.
    expect(walked).toEqual(expected);
  });

  it('filters to one radar and to unread', async () => {
    const { mate } = await cast();
    const actor = await makeUser('filterer');
    const a = await createRadar(actor, { name: `A ${Math.random()}` });
    const b = await createRadar(actor, { name: `B ${Math.random()}` });
    await share(a.id, mate, 'viewer');
    await share(b.id, mate, 'viewer');
    const blipA = await createBlip(actor, a.id, { body: 'in a' });
    const blipB = await createBlip(actor, b.id, { body: 'in b' });
    await createComment(mate, blipA.id, { body: 'about a' });
    await createComment(mate, blipB.id, { body: 'about b' });

    const onlyA = await listNotifications(actor, { radarId: a.id });
    expect(onlyA.items).toHaveLength(1);
    expect(onlyA.items[0]?.radar?.id).toBe(a.id);

    await markRead(actor, { radarId: a.id });
    const unread = await listNotifications(actor, { unreadOnly: true });
    expect(unread.items).toHaveLength(1);
    expect(unread.items[0]?.radar?.id).toBe(b.id);
  });

  /**
   * The delivery path, which the stream cannot speak for.
   *
   * A notification is written with raw SQL, because only raw SQL can name a
   * partial unique index as the conflict arbiter. Drizzle's node-postgres driver
   * installs its own type parsers and hands timestamps back from `db.execute` as
   * **strings**, converting to `Date` only inside its query builders — so the
   * raw row is a different shape from the one the rest of the file works in, and
   * `fromRaw` is the only thing standing between them.
   *
   * When it did not convert, every email and every push died on the first
   * `.toISOString()` inside `deliver`'s `catch`, logged as a warning and nothing
   * more. Nothing in the UI changed, because the stream reads through the query
   * builder. These two assertions are the only place that gap is visible.
   */
  it('converts the raw insert row, which is what the email and push path reads', async () => {
    const owner = await makeUser('rawrow');
    const radar = await createRadar(owner, { name: `Raw ${Math.random()}` });
    const blip = await createBlip(owner, radar.id, { body: 'something to talk about' });
    const mate = await makeUser('rawmate');
    await share(radar.id, mate, 'viewer');
    await createComment(mate, blip.id, { body: 'a remark' });

    const result = await getDb().execute<RawNotificationRow>(
      sql`SELECT *, false AS inserted FROM notifications WHERE user_id = ${owner.user.id}::uuid`,
    );
    const raw = result.rows[0];
    if (!raw) throw new Error('the comment produced no notification to convert');

    // The driver contract this conversion exists for. If a future Drizzle bump
    // starts handing back Dates, this is the line that says so — and whoever
    // reads it should then look at `fromRaw` rather than deleting it.
    expect(typeof raw.created_at).toBe('string');

    const row = fromRaw(raw);
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
    expect(Number.isNaN(row.createdAt.getTime())).toBe(false);
    // A null timestamp has to survive as null rather than becoming Invalid Date.
    expect(row.readAt).toBeNull();

    // And the thing that actually broke: the delivery path formats these.
    expect(() => row.createdAt.toISOString()).not.toThrow();
  });

  it('stops writing notifications to a suspended account', async () => {
    const { owner, mate } = await cast();
    const radar = await createRadar(owner, { name: `Suspended ${Math.random()}` });

    // Active: the share reaches them, which is the control for what follows.
    // `shareRadar` rather than the direct-insert helper, because it is the path
    // that emits the notification.
    await shareRadar(owner, radar.id, mate.user.email, 'editor');
    expect(await inboxOf(mate)).toHaveLength(1);

    await getDb()
      .update(schema.users)
      .set({ state: 'suspended' })
      .where(eq(schema.users.id, mate.user.id));

    // Suspension revokes every session immediately. Email and push are the two
    // paths that still reach somebody after their sessions are gone, so a
    // notification written for a suspended account is the one channel still
    // talking to a person who has been shut out. The filter lives on `fanOut`,
    // the single write path, rather than at each entry point — so this holds for
    // `share` (raw recipient id, no radar audience involved) as much as for a
    // comment.
    const other = await createRadar(owner, { name: `After ${Math.random()}` });
    await shareRadar(owner, other.id, mate.user.email, 'viewer');

    const blip = await createBlip(owner, radar.id, { body: 'still talking' });
    await setRadarLevel(owner, radar.id, 'all');
    await createComment(owner, blip.id, { body: 'anyone there' });

    const rows = await getDb()
      .select({ id: schema.notifications.id })
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, mate.user.id));
    // The one from before they were suspended, and nothing since.
    expect(rows).toHaveLength(1);
  });

  /* ------------------------------ the settings screen -------------------- */

  it('offers a level control for a radar reached only through a cascading topic', async () => {
    const { owner, mate } = await cast();
    const radar = await createRadar(owner, { name: `Cascaded ${Math.random()}` });
    const topic = await createTopic(owner, { name: `Group ${Math.random()}` });
    await setRadarTopic(owner, radar.id, topic.id);
    await setCascade(owner, topic.id, true);
    await shareTopic(owner, topic.id, mate.user.email, 'viewer');

    // `mate` holds no row in `radar_members` at all — their access to this
    // radar exists only as a cascade from the topic.
    const direct = await getDb()
      .select()
      .from(schema.radarMembers)
      .where(
        and(
          eq(schema.radarMembers.radarId, radar.id),
          eq(schema.radarMembers.userId, mate.user.id),
        ),
      );
    expect(direct).toHaveLength(0);

    // Fan-out is cascade-aware, so they are notified about it...
    await setRadarLevel(mate, radar.id, 'all');
    await createBlip(owner, radar.id, { body: 'and another' });
    expect((await inboxOf(mate)).some((n) => n.radar?.id === radar.id)).toBe(true);

    // ...so the settings screen has to render a control for it. Enumeration
    // that is narrower than fan-out means notified-and-unmutable.
    const settings = await getSettings(mate);
    const listed = settings.radars.find((r) => r.id === radar.id);
    expect(listed).toBeDefined();
    expect(listed?.level).toBe('all');
    expect(listed?.name).toBe(radar.name);

    // And a radar they cannot read is still absent — widening enumeration must
    // not turn the screen into a directory of every radar in the database.
    const stranger = await createRadar(owner, { name: `Unreachable ${Math.random()}` });
    expect(settings.radars.some((r) => r.id === stranger.id)).toBe(false);
  });
});
