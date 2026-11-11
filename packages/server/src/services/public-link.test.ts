/**
 * What a public link hands over — and, far more importantly, what it must not.
 *
 * `routes/public.ts` redacts carefully, and that redaction was the whole of the
 * defence: it lived in one transport's route file rather than in the service
 * layer. But `requireRadar` accepts a `public_slug` as an identifier — it has to,
 * or the thread on a published blip is unreachable for everybody — so the
 * *private* routes and the MCP tools took the same slug and answered the same
 * radar unredacted. A signed-in stranger holding only the link read the owner's
 * address, the member count, every member's address, every **pending invitee's**
 * address (people who never accepted and may hold no account at all) and the
 * author address on every blip.
 *
 * So each assertion below is written as a refusal that must happen, and names
 * what would be true without it:
 *
 * - **Enumeration is refused outright, not narrowed.** A member list is a list
 *   of people; there is no redacted version of it worth serving. Without the
 *   check in `listMembers`, `GET /api/radars/<slug>/members` is a 200 with three
 *   addresses in it.
 * - **The same radar is narrowed whichever identifier reached it.** Asserted as
 *   an equality between the private route's DTO and the public one's, not as two
 *   separate facts — two code paths that both decide "what may this person see"
 *   are two chances to disagree.
 * - **Everybody with a role still sees everything.** A fix that made the member
 *   list unreadable for viewers would be a worse bug than the leak: access
 *   nobody can enumerate is access nobody audits.
 * - **The uuid rule still holds.** Knowing a radar's uuid must not become read
 *   access because it was later published under a different slug.
 *
 * The HTTP half goes through `createApp()` because the leak was reached over the
 * wire with a session cookie and an unrelated account; a suite that only built
 * `Actor` objects by hand would assert the service is correct without ever
 * exercising the route that was actually leaking.
 *
 * Skipped when DATABASE_URL is absent, so `pnpm test` still runs with no
 * database. CI sets it, so this runs there.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createSession, SESSION_COOKIE } from '../auth/session.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import { requireRadar } from './access.js';
import { createBlip, radarStream } from './blips.js';
import { createRadar, getRadarDto, listMembers, setVisibility, shareRadar } from './radars.js';
import { createTopic, setRadarTopic } from './topics.js';

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

describe.skipIf(!hasDatabase)('a public link is not a membership (real postgres)', () => {
  let app: ReturnType<typeof createApp>;
  let alice: Actor;
  let bob: Actor;
  let mallory: Actor;
  /** The address of somebody with no account at all: an unaccepted invitation. */
  let invitee: string;
  let radarId: string;
  let slug: string;
  let malloryCookie: string;

  beforeAll(async () => {
    await runMigrations();
    app = createApp();
    alice = await makeUser('pl-alice');
    bob = await makeUser('pl-bob');
    mallory = await makeUser('pl-mallory');
    invitee = `pl-invitee-${Date.now()}@example.test`;
    malloryCookie = `${SESSION_COOKIE}=${(await createSession(mallory.user)).token}`;

    radarId = (await createRadar(alice, { name: `Leak ${Math.random()}` })).id;

    await shareRadar(alice, radarId, bob.user.email, 'editor');
    await shareRadar(alice, radarId, invitee, 'viewer');
    await createBlip(alice, radarId, { body: '# Canary\nsomething alice wrote' });

    const published = await setVisibility(alice, radarId, 'public');
    if (!published.publicSlug) throw new Error('publishing minted no slug');
    slug = published.publicSlug;
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  /* ------------------------------ enumeration ----------------------------- */

  it('refuses to enumerate members for a caller who holds only the link', async () => {
    const access = await requireRadar(slug, mallory, 'read');
    // The read itself is genuine — this is a refusal against enumeration, not
    // against the radar.
    expect(access.canRead).toBe(true);
    expect(access.role).toBeNull();
    expect(access.viaPublicLink).toBe(true);

    await expect(listMembers(access)).rejects.toThrow(/shared with/i);
  });

  it('refuses the same enumeration over the wire, with a real session cookie', async () => {
    const res = await app.request(`/api/radars/${slug}/members`, {
      headers: { cookie: malloryCookie },
    });
    expect(res.status).toBe(403);
    const body = await res.text();
    // The addresses are what this test is really about: an unaccepted
    // invitation belongs to somebody who never agreed to anything.
    expect(body).not.toContain(alice.user.email);
    expect(body).not.toContain(bob.user.email);
    expect(body).not.toContain(invitee);
  });

  it('still shows the whole list to everybody who holds a role', async () => {
    for (const person of [alice, bob]) {
      const members = await listMembers(await requireRadar(radarId, person, 'read'));
      const emails = members.map((m) => m.email);
      expect(emails).toContain(alice.user.email);
      expect(emails).toContain(bob.user.email);
      // Including the pending invitation, which is the point of listing it.
      expect(emails).toContain(invitee);
      expect(members.find((m) => m.email === invitee)?.pending).toBe(true);
    }
  });

  /* -------------------------------- the DTO -------------------------------- */

  it('narrows the radar identically whether the private or the public route asked', async () => {
    const viaPrivate = await getRadarDto(await requireRadar(slug, mallory, 'read'), mallory);
    const viaPublic = await getRadarDto(await requireRadar(slug, null, 'read'), null);

    for (const dto of [viaPrivate, viaPublic]) {
      expect(dto.ownerId).toBe('');
      expect(dto.owner?.email).toBe('');
      expect(dto.memberCount).toBe(0);
    }
    // Asserted as an equality so the two paths cannot drift apart later.
    expect(viaPrivate.ownerId).toBe(viaPublic.ownerId);
    expect(viaPrivate.owner?.email).toBe(viaPublic.owner?.email);
    expect(viaPrivate.memberCount).toBe(viaPublic.memberCount);
  });

  it('never names the topic a published radar is filed in', async () => {
    const topicName = `Secret acquisition plans ${Math.random()}`;
    const topic = await createTopic(alice, { name: topicName });
    await setRadarTopic(alice, radarId, topic.id);
    // Positive control: the owner does see it, so a null below is redaction.
    const own = await getRadarDto(await requireRadar(radarId, alice, 'read'), alice);
    expect(own.topic?.name).toBe(topicName);

    const res = await app.request(`/api/public/radars/${slug}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain(topicName);
    expect(body).not.toContain(topic.id);
    for (const dto of [
      await getRadarDto(await requireRadar(slug, mallory, 'read'), mallory),
      await getRadarDto(await requireRadar(slug, null, 'read'), null),
    ]) {
      expect(dto.topic).toBeNull();
      expect(dto.topicId).toBeNull();
    }
    await setRadarTopic(alice, radarId, null);
  });

  it('keeps the owner for everybody who holds a role', async () => {
    const dto = await getRadarDto(await requireRadar(radarId, alice, 'read'), alice);
    expect(dto.ownerId).toBe(alice.user.id);
    expect(dto.owner?.email).toBe(alice.user.email);
    expect(dto.memberCount).toBeGreaterThan(0);
  });

  it('strips the author address from the stream a link-holder reads', async () => {
    const page = await radarStream(await requireRadar(slug, mallory, 'read'), mallory, {});
    expect(page.items.length).toBeGreaterThan(0);
    for (const blip of page.items) {
      expect(blip.author?.email).toBe('');
      expect(blip.author?.id).toBe('');
    }

    // ...and leaves it alone for a member.
    const mine = await radarStream(await requireRadar(radarId, alice, 'read'), alice, {});
    expect(mine.items[0]?.author?.email).toBe(alice.user.email);
  });

  it('strips it over the wire on the private blips route too', async () => {
    const res = await app.request(`/api/radars/${slug}/blips`, {
      headers: { cookie: malloryCookie },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(alice.user.email);
  });

  /* ------------------------------ still refused ---------------------------- */

  /**
   * The account-existence oracle that used to sit on this router.
   *
   * `GET /api/radars/:id/lookup?email=` needed only `manage` on *a* radar, and
   * anybody can make one — so any signed-in account could ask whether any
   * address was registered and get the display name with it, unrate-limited.
   * `POST /api/auth/request-code` is written to withhold precisely that, and
   * the two are asserted together here so the pair cannot drift again.
   */
  it('gives nobody a way to ask whether an address has an account', async () => {
    const mine = await createRadar(mallory, { name: `Probing ${Math.random()}` });
    const probe = await app.request(
      `/api/radars/${mine.id}/lookup?email=${encodeURIComponent(alice.user.email)}`,
      { headers: { cookie: malloryCookie } },
    );
    expect(probe.status).toBe(404);
    expect(await probe.text()).not.toContain(alice.user.email);

    // The rule it was quietly undoing, restated: one address is registered and
    // the other is not, and the two answers are byte-for-byte identical.
    const ask = (email: string) =>
      app.request('/api/auth/request-code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
    const known = (await (await ask(alice.user.email)).json()) as Record<string, unknown>;
    const unknown = (await (await ask(`nobody-${Date.now()}@example.test`)).json()) as Record<
      string,
      unknown
    >;
    expect(Object.keys(known).sort()).toEqual(Object.keys(unknown).sort());
    expect(known['status']).toBe(unknown['status']);
  });

  it('does not turn a public link into write access or into uuid access', async () => {
    // Publishing under a slug must not make the uuid an identifier for a
    // stranger — the rule `getRadarAccess` states, restated at the route.
    const byUuid = await app.request(`/api/radars/${radarId}`, {
      headers: { cookie: malloryCookie },
    });
    expect(byUuid.status).toBe(404);

    const write = await app.request(`/api/radars/${slug}/blips`, {
      method: 'POST',
      headers: { cookie: malloryCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'not mine to write' }),
    });
    expect(write.status).toBe(403);
  });
});
