/**
 * An id that is not a uuid is a request for something that does not exist.
 *
 * Postgres refuses to read `abc` as a uuid (`22P02`), and before this that
 * refusal reached every transport as a 500: an unauthenticated
 * `POST /hooks/not-a-uuid/x` logged at error level on every call, the body
 * outside production carried the SQL, and an agent was told "that failed on the
 * server" about its own typo. Each path below is one that did so.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createSession, SESSION_COOKIE } from './auth/session.js';
import { closeDb, getDb, schema } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import type { Actor } from './http.js';
import { guard } from './mcp/result.js';
import { createRadar, setVisibility } from './services/radars.js';
import { must } from './errors.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

describe.skipIf(!hasDatabase)('a malformed id is a 404, never a 500 (real postgres)', () => {
  let app: ReturnType<typeof createApp>;
  let cookie: string;
  let slug: string;

  beforeAll(async () => {
    await runMigrations();
    app = createApp();
    const [user] = await getDb()
      .insert(schema.users)
      .values({ email: `malformed-${Date.now()}@example.test`, state: 'active' })
      .returning();
    const actor: Actor = { user: must(user), kind: 'user' };
    cookie = `${SESSION_COOKIE}=${(await createSession(must(user))).token}`;
    const radar = await createRadar(actor, { name: `Malformed ${Math.random()}` });
    slug = must((await setVisibility(actor, radar.id, 'public')).publicSlug);
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  it('answers REST paths with a 404 and no query text', async () => {
    const paths: Array<[string, string, boolean]> = [
      ['GET', '/api/blips/nope', true],
      ['GET', '/api/blips/nope/comments', true],
      ['GET', '/api/attachments/nope', true],
      ['GET', `/api/public/radars/${slug}/attachments/nope`, false],
      ['GET', `/api/public/radars/${slug}/blips/nope/comments`, false],
      ['DELETE', '/api/tokens/nope', true],
      ['POST', '/hooks/not-a-uuid/whk_x', false],
    ];
    for (const [method, path, signedIn] of paths) {
      const res = await app.request(path, {
        method,
        headers: { ...(signedIn ? { cookie } : {}), 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      const body = await res.text();
      expect(res.status, `${method} ${path}: ${body}`).toBe(404);
      expect(body, path).not.toMatch(/select|Failed query/i);
    }
  });

  it('tells an agent the id is malformed rather than that the server failed', async () => {
    // Shaped as drizzle throws it: the driver error rides in `cause`.
    const thrown = Object.assign(new Error('Failed query: select …'), {
      cause: Object.assign(new Error('invalid input syntax for type uuid: "nope"'), {
        code: '22P02',
      }),
    });
    const result = await guard('probe', () => Promise.reject(thrown));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/not a valid id/);
    expect(result.content[0]?.text).not.toMatch(/failed on the server|select/i);
    // Control: any other database failure is still reported as ours.
    const other = await guard('probe', () =>
      Promise.reject(Object.assign(new Error('boom'), { cause: { code: '53300' } })),
    );
    expect(other.content[0]?.text).toMatch(/failed on the server/);
  });
});
