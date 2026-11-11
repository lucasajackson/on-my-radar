/**
 * What actually makes a template different from the stream, against a real Postgres.
 *
 * Three templates were shipped on the `stream` layout with nothing separating
 * them but the words in a dropdown, and it showed: reading list, decision log
 * and stream read identically, because they *were* identical. The distinctions
 * below are the ones that are real — they change which row comes back first, and
 * what a captured body turns into — so this is the suite that stops them
 * quietly collapsing back into each other.
 *
 * Ordering has to be checked against a real database: the lane rank is a CASE
 * expression inside a row-value keyset comparison, and whether that comparison
 * is *total* — never duplicating, never skipping a row across a page boundary —
 * is a property of Postgres, not of TypeScript.
 *
 * A few of these carry an explicit 30s timeout. They are the ones that make many
 * sequential round trips on purpose — seven captures, then paging across four
 * page boundaries — because whether the keyset is total is only observable
 * across a boundary. That is genuinely more work than the default 5s budget
 * assumes, and a timeout dressed up as a failed assertion is the worst kind of
 * flake to debug.
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
import { createBlip, deleteBlip, radarStream, updateBlip } from './blips.js';
import { createRadar } from './radars.js';

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

async function accessTo(radarId: string, actor: Actor) {
  const access = await getRadarAccess(radarId, actor);
  if (!access) throw new Error('radar vanished');
  return access;
}

/**
 * Capture times are set explicitly rather than by sleeping. Everything here
 * turns on the order of `created_at`, and blips captured inside the same
 * millisecond are exactly the case that made the bearing strip degenerate — a
 * test that relied on wall-clock separation would be flaky about the one thing
 * it exists to pin.
 */
async function capturedAt(blipId: string, iso: string): Promise<void> {
  await getDb()
    .update(schema.blips)
    .set({ createdAt: new Date(iso) })
    .where(eq(schema.blips.id, blipId));
}

