/**
 * Token scopes: the properties that decide whether a consent screen is telling
 * the truth.
 *
 * The bug this suite exists for is not that the check was wrong — it is that
 * there was no check. `resolveBearerToken` computed a scope for every bearer
 * token and `attachActor` discarded it, so every connected agent acted at the
 * full breadth of its human's access no matter what the grant said. A test that
 * asserted "a `radars:read` token can read" would have passed happily throughout
 * that entire period, which is precisely how it shipped.
 *
 * So every assertion here is written as a **refusal that must happen**, and each
 * one names what would be true if the enforcement were absent:
 *
 * - **The clamp only ever weakens.** A token cannot exceed its human. If the
 *   `min` were ever written as a union, an agent on a `radars:manage` token
 *   would gain `owner` on a radar where its human holds `viewer`. Asserted
 *   directly, on a shared radar, in both directions.
 * - **The refusals bite at every rung.** read cannot write, write cannot manage,
 *   manage can do the five shipped tools that live above `editor`. That last one
 *   is the regression guard: capping every agent at `editor` would have been the
 *   simpler fix, and it would silently have removed `delete_radar`,
 *   `set_radar_visibility`, `share_radar`, `create_webhook` and `delete_webhook`
 *   from production.
 * - **What the list says is what the write does.** `listRadars` computes the
 *   union a second time, in SQL, for the sidebar. If only `getRadarAccess` were
 *   clamped, the list would advertise `canWrite` on radars the connection cannot
 *   write to — the MCP-disagrees-with-REST divergence happening inside one
 *   service. Asserted as an equality between the two, not as two separate facts.
 * - **A ceiling cannot be raised by an HTTP call.** Minting a PAT and approving
 *   an OAuth consent both issue credentials. If either were reachable with a
 *   bearer token, a `radars:read` connection would simply hand itself a full one
 *   and every other assertion in this file would be theatre.
 * - **Nothing that is live today stops working.** A PAT minted before the scope
 *   column existed, and an OAuth grant whose scope string was never displayed to
 *   anybody, both keep the access they have. Asserted against rows written the
 *   way the migration leaves them, not against rows the current code writes.
 *
 * The HTTP half goes through `createApp()` rather than calling services
 * directly, because the discarded scope lived in the middleware: a suite that
 * only ever built `Actor` objects by hand could not have caught the original bug
 * and cannot catch its return.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ceilingFor,
  parseScopes,
  TOKEN_SCOPES,
  DEFAULT_TOKEN_SCOPES,
  type RadarRole,
  type TokenScope,
} from '@onmyradar/contract';
import { createApp } from '../app.js';
import { hashSecret, newApiToken, randomToken, tokenPrefix } from '../auth/crypto.js';
import { createSession, SESSION_COOKIE } from '../auth/session.js';
import { resolveBearerToken } from '../auth/bearer.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import { canParticipate, clampRole, getRadarAccess, requireRadar } from './access.js';
import { createBlip, getBlip } from './blips.js';
import { createComment } from './comments.js';
import { setReaction } from './reactions.js';
import {
  createRadar,
  deleteRadar,
  listRadars,
  setVisibility,
  shareRadar,
  updateRadar,
} from './radars.js';
import { createTopic, setCascade, setRadarTopic, shareTopic } from './topics.js';
import { createWebhook, deleteWebhook } from './webhooks.js';
import { markRead } from './notifications.js';
import { createDashboard } from './dashboards.js';
import { searchBlips } from './search.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

/* ========================== the pure vocabulary =========================== */

