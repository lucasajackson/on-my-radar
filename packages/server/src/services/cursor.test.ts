/**
 * Page two.
 *
 * `listBlipsSchema` capped `cursor` at 200 characters. The blip cursor is
 * 208–238 characters and the threaded comment cursor is 247, so **the server
 * issued a cursor its own validator rejected**: page 2 of the radar stream, the
 * tag page, the comment thread and both public radar routes were a 400. It was
 * latent only because a page is fifty blips.
 *
 * It survived because every pagination test in this repo calls the service
 * directly and hands it `{ cursor }` as a TypeScript object, which never touches
 * zod. The keyset itself was proved total across page boundaries by
 * `ordering.test.ts`, `search.test.ts` and `discussion.test.ts` — and all three
 * passed throughout, because the boundary they cross is not the one a browser
 * crosses. So the first half of this file goes over the wire through
 * `createApp()`, deliberately, for the same reason `scopes.test.ts` does: a
 * suite that constructs its own inputs cannot catch a bug in what validates
 * them.
 *
 * The sharper half of the defect was the divergence. The MCP tools declare
 * `cursor: z.string()` with no cap at all, so an agent could page a radar that a
 * browser could not — one service, two transports, two answers, which is exactly
 * what `packages/contract` exists to make impossible. The second half of this
 * file is about that: there is now one `cursorSchema` and one decode, and both
 * are asserted to be the only ones.
 *
 * Reverting either half of the fix fails a named test here:
 *   - put `.max(200)` back on any listing schema → the five "page two" tests 400.
 *   - give any schema its own cursor rule → "every paginated schema uses the
 *     one cursor schema" fails by name.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as contract from '@onmyradar/contract';
import {
  cursorSchema,
  LIMITS,
  listBlipsSchema,
  listCommentsSchema,
  searchSchema,
  listNotificationsSchema,
} from '@onmyradar/contract';
import { createApp } from '../app.js';
import { SESSION_COOKIE, createSession } from '../auth/session.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import { createBlip } from './blips.js';
import { createComment } from './comments.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { createRadar, setVisibility } from './radars.js';

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

/* ==================================================================== */
/* One rule, stated once                                                */
/* ==================================================================== */