describe.skipIf(!hasDatabase)('template order and capture (real postgres)', () => {
  let lucas: Actor;

  beforeAll(async () => {
    await runMigrations();
    lucas = await makeUser('order');
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  /* ------------------------------------------------------- reading list --- */

  describe('a reading list is a reader: newest first, whatever the lane', () => {
    it('puts the newest story at the top and does not sink what has been read', async () => {
      const radar = await createRadar(lucas, { name: 'Reader', template: 'reading' });
      const oldest = await createBlip(lucas, radar.id, { body: 'https://example.com/a' });
      const middle = await createBlip(lucas, radar.id, { body: 'https://example.com/b' });
      const newest = await createBlip(lucas, radar.id, { body: 'https://example.com/c' });
      await capturedAt(oldest.id, '2026-01-01T00:00:00Z');
      await capturedAt(middle.id, '2026-02-01T00:00:00Z');
      await capturedAt(newest.id, '2026-03-01T00:00:00Z');

      const fresh = await radarStream(await accessTo(radar.id, lucas), lucas, {});
      expect(fresh.items.map((b) => b.id)).toEqual([newest.id, middle.id, oldest.id]);

      // Reading the newest (its read lane) or finishing it moves nothing: the order is the
      // capture date alone, so a story does not jump when it is opened.
      await updateBlip(lucas, newest.id, { status: 'reading' });
      await updateBlip(lucas, middle.id, { status: 'finished' });
      const after = await radarStream(await accessTo(radar.id, lucas), lucas, {});
      expect(after.items.map((b) => b.id)).toEqual([newest.id, middle.id, oldest.id]);
    }, 30_000);

    it('keeps a pinned blip on top', async () => {
      const radar = await createRadar(lucas, { name: 'Pinned reader', template: 'reading' });
      const first = await createBlip(lucas, radar.id, { body: 'https://example.com/1' });
      const later = await createBlip(lucas, radar.id, { body: 'https://example.com/2' });
      await capturedAt(first.id, '2026-01-01T00:00:00Z');
      await capturedAt(later.id, '2026-05-01T00:00:00Z');
      await updateBlip(lucas, later.id, { pinned: true, status: 'finished' });

      const page = await radarStream(await accessTo(radar.id, lucas), lucas, {});
      // Pinned is the outermost key in every order. A pinned blip that is also
      // finished still leads, because pinning is the reader saying so out loud.
      expect(page.items[0]?.id).toBe(later.id);
    });

    it('pages through the list without duplicating or skipping a row', async () => {
      const radar = await createRadar(lucas, { name: 'Paged reader', template: 'reading' });
      const ids: string[] = [];
      for (let i = 0; i < 7; i += 1) {
        const blip = await createBlip(lucas, radar.id, { body: `https://example.com/p${i}` });
        // Deliberately identical capture times: the keyset is only total because
        // the id breaks the tie, and this is the case that proves it.
        await capturedAt(blip.id, '2026-04-04T04:04:04Z');
        ids.push(blip.id);
      }
      // Two of them in a later lane, so the rank key is exercised as well.
      await updateBlip(lucas, ids[2] as string, { status: 'reading' });
      await updateBlip(lucas, ids[5] as string, { status: 'finished' });

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 6; page += 1) {
        const result = await radarStream(await accessTo(radar.id, lucas), lucas, {
          limit: 2,
          ...(cursor ? { cursor } : {}),
        });
        seen.push(...result.items.map((b) => b.id));
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      expect(new Set(seen).size).toBe(7);
      expect(seen.sort()).toEqual([...ids].sort());
    }, 30_000);
  });

  /* ------------------------------------------------------- decision log --- */

  describe('a decision log leads with what is live', () => {
    it('sinks rejected and superseded entries below the ones still in force', async () => {
      const radar = await createRadar(lucas, { name: 'Choices', template: 'decisions' });
      const settled = await createBlip(lucas, radar.id, { body: '# Use Postgres' });
      const dropped = await createBlip(lucas, radar.id, { body: '# Use Mongo' });
      const open = await createBlip(lucas, radar.id, { body: '# Which queue?' });
      await capturedAt(settled.id, '2026-01-01T00:00:00Z');
      await capturedAt(dropped.id, '2026-02-01T00:00:00Z');
      await capturedAt(open.id, '2026-03-01T00:00:00Z');
      await updateBlip(lucas, settled.id, { status: 'accepted' });
      await updateBlip(lucas, dropped.id, { status: 'rejected' });

      const page = await radarStream(await accessTo(radar.id, lucas), lucas, {});
      // Lane order first (proposed, accepted, rejected), newest first inside it.
      // A flat reverse-chronological list would have read open, dropped, settled
      // — which is the stream, and is the complaint.
      expect(page.items.map((b) => b.id)).toEqual([open.id, settled.id, dropped.id]);
    });

    it('reads newest first inside a lane, unlike the queue', async () => {
      const radar = await createRadar(lucas, { name: 'Recency', template: 'decisions' });
      const older = await createBlip(lucas, radar.id, { body: '# First call' });
      const newer = await createBlip(lucas, radar.id, { body: '# Second call' });
      await capturedAt(older.id, '2026-01-01T00:00:00Z');
      await capturedAt(newer.id, '2026-02-01T00:00:00Z');

      const page = await radarStream(await accessTo(radar.id, lucas), lucas, {});
      expect(page.items.map((b) => b.id)).toEqual([newer.id, older.id]);
    });

    it('pages through the log without duplicating or skipping a row', async () => {
      const radar = await createRadar(lucas, { name: 'Paged log', template: 'decisions' });
      const ids: string[] = [];
      for (let i = 0; i < 7; i += 1) {
        const blip = await createBlip(lucas, radar.id, { body: `# Call ${i}` });
        await capturedAt(blip.id, '2026-04-04T04:04:04Z');
        ids.push(blip.id);
      }
      await updateBlip(lucas, ids[1] as string, { status: 'accepted' });
      await updateBlip(lucas, ids[4] as string, { status: 'superseded' });

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 6; page += 1) {
        const result = await radarStream(await accessTo(radar.id, lucas), lucas, {
          limit: 2,
          ...(cursor ? { cursor } : {}),
        });
        seen.push(...result.items.map((b) => b.id));
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      expect(new Set(seen).size).toBe(7);
      expect(seen.sort()).toEqual([...ids].sort());
    }, 30_000);
  });

  /* ------------------------------------------------------------ stream ---- */

  it('leaves the stream in capture order — it is the baseline, not a template', async () => {
    const radar = await createRadar(lucas, { name: 'Plain', template: 'stream' });
    const older = await createBlip(lucas, radar.id, { body: 'first thought' });
    const newer = await createBlip(lucas, radar.id, { body: 'second thought' });
    await capturedAt(older.id, '2026-01-01T00:00:00Z');
    await capturedAt(newer.id, '2026-02-01T00:00:00Z');

    const page = await radarStream(await accessTo(radar.id, lucas), lucas, {});
    expect(page.items.map((b) => b.id)).toEqual([newer.id, older.id]);
  });

  it('accepts a cursor issued before lane ordering existed', async () => {
    // Deployments are rolling and a cursor lives in a browser. One without a
    // `rank` field has to keep paging rather than 400.
    const radar = await createRadar(lucas, { name: 'Old cursor', template: 'stream' });
    const a = await createBlip(lucas, radar.id, { body: 'a' });
    await createBlip(lucas, radar.id, { body: 'b' });
    const legacy = Buffer.from(
      JSON.stringify({ pinned: false, createdAt: new Date().toISOString(), id: a.id }),
      'utf8',
    ).toString('base64url');
    const page = await radarStream(await accessTo(radar.id, lucas), lucas, { cursor: legacy });
    expect(page.items.length).toBeGreaterThanOrEqual(0);
  });

  /* ------------------------------------------------------- supersession --- */

  describe('supersession is the verb a decision log has and a stream does not', () => {
    it('files the replaced entry away and points the log at what replaced it', async () => {
      const radar = await createRadar(lucas, { name: 'Superseding', template: 'decisions' });
      const old = await createBlip(lucas, radar.id, { body: '# Deploy with GitOps write-back' });
      await updateBlip(lucas, old.id, { status: 'accepted' });

      const replacement = await createBlip(lucas, radar.id, {
        body: '# Deploy with the runner service account',
        supersedes: old.id,
      });
      expect(replacement.supersedes).toBe(old.id);

      // Recording the link is the only call needed: the replaced entry files
      // itself into the lane its template declares, and takes its triage state
      // with it, so the log re-sorts without a second write that could disagree.
      const page = await radarStream(await accessTo(radar.id, lucas), lucas, {});
      const replaced = page.items.find((b) => b.id === old.id);
      expect(replaced?.status).toBe('superseded');
      expect(replaced?.state).toBe('done');
      expect(replaced?.supersededBy).toEqual({
        id: replacement.id,
        title: 'Deploy with the runner service account',
      });
      // ...and it sinks below the live one, which is the point of saying it.
      expect(page.items[0]?.id).toBe(replacement.id);
    });

    it('refuses to point at a blip on another radar, without saying which case it is', async () => {
      const here = await createRadar(lucas, { name: 'Here', template: 'decisions' });
      const elsewhere = await createRadar(lucas, { name: 'Elsewhere', template: 'decisions' });
      const other = await createBlip(lucas, elsewhere.id, { body: '# Somewhere else' });

      // The message is the same for a blip that does not exist and one the
      // caller cannot see, for the same reason `requireRadar` answers 404 rather
      // than 403: `supersededBy` carries a title, so a cross-radar pointer would
      // print one out of a radar the reader has no access to.
      await expect(
        createBlip(lucas, here.id, { body: '# Replaces the other', supersedes: other.id }),
      ).rejects.toThrow(/not on "Here"/);
      await expect(
        createBlip(lucas, here.id, {
          body: '# Replaces a ghost',
          supersedes: '00000000-0000-4000-8000-000000000000',
        }),
      ).rejects.toThrow(/not on "Here"/);
    });

    it('refuses to let a blip replace itself', async () => {
      const radar = await createRadar(lucas, { name: 'Ouroboros', template: 'decisions' });
      const blip = await createBlip(lucas, radar.id, { body: '# A call' });
      await expect(updateBlip(lucas, blip.id, { supersedes: blip.id })).rejects.toThrow(
        /cannot replace itself/,
      );
    });

    it('records the link on a template with no superseded lane, and moves nothing', async () => {
      // The honest degradation: the column is universal, the lane is not.
      const radar = await createRadar(lucas, { name: 'Plain super', template: 'stream' });
      const old = await createBlip(lucas, radar.id, { body: 'the old plan' });
      const next = await createBlip(lucas, radar.id, { body: 'the new plan', supersedes: old.id });
      expect(next.supersedes).toBe(old.id);
      const page = await radarStream(await accessTo(radar.id, lucas), lucas, {});
      expect(page.items.find((b) => b.id === old.id)?.status).toBeNull();
      expect(page.items.find((b) => b.id === old.id)?.supersededBy?.id).toBe(next.id);
    });

    it('cuts the link in both directions when a blip moves radars', async () => {
      const from = await createRadar(lucas, { name: 'From', template: 'decisions' });
      const to = await createRadar(lucas, { name: 'To', template: 'decisions' });
      const old = await createBlip(lucas, from.id, { body: '# Old call' });
      const next = await createBlip(lucas, from.id, { body: '# New call', supersedes: old.id });

      // Outbound: the blip that did the replacing leaves.
      const moved = await updateBlip(lucas, next.id, { radarId: to.id });
      expect(moved.supersedes).toBeNull();

      // Inbound: and the one it replaced no longer claims a replacement that
      // now lives somewhere the reader may not be able to see.
      const back = await radarStream(await accessTo(from.id, lucas), lucas, {});
      expect(back.items.find((b) => b.id === old.id)?.supersededBy).toBeNull();
    });

    it('clears the link on request without un-filing the blip it pointed at', async () => {
      const radar = await createRadar(lucas, { name: 'Cleared', template: 'decisions' });
      const old = await createBlip(lucas, radar.id, { body: '# Original' });
      const next = await createBlip(lucas, radar.id, { body: '# Replacement', supersedes: old.id });

      const cleared = await updateBlip(lucas, next.id, { supersedes: null });
      expect(cleared.supersedes).toBeNull();
      // What happened to the old blip is its own record. Reversing it as a side
      // effect of an edit over here is the "two writes that can disagree"
      // failure the lane/state repair exists to prevent.
      const page = await radarStream(await accessTo(radar.id, lucas), lucas, {});
      expect(page.items.find((b) => b.id === old.id)?.status).toBe('superseded');
    });

    it('survives the replacement being deleted, keeping the record and dropping the pointer', async () => {
      const radar = await createRadar(lucas, { name: 'Deleted', template: 'decisions' });
      const old = await createBlip(lucas, radar.id, { body: '# Stays' });
      const next = await createBlip(lucas, radar.id, { body: '# Goes', supersedes: old.id });
      await deleteBlip(lucas, next.id);

      // ON DELETE SET NULL, not CASCADE: deleting the decision that replaced an
      // older one must never delete the older one.
      const page = await radarStream(await accessTo(radar.id, lucas), lucas, {});
      expect(page.items.map((b) => b.id)).toEqual([old.id]);
      expect(page.items[0]?.supersededBy).toBeNull();
    });
  });

  /* ----------------------------------------------------- link-first capture */

  describe('capture infers what the template is for', () => {
    it('pulls the link out of a reading-list body that also says why', async () => {
      const radar = await createRadar(lucas, { name: 'Link first', template: 'reading' });
      const blip = await createBlip(lucas, radar.id, {
        body: 'https://example.com/essay — because Ben mentioned it #reading',
      });
      expect(blip.url).toBe('https://example.com/essay');
      // The kind is what decides whether the card leads with the source. A note
      // that merely contains a URL would lose it — the same shape as the
      // bare-URL bug, one template further out.
      expect(blip.kind).toBe('link');
      expect(blip.tags).toContain('reading');
      // The body is left exactly as written. It is the note.
      expect(blip.body).toContain('because Ben mentioned it');
    });

    it('leaves a stream body alone — a note that mentions a link is still a note', async () => {
      const radar = await createRadar(lucas, { name: 'Still a note', template: 'stream' });
      const blip = await createBlip(lucas, radar.id, {
        body: 'reminded me of https://example.com/thing, worth a look',
      });
      expect(blip.url).toBeNull();
      expect(blip.kind).toBe('note');
    });

    it('still treats a bare URL as a link everywhere', async () => {
      const radar = await createRadar(lucas, { name: 'Bare', template: 'stream' });
      const blip = await createBlip(lucas, radar.id, { body: 'https://example.com/bare' });
      expect(blip.url).toBe('https://example.com/bare');
      expect(blip.kind).toBe('link');
    });

    it('lets an explicit url and kind win over the inference', async () => {
      const radar = await createRadar(lucas, { name: 'Explicit', template: 'reading' });
      const blip = await createBlip(lucas, radar.id, {
        body: 'see https://example.com/ignored',
        url: 'https://example.com/chosen',
        kind: 'quote',
      });
      expect(blip.url).toBe('https://example.com/chosen');
      expect(blip.kind).toBe('quote');
    });
  });
});