describe('the scope vocabulary', () => {
  it('keeps only what this server grants, and canonicalises the order', () => {
    expect(parseScopes('radars:write radars:read')).toEqual(['radars:read', 'radars:write']);
    // Comma-separated, repeated, and padded — all the ways a client writes it.
    expect(parseScopes('radars:read, radars:read,  radars:manage')).toEqual([
      'radars:read',
      'radars:manage',
    ]);
  });

  it('drops a scope it does not define rather than granting it', () => {
    // RFC 6749 3.3: an unknown scope is ignored, not honoured. The failure this
    // guards is a client asking for `admin` and getting it because the string
    // was stored verbatim.
    expect(parseScopes('radars:read admin openid')).toEqual(['radars:read']);
    expect(parseScopes('admin')).toEqual([]);
    expect(parseScopes('')).toEqual([]);
    expect(parseScopes(undefined)).toEqual([]);
  });

  it('takes the strongest scope as the ceiling, and nothing from an empty set', () => {
    expect(ceilingFor(['radars:read'])).toBe('viewer');
    expect(ceilingFor(['radars:read', 'radars:write'])).toBe('editor');
    expect(ceilingFor(['radars:write', 'radars:manage'])).toBe('owner');
    expect(ceilingFor([])).toBeNull();
  });

  it('never promotes a role, in any direction', () => {
    // The whole security argument is that the clamp is a `min`. If any pair here
    // came back stronger than the role that went in, an agent could exceed its
    // human.
    const roles: Array<RadarRole | null> = [null, 'viewer', 'editor', 'owner'];
    const order = (r: RadarRole | null) =>
      r === null ? -1 : ['viewer', 'editor', 'owner'].indexOf(r);
    for (const role of roles) {
      for (const ceiling of ['viewer', 'editor', 'owner'] as RadarRole[]) {
        const out = clampRole(role, ceiling);
        expect(order(out)).toBeLessThanOrEqual(order(role));
        expect(order(out)).toBeLessThanOrEqual(order(ceiling));
      }
    }
    // A ceiling can never turn "no access" into access.
    expect(clampRole(null, 'owner')).toBeNull();
  });
});

/* ============================ the enforcement ============================= */

/**
 * The error body of a refused request.
 *
 * `Response.json()` is typed `Promise<unknown>`, which is honest — nothing about
 * a `Response` says what shape came back. Reading `.error.message` straight off
 * it needed the checker to be looking the other way, which it was until this
 * file joined `tsconfig`'s `include`. One assertion of the shape here beats
 * eight casts at the call sites.
 */
async function errorOf(res: Response): Promise<{ code: string; message: string }> {
  const body = (await res.json()) as { error?: { code?: string; message?: string } };
  return { code: body.error?.code ?? '', message: body.error?.message ?? '' };
}

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

/**
 * A PAT for this person at exactly these scopes, and the actor a request
 * carrying it resolves to.
 *
 * Resolved through `resolveBearerToken` rather than assembled by hand, so the
 * actor under test is the one the middleware would build — including the
 * ceiling, which is the field the original bug dropped.
 */
async function agentOn(human: Actor, scopes: readonly TokenScope[]): Promise<Actor> {
  const secret = await mintPat(human, scopes.join(' '));
  const bearer = await resolveBearerToken(secret);
  if (!bearer) throw new Error('the token this test just minted does not resolve');
  return {
    user: bearer.user,
    kind: 'agent',
    tokenId: bearer.tokenId,
    scopes: bearer.scopes,
    ceiling: bearer.ceiling,
  };
}

/** The plaintext PAT, with `scope` written exactly as asked (or left to default). */
async function mintPat(human: Actor, scope?: string): Promise<string> {
  const secret = newApiToken();
  await getDb()
    .insert(schema.apiTokens)
    .values({
      userId: human.user.id,
      name: `scoped ${Math.random()}`,
      prefix: tokenPrefix(secret),
      tokenHash: hashSecret(secret),
      ...(scope === undefined ? {} : { scope }),
    });
  return secret;
}

const message = (err: unknown) => (err as Error).message;

/** Runs `fn` and returns the error it threw, or fails loudly if it did not. */
async function refusal(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a refusal, but the call succeeded');
}

