/**
 * Smart radars, against a real Postgres.
 *
 * The property under test is the one that decides whether smart radars are safe
 * to ship: **a smart radar resolves against the caller's own readable radars,
 * never the owner's.** That cannot be checked against a mock, because the whole
 * question is which rows the query actually returns — and the rest of the
 * schema's interesting behaviour (the `text[]` containment operators, the
 * generated tsvector, the CHECK constraints) is invisible to one too.
 *
 * Skipped when DATABASE_URL is absent, so `pnpm test` still runs with no
 * database. CI sets it, so this runs there.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import { getRadarAccess } from './access.js';
import { createBlip, radarStream, resolveRadarScope, updateBlip } from './blips.js';
import { createRadar, createSmartRadar, ensureDropBox, setVisibility } from './radars.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
// The env is validated at boot and refuses a short secret; a suite that never
// signs anybody in still has to satisfy it.
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

async function accessTo(radarId: string, actor: Actor) {
  const access = await getRadarAccess(radarId, actor);
  if (!access) throw new Error('radar vanished');
  return access;
}

describe.skipIf(!hasDatabase)('smart radars (real postgres)', () => {
  let alice: Actor;
  let bob: Actor;

  beforeAll(async () => {
    await runMigrations();
    alice = await makeUser('alice');
    bob = await makeUser('bob');
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  it('reads in its own template’s order: pinned first, then lane order', async () => {
    const tag = `q${Math.random().toString(36).slice(2, 8)}`;
    const log = await createRadar(alice, { name: `Log ${tag}`, template: 'decisions' });
    const ids: string[] = [];
    for (const [n, at] of [
      ['a', '2026-01-01T00:00:00Z'],
      ['b', '2026-02-01T00:00:00Z'],
      ['c', '2026-03-01T00:00:00Z'],
    ] as const) {
      const blip = await createBlip(alice, log.id, { body: `# Call ${n} #${tag}` });
      await getDb()
        .update(schema.blips)
        .set({ createdAt: new Date(at) })
        .where(eq(schema.blips.id, blip.id));
      ids.push(blip.id);
    }
    const [oldest, middle, newest] = ids as [string, string, string];
    await updateBlip(alice, middle, { status: 'accepted' });
    await updateBlip(alice, newest, { pinned: true });

    const smart = await createSmartRadar(alice, {
      name: `Decisions ${tag}`,
      description: null,
      filter: { tags: [tag] },
      template: 'decisions',
    });
    const page = await radarStream(await accessTo(smart.id, alice), alice, {});
    // Chronicle order: the accepted one sinks below the proposed, whatever its date.
    expect(page.items.map((b) => b.id)).toEqual([newest, oldest, middle]);

    // The default template is capture order, newest first, exactly as before.
    const plain = await createSmartRadar(alice, {
      name: `Plain ${tag}`,
      description: null,
      filter: { tags: [tag] },
    });
    const plainPage = await radarStream(await accessTo(plain.id, alice), alice, {});
    expect(plainPage.items.map((b) => b.id)).toEqual([newest, middle, oldest]);
  });

  it('gathers tagged blips from across the owner’s own radars', async () => {
    const work = await createRadar(alice, { name: `Work ${Math.random()}` });
    const home = await createRadar(alice, { name: `Home ${Math.random()}` });
    await createBlip(alice, work.id, { body: 'fix the deploy #bug' });
    await createBlip(alice, home.id, { body: 'the tap drips #bug' });
    await createBlip(alice, home.id, { body: 'nothing to see here' });

    const smart = await createSmartRadar(alice, {
      name: `All bugs ${Math.random()}`,
      description: null,
      filter: { tags: ['bug'] },
    });

    const page = await radarStream(await accessTo(smart.id, alice), alice, {});
    expect(page.items).toHaveLength(2);
    expect(page.items.every((b) => b.tags.includes('bug'))).toBe(true);
  });

  it('resolves against the CALLER, so sharing one leaks nothing', async () => {
    // The disclosure this guards: Alice shares a smart radar with Bob. If it
    // resolved against Alice, Bob would read every private radar of hers that
    // happens to carry the tag — which is not what "share a saved search" means
    // to anybody.
    const secret = await createRadar(alice, { name: `Secret ${Math.random()}` });
    await createBlip(alice, secret.id, { body: 'the launch date is #confidential' });

    const smart = await createSmartRadar(alice, {
      name: `Confidential ${Math.random()}`,
      description: null,
      filter: { tags: ['confidential'] },
    });
    await getDb()
      .insert(schema.radarMembers)
      .values({ radarId: smart.id, userId: bob.user.id, role: 'viewer' });

    const asAlice = await radarStream(await accessTo(smart.id, alice), alice, {});
    expect(asAlice.items).toHaveLength(1);

    // Bob can open it — and sees nothing, because he can read none of the
    // radars behind it.
    const asBob = await radarStream(await accessTo(smart.id, bob), bob, {});
    expect(asBob.items).toHaveLength(0);

    // Once Bob has his own #confidential blip, the same radar shows him his.
    const bobRadar = await createRadar(bob, { name: `Bob ${Math.random()}` });
    await createBlip(bob, bobRadar.id, { body: 'my own #confidential note' });
    const asBobAgain = await radarStream(await accessTo(smart.id, bob), bob, {});
    expect(asBobAgain.items).toHaveLength(1);
    expect(asBobAgain.items[0]?.body).toContain('my own');
  });

  it('resolves to nothing at all for an anonymous caller', async () => {
    const smart = await createSmartRadar(alice, {
      name: `Anon ${Math.random()}`,
      description: null,
      filter: { tags: ['bug'] },
    });
    const scope = await resolveRadarScope(await accessTo(smart.id, alice), null);
    expect(scope.radarIds).toEqual([]);
  });

  it('refuses to be published', async () => {
    const smart = await createSmartRadar(alice, {
      name: `Nope ${Math.random()}`,
      description: null,
      filter: { tags: ['bug'] },
    });
    await expect(setVisibility(alice, smart.id, 'public')).rejects.toThrow(/cannot be published/i);
  });

  it('refuses to be captured into, and says where to capture instead', async () => {
    const smart = await createSmartRadar(alice, {
      name: `No capture ${Math.random()}`,
      description: null,
      filter: { tags: ['bug'] },
    });
    await expect(createBlip(alice, smart.id, { body: 'hello #bug' })).rejects.toThrow(
      /smart radar/i,
    );
  });

  it('honours match: all, which the text[] containment operator decides', async () => {
    const radar = await createRadar(alice, { name: `Match ${Math.random()}` });
    await createBlip(alice, radar.id, { body: 'both of them #alpha #beta' });
    await createBlip(alice, radar.id, { body: 'only one #alpha' });

    const any = await createSmartRadar(alice, {
      name: `Any ${Math.random()}`,
      description: null,
      filter: { tags: ['alpha', 'beta'], match: 'any' },
    });
    const all = await createSmartRadar(alice, {
      name: `All ${Math.random()}`,
      description: null,
      filter: { tags: ['alpha', 'beta'], match: 'all' },
    });

    expect((await radarStream(await accessTo(any.id, alice), alice, {})).items).toHaveLength(2);
    expect((await radarStream(await accessTo(all.id, alice), alice, {})).items).toHaveLength(1);
  });

  it('normalises the saved tags, so a filter typed like a human still matches', async () => {
    const radar = await createRadar(alice, { name: `Norm ${Math.random()}` });
    await createBlip(alice, radar.id, { body: 'planning the thing #side-projects' });

    const smart = await createSmartRadar(alice, {
      name: `Side ${Math.random()}`,
      description: null,
      // Typed the way a person would, not the way it is stored.
      filter: { tags: ['#Side Projects'] },
    });
    expect(smart.filter?.tags).toEqual(['side-projects']);
    expect((await radarStream(await accessTo(smart.id, alice), alice, {})).items).toHaveLength(1);
  });

  it('narrows rather than escapes when the caller also filters', async () => {
    const radar = await createRadar(alice, { name: `Narrow ${Math.random()}` });
    await createBlip(alice, radar.id, { body: 'one #narrow', state: 'active' });
    await createBlip(alice, radar.id, { body: 'two #narrow', state: 'done' });

    const smart = await createSmartRadar(alice, {
      name: `Narrow smart ${Math.random()}`,
      description: null,
      filter: { tags: ['narrow'] },
    });
    const access = await accessTo(smart.id, alice);
    expect((await radarStream(access, alice, {})).items).toHaveLength(2);
    expect((await radarStream(access, alice, { state: 'done' })).items).toHaveLength(1);
    // A caller-supplied tag cannot widen the saved query past its own tags.
    expect((await radarStream(access, alice, { tag: 'nothing-tagged-this' })).items).toHaveLength(
      0,
    );
  });
});

describe.skipIf(!hasDatabase)('the drop box (real postgres)', () => {
  beforeAll(async () => {
    await runMigrations();
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  it('is created once and returned every time after', async () => {
    const carol = await makeUser('carol');
    const first = await ensureDropBox(carol);
    const second = await ensureDropBox(carol);
    expect(second.id).toBe(first.id);
    expect(first.isDropBox).toBe(true);
  });

  it('survives being asked for concurrently, because the index decides', async () => {
    // Two captures racing on first use both try to create one. The partial
    // unique index picks a winner and the loser reads it back.
    const dave = await makeUser('dave');
    const results = await Promise.all([
      ensureDropBox(dave),
      ensureDropBox(dave),
      ensureDropBox(dave),
    ]);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);

    const rows = await getDb()
      .select()
      .from(schema.radars)
      .where(eq(schema.radars.ownerId, dave.user.id));
    expect(rows.filter((r) => r.isDropBox)).toHaveLength(1);
  });

  it('is an ordinary radar you can capture into', async () => {
    const erin = await makeUser('erin');
    const dropBox = await ensureDropBox(erin);
    const blip = await createBlip(erin, dropBox.id, { body: 'dentist tuesday 3pm #appointment' });
    expect(blip.tags).toEqual(['appointment']);
    expect(blip.state).toBe('inbox');
  });

  it('narrows to the unhandled pile in SQL, so a sorted drop box pages honestly', async () => {
    // What `read_drop_box` depends on. Filtering *after* paging meant a drop box
    // that had mostly been sorted returned a nearly empty page **and** a cursor:
    // an agent reads that as "nothing left", stops, and leaves everything behind
    // the cursor untouched. Narrowing in SQL is what makes the page honest.
    const frank = await makeUser('frank');
    const dropBox = await ensureDropBox(frank);
    for (const body of ['handled one', 'handled two', 'handled three', 'handled four']) {
      const blip = await createBlip(frank, dropBox.id, { body });
      await updateBlip(frank, blip.id, { state: 'done' });
    }
    const live = await createBlip(frank, dropBox.id, { body: 'still needs sorting' });

    const access = await accessTo(dropBox.id, frank);
    const page = await radarStream(access, frank, {
      states: ['inbox', 'active', 'later'],
      limit: 2,
    });

    expect(page.items.map((b) => b.id)).toEqual([live.id]);
    // One unhandled blip and a limit of two: there is genuinely no more to come,
    // and saying so is the difference between an agent finishing and stopping.
    expect(page.nextCursor).toBeNull();

    // And the handled ones are still there when explicitly asked for.
    const all = await radarStream(access, frank, { limit: 50 });
    expect(all.items).toHaveLength(5);
  });
});