describe('one cursor rule, not five', () => {
  /**
   * The assertion that makes the divergence structurally impossible rather than
   * merely fixed today.
   *
   * It walks what the contract actually exports rather than a list written here,
   * so a *sixth* paginated schema added next year is covered the day it is
   * written — which is the failure mode that produced this bug. Four schemas had
   * their own copy of the rule, two of them were wrong, and nothing compared
   * them.
   *
   * Identity (`toBe`), not equivalence: two separately-built schemas that happen
   * to agree today are exactly the state this file exists to prevent.
   */
  it('every paginated schema uses the one cursor schema', () => {
    /*
     * `radarThemeSchema.cursor` is the CSS cursor keyword a radar is styled
     * with — a different thing that shares an English word. Exempt by name so
     * the exemption is visible; the assertion below fails if it is ever renamed,
     * because a stale exemption silently widens into a hole.
     */
    const notAPageCursor = new Set(['radarThemeSchema']);
    for (const name of notAPageCursor) {
      expect(Object.keys(contract)).toContain(name);
    }

    const checked: string[] = [];
    for (const [name, value] of Object.entries(contract)) {
      if (!(value instanceof z.ZodObject)) continue;
      const field: unknown = (value.shape as Record<string, unknown>)['cursor'];
      if (field === undefined) continue;
      if (notAPageCursor.has(name)) continue;
      const inner: unknown = field instanceof z.ZodOptional ? field.unwrap() : field;
      expect(inner, `${name}.cursor must be the shared cursorSchema`).toBe(cursorSchema);
      checked.push(name);
    }

    // Not a coverage number to maintain — a floor that proves the walk above
    // found something. A loop over an empty list passes, which is the other
    // shape of hollow assertion this codebase has been bitten by.
    expect(checked.sort()).toEqual([
      'activitySchema',
      'adminInventoryQuerySchema',
      'briefRevisionsSchema',
      'helpdeskThreadQuerySchema',
      'listBlipsSchema',
      'listCommentsSchema',
      'listHelpdeskRequestsSchema',
      'listNotificationsSchema',
      'promptHistorySchema',
      'recallSchema',
      'searchSchema',
    ]);
  });

  /**
   * The regression stated as a fact about lengths, so a reader who finds this
   * file in a year knows what the 200 was wrong about without running anything.
   */
  it('accepts a cursor of the length the encoders actually emit', () => {
    const uuid = '0f8fc9a2-1b3d-4c5e-8a7b-9c0d1e2f3a4b';
    // The stream keyset, at full microsecond precision — the widest it gets.
    const stream = encodeCursor({
      pinned: true,
      createdAt: '2026-08-27 03:14:15.123456+00',
      id: uuid,
      rank: 12,
      activityAt: '2026-08-27 03:14:15.123456+00',
      score: '0.0123456',
    });
    // The threaded comment keyset.
    const thread = encodeCursor({
      rootCreatedAt: '2026-08-27 03:14:15.123456+00',
      rootId: uuid,
      createdAt: '2026-08-27 03:14:15.123456+00',
      id: uuid,
    });

    expect(stream.length).toBeGreaterThan(200);
    expect(thread.length).toBeGreaterThan(200);
    for (const schema of [listBlipsSchema, listCommentsSchema, searchSchema]) {
      expect(schema.safeParse({ cursor: stream }).success).toBe(true);
      expect(schema.safeParse({ cursor: thread }).success).toBe(true);
    }
    // Whole seconds too: Postgres renders `.000000` as nothing, and the shorter
    // cursor that produces is *still* 208 characters. There was no timestamp for
    // which the old cap worked.
    const wholeSecond = encodeCursor({
      pinned: false,
      createdAt: '2026-08-27 03:14:15+00',
      id: uuid,
      rank: 0,
      activityAt: '2026-08-27 03:14:15+00',
      score: '0',
    });
    expect(wholeSecond.length).toBeGreaterThan(200);
    expect(listBlipsSchema.safeParse({ cursor: wholeSecond }).success).toBe(true);
  });

  it('refuses what is not a cursor rather than starting again at page one', () => {
    // A cursor that quietly means "the beginning" makes a paging loop run for
    // ever, so `null` here becomes a 400 at every call site.
    expect(decodeCursor('not a cursor')).toBeNull();
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor(Buffer.from('7', 'utf8').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('null', 'utf8').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('[1,2]', 'utf8').toString('base64url'))).toBeNull();
    expect(decodeCursor('a'.repeat(LIMITS.cursor + 1))).toBeNull();
    expect(decodeCursor(encodeCursor({ createdAt: 'x', id: 'y' }))).toEqual({
      createdAt: 'x',
      id: 'y',
    });
  });

  /**
   * The transports cannot disagree, stated as the property rather than as a
   * promise about `mcp/server.ts`.
   *
   * The MCP tools declare `cursor: z.string()`, which is *more* permissive than
   * the contract — so if the rule lived only in the REST schemas the divergence
   * would still be there. It does not: `decodeCursor` applies `cursorSchema` on
   * the path both transports take, so an input the browser is refused at the
   * edge is refused in the service too, whatever carried it.
   */
  it('the service refuses exactly what the contract refuses', () => {
    const cases = ['a'.repeat(LIMITS.cursor + 1), 'has spaces in it', 'not+base64url/at+all=', ''];
    for (const raw of cases) {
      expect(listBlipsSchema.safeParse({ cursor: raw }).success, raw.slice(0, 24)).toBe(false);
      expect(decodeCursor(raw), raw.slice(0, 24)).toBeNull();
    }
    // And the converse, so this is not passing by refusing everything.
    const real = encodeCursor({ createdAt: 'x', id: 'y' });
    expect(listBlipsSchema.safeParse({ cursor: real }).success).toBe(true);
    expect(decodeCursor(real)).not.toBeNull();
  });

  it('the notification cursor is on the same rule even though it never broke', () => {
    // 112 characters, so it fitted under every cap it was ever given. It is here
    // because "it happens to fit" is what the other three thought too.
    const notification = encodeCursor({
      createdAt: new Date().toISOString(),
      id: '0f8fc9a2-1b3d-4c5e-8a7b-9c0d1e2f3a4b',
    });
    expect(listNotificationsSchema.safeParse({ cursor: notification }).success).toBe(true);
  });
});