describe.skipIf(!hasDatabase)('token scopes (real postgres)', () => {
  let lucas: Actor;
  let ada: Actor;
  let reader: Actor;
  let writer: Actor;
  let manager: Actor;

  beforeAll(async () => {
    await runMigrations();
    lucas = await makeUser('scope-lucas');
    ada = await makeUser('scope-ada');
    reader = await agentOn(lucas, ['radars:read']);
    writer = await agentOn(lucas, ['radars:read', 'radars:write']);
    manager = await agentOn(lucas, TOKEN_SCOPES);
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  /* ------------------------------ read-only ------------------------------ */

  it('a read-only token reads its human’s own radar, and cannot write to it', async () => {
    const radar = await createRadar(lucas, { name: `Read ${Math.random()}` });
    const blip = await createBlip(lucas, radar.id, { body: 'something already here' });

    // Reading is untouched: a ceiling is at least `viewer`, so the clamp can
    // never take reading away from a token that authenticated at all.
    await expect(getBlip(blip.id, reader)).resolves.toMatchObject({ id: blip.id });

    const err = await refusal(() => createBlip(reader, radar.id, { body: 'nope' }));
    expect(message(err)).toMatch(/radars:write/);
    // The person can still do it. It is the connection that was refused, not
    // the human — which is the distinction the error has to make or an agent
    // goes looking for a permission its owner already has.
    await expect(createBlip(lucas, radar.id, { body: 'yes' })).resolves.toBeTruthy();
  });

  it('a read-only token cannot take part in a conversation', async () => {
    const radar = await createRadar(lucas, { name: `Talk ${Math.random()}` });
    const blip = await createBlip(lucas, radar.id, { body: 'discuss' });

    // Participation sits *below* write for a human — a viewer may comment. For a
    // token it must not: from the token's side a comment is an outbound
    // utterance, and read-only has to mean the agent says nothing.
    expect(message(await refusal(() => createComment(reader, blip.id, { body: 'hi' })))).toMatch(
      /radars:write/,
    );
    expect(message(await refusal(() => setReaction(reader, blip.id, 'up')))).toMatch(
      /radars:write/,
    );
    await expect(createComment(writer, blip.id, { body: 'hi' })).resolves.toBeTruthy();
  });

  it('the participation predicate itself knows about the ceiling', async () => {
    // `requireParticipation` refuses a read-only connection before it ever asks
    // `canParticipate`, so this rung is asserted directly rather than through
    // the throw. It is exported, and anything that renders a "reply" control
    // from it has to get the same answer the write path would give.
    const radar = await createRadar(lucas, { name: `Predicate ${Math.random()}` });
    const readerAccess = await requireRadar(radar.id, reader, 'read');
    const writerAccess = await requireRadar(radar.id, writer, 'read');
    expect(canParticipate(readerAccess, 'comments')).toBe(false);
    expect(canParticipate(readerAccess, 'reactions')).toBe(false);
    expect(canParticipate(writerAccess, 'comments')).toBe(true);
  });

  it('a read-only token cannot create a radar, a topic or a dashboard', async () => {
    // None of these pass through `requireRadar`, so the clamp cannot reach them.
    // If `requireScope` were dropped from any one of them, a read-only agent
    // could still fill somebody's account with containers.
    expect(message(await refusal(() => createRadar(reader, { name: 'nope' })))).toMatch(
      /radars:write/,
    );
    expect(message(await refusal(() => createTopic(reader, { name: 'nope' })))).toMatch(
      /radars:write/,
    );
    expect(message(await refusal(() => createDashboard(reader, 'nope')))).toMatch(/radars:write/);
  });

  it('a read-only token cannot mark somebody’s notifications read', async () => {
    // Not a radar operation at all — it is the user's own state — but it is
    // still a write, and a connection granted read-only silently clearing a
    // badge is exactly the surprise read-only exists to prevent.
    expect(message(await refusal(() => markRead(reader, {})))).toMatch(/radars:write/);
    await expect(markRead(writer, {})).resolves.toEqual({ updated: 0 });
  });

  /* -------------------------------- write -------------------------------- */

  it('a write token captures and edits, and is refused every manage operation', async () => {
    const radar = await createRadar(lucas, { name: `Write ${Math.random()}` });
    await expect(
      createBlip(writer, radar.id, { body: 'captured by an agent' }),
    ).resolves.toBeTruthy();

    // The five shipped tools that live above `editor`. Each one is named
    // because capping agents at `editor` — the tempting simpler fix — would
    // have removed exactly these from production.
    for (const [what, run] of [
      ['delete_radar', () => deleteRadar(writer, radar.id)],
      ['set_radar_visibility', () => setVisibility(writer, radar.id, 'public', true)],
      ['share_radar', () => shareRadar(writer, radar.id, ada.user.email, 'viewer')],
      ['create_webhook', () => createWebhook(writer, radar.id, { name: 'w', format: 'auto' })],
    ] as Array<[string, () => Promise<unknown>]>) {
      const err = await refusal(run);
      expect(message(err), `${what} must need radars:manage`).toMatch(/radars:manage/);
    }
  });

  it('a manage token can do all five, which is why the scope exists', async () => {
    const radar = await createRadar(manager, { name: `Manage ${Math.random()}` });

    await expect(shareRadar(manager, radar.id, ada.user.email, 'viewer')).resolves.toBeTruthy();
    await expect(setVisibility(manager, radar.id, 'public', true)).resolves.toBeTruthy();
    const hook = await createWebhook(manager, radar.id, { name: 'w', format: 'auto' });
    await expect(deleteWebhook(manager, hook.id)).resolves.toBeUndefined();
    await expect(deleteRadar(manager, radar.id)).resolves.toBeUndefined();
  });

  /* --------------------- the clamp only ever weakens ---------------------- */

  it('a manage token cannot exceed what its human holds', async () => {
    // Ada owns it and lets Lucas in as a viewer. Lucas's *strongest* token must
    // still be a viewer there: the ceiling is a `min`, and a `min` cannot
    // promote. If the clamp were ever written as a union this is the assertion
    // that breaks.
    const radar = await createRadar(ada, { name: `Ada ${Math.random()}` });
    await shareRadar(ada, radar.id, lucas.user.email, 'viewer');

    const humanAccess = await getRadarAccess(radar.id, lucas);
    expect(humanAccess?.role).toBe('viewer');

    const agentAccess = await getRadarAccess(radar.id, manager);
    expect(agentAccess?.role).toBe('viewer');
    expect(agentAccess?.canWrite).toBe(false);
    expect(agentAccess?.canManage).toBe(false);
    await expect(requireRadar(radar.id, manager, 'write')).rejects.toThrow(/read-only/i);
  });

  it('a ceiling cannot turn no access into some access', async () => {
    // Ada's private radar, which Lucas has never been given. A clamp that
    // touched `null` would be a grant, not a cap.
    const radar = await createRadar(ada, { name: `Private ${Math.random()}` });
    expect(await getRadarAccess(radar.id, manager)).toBeNull();
    await expect(requireRadar(radar.id, manager, 'read')).rejects.toThrow(/not found/i);
  });

  /* ------------------ the list agrees with the writes -------------------- */

  it('the radar list never advertises a capability the connection does not have', async () => {
    const radar = await createRadar(lucas, { name: `Listed ${Math.random()}` });

    // `listRadars` computes the union a second time, in SQL. This is the
    // equality that stops the sidebar and the thing its buttons call from
    // drifting apart.
    const asHuman = (await listRadars(lucas)).find((r) => r.id === radar.id);
    expect(asHuman?.access.canWrite).toBe(true);
    expect(asHuman?.access.canManage).toBe(true);

    const asReader = (await listRadars(reader)).find((r) => r.id === radar.id);
    expect(asReader?.access.canRead).toBe(true);
    expect(asReader?.access.canWrite).toBe(false);
    expect(asReader?.access.canManage).toBe(false);

    const asWriter = (await listRadars(writer)).find((r) => r.id === radar.id);
    expect(asWriter?.access.canWrite).toBe(true);
    expect(asWriter?.access.canManage).toBe(false);
    // And the advertisement is honest: what the list refuses, the service
    // refuses too.
    await expect(updateRadar(writer, radar.id, { name: 'renamed' })).rejects.toThrow(
      /radars:manage/,
    );
  });

  /* --------------------------- topics compose ----------------------------- */

  it('a cascading topic is inherited through the clamp, never re-decided', async () => {
    // Ada's topic cascades `editor` to Lucas. His write token follows it up to
    // its ceiling; his read token does not, and neither can reach `manage` —
    // `CASCADE_GRANTS` has no `owner` in its range, so the clamp only removes.
    const topic = await createTopic(ada, { name: `Cascade ${Math.random()}` });
    const radar = await createRadar(ada, { name: `Inside ${Math.random()}` });
    await setRadarTopic(ada, radar.id, topic.id);
    await shareTopic(ada, topic.id, lucas.user.email, 'editor');
    await setCascade(ada, topic.id, true);

    expect((await getRadarAccess(radar.id, lucas))?.role).toBe('editor');
    expect((await getRadarAccess(radar.id, writer))?.role).toBe('editor');
    expect((await getRadarAccess(radar.id, reader))?.role).toBe('viewer');
    expect((await getRadarAccess(radar.id, manager))?.canManage).toBe(false);

    await expect(
      createBlip(writer, radar.id, { body: 'through the cascade' }),
    ).resolves.toBeTruthy();
    await expect(createBlip(reader, radar.id, { body: 'no' })).rejects.toThrow(/radars:write/);
  });

  it('a write token is refused the cascade for want of scope, before anything else', async () => {
    // Two different refusals stack here and the order matters. A `radars:write`
    // connection never reaches the cascade fence because `requireTopic(...,
    // 'manage')` has already refused it for scope — which is what keeps the
    // scope layer meaningful rather than shadowed by the boundary below it.
    const topic = await createTopic(manager, { name: `Switch ${Math.random()}` });
    expect(message(await refusal(() => setCascade(writer, topic.id, true)))).toMatch(
      /radars:manage/,
    );
  });

  /* ------------------------- search composes ------------------------------ */

  it('search narrows with the ceiling and never widens with it', async () => {
    // `readableRadarIds` is the floor every search filter narrows from. A
    // ceiling is at least `viewer`, so a scoped connection must see exactly what
    // its human sees — no more, and (the part that would be a regression) no
    // less.
    const radar = await createRadar(lucas, { name: `Searchable ${Math.random()}` });
    const word = `zephyr${Math.random().toString(36).slice(2, 8)}`;
    await createBlip(lucas, radar.id, { body: `a blip about ${word}` });

    const asHuman = await searchBlips(lucas, { q: word });
    const asAgent = await searchBlips(reader, { q: word });
    expect(asAgent.items.map((b) => b.id)).toEqual(asHuman.items.map((b) => b.id));
    expect(asAgent.items.length).toBeGreaterThan(0);
  });

  /* ---------------------- what is live keeps working ---------------------- */

  it('a PAT that predates the scope column keeps its human’s full access', async () => {
    // Written the way `0014` leaves an existing row: the column default, which
    // is the full set, because a PAT has always acted at its owner's full
    // access and no PAT ever carried a consent record to preserve.
    const secret = await mintPat(lucas);
    const bearer = await resolveBearerToken(secret);
    expect(bearer?.ceiling).toBe('owner');
    expect(bearer?.scopes).toEqual([...DEFAULT_TOKEN_SCOPES]);
  });

  it('an OAuth grant made before scopes were enforced keeps working', async () => {
    // The exact row shape the OAuth server used to write: a real scope string
    // that was never displayed to anybody, and no consent flag. Enforcing it
    // retroactively would withdraw `radars:manage` from live connections on the
    // strength of a number the user never saw.
    const legacy = randomToken(32);
    await getDb()
      .insert(schema.oauthTokens)
      .values({
        accessTokenHash: hashSecret(legacy),
        clientId: 'omr_client_legacy',
        userId: lucas.user.id,
        scope: 'radars:read radars:write',
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    expect((await resolveBearerToken(legacy))?.ceiling).toBe('owner');

    // The same string, consented to on a screen that named it, is a real limit.
    const consented = randomToken(32);
    await getDb()
      .insert(schema.oauthTokens)
      .values({
        accessTokenHash: hashSecret(consented),
        clientId: 'omr_client_new',
        userId: lucas.user.id,
        scope: 'radars:read radars:write',
        scopeConsented: true,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    expect((await resolveBearerToken(consented))?.ceiling).toBe('editor');
  });

  it('a token granting nothing this server understands does not authenticate', async () => {
    // Not "authenticates at some floor" — a grant of nothing is not a grant.
    const secret = await mintPat(lucas, 'wallet:spend');
    expect(await resolveBearerToken(secret)).toBeNull();
  });
});

/* ===================== the ceiling cannot be raised ====================== */

describe.skipIf(!hasDatabase)('credentials are session-only (real postgres)', () => {
  let lucas: Actor;
  let app: ReturnType<typeof createApp>;
  let readOnlyPat: string;
  let cookie: string;

  beforeAll(async () => {
    await runMigrations();
    lucas = await makeUser('escape-lucas');
    app = createApp();
    readOnlyPat = await mintPat(lucas, 'radars:read');
    cookie = `${SESSION_COOKIE}=${(await createSession(lucas.user)).token}`;
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  /**
   * The assertion that makes every other one in this file mean something. If a
   * read-only connection can mint a full-access PAT, its ceiling is one HTTP
   * call away from `owner` and the consent screen is decoration again.
   */
  it('a bearer token cannot mint another token', async () => {
    const res = await app.request('/api/tokens', {
      method: 'POST',
      headers: { authorization: `Bearer ${readOnlyPat}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'escape hatch' }),
    });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).message).toMatch(/signed in/i);

    // The same request from the same person in a browser works, so what was
    // refused is the connection and not the account.
    const asPerson = await app.request('/api/tokens', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'legitimate' }),
    });
    expect(asPerson.status).toBe(201);
  });

  it('a bearer token cannot approve an OAuth consent for itself', async () => {
    const res = await app.request('/oauth/authorize/decision', {
      method: 'POST',
      headers: { authorization: `Bearer ${readOnlyPat}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: 'omr_client_whatever',
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        response_type: 'code',
        code_challenge: 'x'.repeat(43),
        approve: true,
      }),
    });
    // Refused for being a token, before the client is even looked up — so the
    // refusal cannot be sidestepped by registering a client first.
    expect(res.status).toBe(403);
    expect((await errorOf(res)).message).toMatch(/signed in/i);
  });

  it('a bearer token cannot reach the admin surface', async () => {
    // No scope in `TOKEN_SCOPES` describes approving accounts or suspending
    // people, so no consent screen has ever offered it. It was reachable only
    // because the check asked what the *user* was and never what the connection
    // was. Asserted on an ordinary account too: it must fail for being a token,
    // not merely for not being an admin.
    const res = await app.request('/api/admin/users', {
      headers: { authorization: `Bearer ${readOnlyPat}` },
    });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).message).toMatch(/signed in/i);
  });

  it('a scope refusal names the scope it wanted, in the header RFC 6750 defines', async () => {
    const radar = await createRadar(lucas, { name: `Header ${Math.random()}` });
    const res = await app.request(`/api/radars/${radar.id}/blips`, {
      method: 'POST',
      headers: { authorization: `Bearer ${readOnlyPat}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'nope' }),
    });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('insufficient_scope');
    // Without this a client cannot tell "I was not granted that" from "my human
    // cannot do that", and has nothing to re-request.
    expect(res.headers.get('www-authenticate')).toBe(
      'Bearer error="insufficient_scope", scope="radars:write"',
    );
  });

  /**
   * The middleware is where the bug was: `attachActor` resolved a scope and then
   * dropped it. Every assertion below goes over the wire for that reason — a
   * suite that builds `Actor` objects by hand exercises the clamp but not the
   * thing that feeds it, and would have passed throughout the entire period the
   * scope was being discarded.
   */
  it('a read-only token is refused a manage operation over the wire', async () => {
    const radar = await createRadar(lucas, { name: `Wire ${Math.random()}` });
    const res = await app.request(`/api/radars/${radar.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${readOnlyPat}` },
    });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('insufficient_scope');
    expect(res.headers.get('www-authenticate')).toContain('scope="radars:manage"');
  });

  it('a read-only token is refused a comment over the wire', async () => {
    const radar = await createRadar(lucas, { name: `Wire talk ${Math.random()}` });
    const blip = await createBlip(lucas, radar.id, { body: 'say something' });
    const res = await app.request(`/api/blips/${blip.id}/comments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${readOnlyPat}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'hello' }),
    });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('insufficient_scope');
  });

  it('a read-only token still reads over the wire, and the list says so', async () => {
    // The other half of the property: a clamp can only ever take away, and it
    // must never take reading away from a token that authenticated at all.
    const radar = await createRadar(lucas, { name: `Wire read ${Math.random()}` });
    const one = await app.request(`/api/radars/${radar.id}`, {
      headers: { authorization: `Bearer ${readOnlyPat}` },
    });
    expect(one.status).toBe(200);
    const single = (await one.json()) as { radar: { access: unknown } };
    expect(single.radar.access).toMatchObject({ canRead: true, canWrite: false });

    const all = await app.request('/api/radars', {
      headers: { authorization: `Bearer ${readOnlyPat}` },
    });
    expect(all.status).toBe(200);
    const body = (await all.json()) as { radars: Array<{ id: string; access: unknown }> };
    const listed = body.radars.find((r) => r.id === radar.id);
    expect(listed?.access).toMatchObject({ canRead: true, canWrite: false, canManage: false });
  });

  it('the same request on a full token succeeds, so the refusal is the scope', async () => {
    const radar = await createRadar(lucas, { name: `Full ${Math.random()}` });
    const full = await mintPat(lucas);
    const res = await app.request(`/api/radars/${radar.id}/blips`, {
      method: 'POST',
      headers: { authorization: `Bearer ${full}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'captured over HTTP' }),
    });
    expect(res.status).toBe(201);
  });
});