/* ==================================================================== */
/* Page two, over the wire                                              */
/* ==================================================================== */

describe.skipIf(!hasDatabase)('page two survives the boundary a browser crosses', () => {
  let lucas: Actor;
  let app: ReturnType<typeof createApp>;
  let cookie: string;
  let radarId: string;
  let publicSlug: string;
  let blipId: string;

  beforeAll(async () => {
    await runMigrations();
    lucas = await makeUser('cursor-lucas');
    app = createApp();
    cookie = `${SESSION_COOKIE}=${(await createSession(lucas.user)).token}`;

    const radar = await createRadar(lucas, { name: `Cursor ${Math.random()}` });
    radarId = radar.id;
    // Two blips and `limit=1` rather than fifty-one blips and the default page
    // size. The cursor's length is a function of the keyset, not of the row
    // count, so this crosses the identical boundary in two round trips instead
    // of fifty-one — and the whole point is that the boundary is what was never
    // exercised, not that it is expensive to reach.
    const first = await createBlip(lucas, radarId, { body: 'first #paging' });
    await createBlip(lucas, radarId, { body: 'second #paging' });
    blipId = first.id;

    await createComment(lucas, blipId, { body: 'one' });
    await createComment(lucas, blipId, { body: 'two' });

    const published = await setVisibility(lucas, radarId, 'public');
    if (!published.publicSlug) throw new Error('publishing returned no slug');
    publicSlug = published.publicSlug;
  }, 60_000);

  afterAll(async () => {
    await closeDb();
  });

  /** Fetch page 1, assert the server issued a cursor, then hand it straight back. */
  async function pageTwo(path: string, headers: Record<string, string> = {}) {
    const sep = path.includes('?') ? '&' : '?';
    const one = await app.request(`${path}${sep}limit=1`, { headers });
    expect(one.status, `page 1 of ${path}`).toBe(200);
    const body = (await one.json()) as { nextCursor: string | null; items: unknown[] };
    expect(body.nextCursor, `${path} issued no cursor to test`).toBeTruthy();
    const cursor = body.nextCursor as string;

    const two = await app.request(`${path}${sep}limit=1&cursor=${encodeURIComponent(cursor)}`, {
      headers,
    });
    return { cursor, status: two.status, body: (await two.json()) as { items?: unknown[] } };
  }

  it('the radar stream pages', async () => {
    const { cursor, status, body } = await pageTwo(`/api/radars/${radarId}/blips`, { cookie });
    // Named so the failure says what it means: this is a 400 the moment any cap
    // below the real cursor length comes back.
    expect(cursor.length).toBeGreaterThan(200);
    expect(status).toBe(200);
    expect(body.items).toHaveLength(1);
  });

  it('the tag page pages', async () => {
    const { status, body } = await pageTwo(`/api/radars/${radarId}/blips?tag=paging`, { cookie });
    expect(status).toBe(200);
    expect(body.items).toHaveLength(1);
  });

  it('cross-radar search pages', async () => {
    const { status } = await pageTwo(`/api/blips?tag=paging`, { cookie });
    expect(status).toBe(200);
  });

  it('the comment thread pages', async () => {
    const { cursor, status, body } = await pageTwo(`/api/blips/${blipId}/comments`, { cookie });
    // The threaded cursor is the longer of the two: it carries the root keys as
    // well as the comment's own.
    expect(cursor.length).toBeGreaterThan(200);
    expect(status).toBe(200);
    expect(body.items).toHaveLength(1);
  });

  it('a public radar pages, for a reader with no account at all', async () => {
    const { status, body } = await pageTwo(`/api/public/radars/${publicSlug}/blips`);
    expect(status).toBe(200);
    expect(body.items).toHaveLength(1);
  });

  it('a public thread pages', async () => {
    const { status } = await pageTwo(`/api/public/radars/${publicSlug}/blips/${blipId}/comments`);
    expect(status).toBe(200);
  });

  it('a well-formed cursor with keys Postgres cannot cast is a 400, not a 500', async () => {
    const good = { createdAt: '2026-01-01 00:00:00.123456+00', id: blipId };
    const forged: Array<[string, Record<string, unknown>]> = [
      ['stream: id not a uuid', { ...good, id: 'nope' }],
      ['stream: a date that is not one', { ...good, createdAt: 'yesterday-ish' }],
      ['stream: 30 February', { ...good, createdAt: '2026-02-30 00:00:00+00' }],
      ['stream: score not a number', { ...good, score: 'x' }],
      ['stream: fractional rank', { ...good, rank: 1.5 }],
      ['stream: activity not a date', { ...good, activityAt: 'soon' }],
    ];
    const paths = [
      `/api/radars/${radarId}/blips?order=discussion&`,
      `/api/public/radars/${publicSlug}/blips?`,
      `/api/blips?q=first&`,
    ];
    for (const [label, payload] of forged) {
      for (const path of paths) {
        const res = await app.request(
          `${path}cursor=${encodeURIComponent(encodeCursor(payload))}`,
          { headers: { cookie } },
        );
        expect(res.status, `${label} on ${path}`).toBe(400);
      }
    }
    for (const [label, payload] of [
      ['thread: id not a uuid', { ...good, id: 'y' }],
      ['thread: root not a date', { ...good, rootCreatedAt: 'x', rootId: blipId }],
      ['thread: root id not a uuid', { ...good, rootCreatedAt: good.createdAt, rootId: 'z' }],
    ] as const) {
      for (const path of [
        `/api/blips/${blipId}/comments`,
        `/api/public/radars/${publicSlug}/blips/${blipId}/comments`,
      ]) {
        const res = await app.request(
          `${path}?cursor=${encodeURIComponent(encodeCursor(payload))}`,
          {
            headers: { cookie },
          },
        );
        expect(res.status, `${label} on ${path}`).toBe(400);
      }
    }
    for (const [label, payload] of [
      ['notifications: id not a uuid', { ...good, id: 'x' }],
      ['notifications: a date that is not one', { ...good, createdAt: 'soon' }],
    ] as const) {
      const res = await app.request(
        `/api/notifications?cursor=${encodeURIComponent(encodeCursor(payload))}`,
        { headers: { cookie } },
      );
      expect(res.status, label).toBe(400);
    }
    // The control: the keys the encoder writes are accepted.
    const ok = await app.request(
      `/api/radars/${radarId}/blips?cursor=${encodeURIComponent(encodeCursor(good))}`,
      { headers: { cookie } },
    );
    expect(ok.status).toBe(200);
    const inbox = await app.request(
      `/api/notifications?cursor=${encodeURIComponent(encodeCursor(good))}`,
      { headers: { cookie } },
    );
    expect(inbox.status).toBe(200);
  });

  it('a cursor that is not one is a 400, not a silent restart', async () => {
    const res = await app.request(`/api/radars/${radarId}/blips?cursor=${'a'.repeat(2000)}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(400);
  });
});
