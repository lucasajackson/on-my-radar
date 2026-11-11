/**
 * The acts an agent may never perform, and the state in which it may perform
 * none of them.
 *
 * This is a **different question from scopes** and it is asserted separately for
 * that reason. `scopes.test.ts` asks how much of what a person can do was handed
 * to a connection. These are acts the person themselves may obviously do; the
 * objection is not to the power but to who is exercising it and whether anybody
 * is present to see the consequence. No arrangement of scopes answers that, and
 * a full-scope token is used throughout precisely so nothing here can pass by
 * being under-scoped.
 *
 * ## Why every one of these is written as an end-to-end refusal
 *
 * Three of these fences were documented — `docs/DESIGN.md` §17 on the cascade,
 * `docs/MCP.md` on notification settings — and enforced **only by there being no
 * MCP tool for them**. The absence of a tool is not a refusal. `attachActor` is
 * global middleware with no path restriction, so an agent token authenticates on
 * `/api/*` exactly like a session cookie, and every fence was three ordinary
 * REST calls from being walked:
 *
 *     PUT  /api/topics/<id>/cascade   {cascade: true}
 *     POST /api/topics/<id>/members   {email: <stranger>}
 *     PUT  /api/radars/<private>/topic {topicId: <id>}
 *
 * ending with a stranger reading a private radar. `walks the whole escalation
 * chain` below is that exact sequence, asserted to end in no access.
 *
 * So each test names the act, and the suite also asserts the two controls that
 * make a refusal meaningful rather than a lockout: **the same act from a
 * signed-in person still works**, and **everything an agent should still be able
 * to do still works**. A boundary with no control is indistinguishable from a
 * broken feature.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { TOKEN_SCOPES, type TokenScope } from '@onmyradar/contract';
import { createApp } from '../app.js';
import { hashSecret, newApiToken, randomToken, tokenPrefix } from '../auth/crypto.js';
import { createSession, SESSION_COOKIE } from '../auth/session.js';
import { resolveBearerToken } from '../auth/bearer.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import { getRadarAccess } from './access.js';
import { createBlip } from './blips.js';
import { createRadar, shareRadar } from './radars.js';
import { createTopic, setCascade, setRadarTopic, shareTopic } from './topics.js';
import { setRadarLevel, updateSettings } from './notifications.js';
import { subscribePush, unsubscribePush } from './push.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

async function makeUser(label: string, state = 'active'): Promise<Actor> {
  const [user] = await getDb()
    .insert(schema.users)
    .values({
      email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      state: state as 'active',
    })
    .returning();
  if (!user) throw new Error('user insert returned no row');
  return { user, kind: 'user' };
}

async function mintPat(human: Actor, scope?: string): Promise<string> {
  const secret = newApiToken();
  await getDb()
    .insert(schema.apiTokens)
    .values({
      userId: human.user.id,
      name: `boundary ${Math.random()}`,
      prefix: tokenPrefix(secret),
      tokenHash: hashSecret(secret),
      ...(scope === undefined ? {} : { scope }),
    });
  return secret;
}

/** The actor the middleware would build for a token at these scopes. */
async function agentOn(human: Actor, scopes: readonly TokenScope[]): Promise<Actor> {
  const bearer = await resolveBearerToken(await mintPat(human, scopes.join(' ')));
  if (!bearer) throw new Error('the token this test just minted does not resolve');
  return {
    user: bearer.user,
    kind: 'agent',
    tokenId: bearer.tokenId,
    scopes: bearer.scopes,
    ceiling: bearer.ceiling,
  };
}

const message = (err: unknown) => (err as Error).message;

async function refusal(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a refusal, but the call succeeded');
}

describe.skipIf(!hasDatabase)('what an agent may never do (real postgres)', () => {
  let alice: Actor;
  let mallory: Actor;
  let eve: Actor;
  /** Full scopes throughout: nothing here may pass for being under-scoped. */
  let agent: Actor;

  beforeAll(async () => {
    await runMigrations();
    alice = await makeUser('ab-alice');
    mallory = await makeUser('ab-mallory');
    eve = await makeUser('ab-eve');
    agent = await agentOn(alice, TOKEN_SCOPES);
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  /* ------------------------------ the cascade ----------------------------- */

  it('cannot turn a cascade on, in either the service or any transport', async () => {
    const topic = await createTopic(alice, { name: `On ${Math.random()}` });
    const err = await refusal(() => setCascade(agent, topic.id, true));
    expect(message(err)).toMatch(/widest single access change/);
    // The control: it is the connection that is refused, not the act.
    await expect(setCascade(alice, topic.id, true)).resolves.toMatchObject({ cascade: true });
  });

  it('cannot turn a cascade off either — revoking access is as bad as granting it', async () => {
    const topic = await createTopic(alice, { name: `Off ${Math.random()}` });
    await setCascade(alice, topic.id, true);
    expect(message(await refusal(() => setCascade(agent, topic.id, false)))).toMatch(
      /take access away/,
    );
    await expect(setCascade(alice, topic.id, false)).resolves.toMatchObject({ cascade: false });
  });

  it('cannot share a topic that cascades, but may share one that does not', async () => {
    const grouping = await createTopic(alice, { name: `Grouping ${Math.random()}` });
    // A grant on a non-cascading topic conveys the grouping and no radar at all,
    // which is strictly weaker than sharing a radar — refusing it would be
    // theatre, and this assertion is what stops the fence being widened by
    // accident later.
    await expect(
      shareTopic(agent, grouping.id, mallory.user.email, 'viewer'),
    ).resolves.toMatchObject({ status: 'added' });

    const cascading = await createTopic(alice, { name: `Cascading ${Math.random()}` });
    await setCascade(alice, cascading.id, true);
    expect(
      message(await refusal(() => shareTopic(agent, cascading.id, eve.user.email, 'viewer'))),
    ).toMatch(/every radar in the array/);
    await expect(shareTopic(alice, cascading.id, eve.user.email, 'viewer')).resolves.toMatchObject({
      status: 'added',
    });
  });

  it('may file into a cascading topic nobody else is in, but not one with members', async () => {
    // The line is drawn where the act changes class. An empty cascading topic
    // grants nobody anything, so filing into it is still organising.
    const empty = await createTopic(alice, { name: `Empty ${Math.random()}` });
    await setCascade(alice, empty.id, true);
    const r1 = await createRadar(alice, { name: `Filed ${Math.random()}` });
    await expect(setRadarTopic(agent, r1.id, empty.id)).resolves.toMatchObject({
      topicId: empty.id,
    });

    const peopled = await createTopic(alice, { name: `Peopled ${Math.random()}` });
    await shareTopic(alice, peopled.id, mallory.user.email, 'viewer');
    await setCascade(alice, peopled.id, true);
    const r2 = await createRadar(alice, { name: `Refused ${Math.random()}` });
    expect(message(await refusal(() => setRadarTopic(agent, r2.id, peopled.id)))).toMatch(
      /sharing decision rather than an organising one/,
    );
    await expect(setRadarTopic(alice, r2.id, peopled.id)).resolves.toMatchObject({
      topicId: peopled.id,
    });
  });

  it('walks the whole escalation chain and ends with the stranger holding nothing', async () => {
    // The reviewer's exact sequence, in one property. Each step is attempted
    // whether or not the last one succeeded, because the assertion that matters
    // is the *end state* — a fence that merely moves the failure one call later
    // would pass a per-step test and fail this one.
    const topic = await createTopic(alice, { name: `Chain ${Math.random()}` });
    const radar = await createRadar(alice, { name: `Private ${Math.random()}` });
    await createBlip(alice, radar.id, { body: 'private canary' });

    await setCascade(agent, topic.id, true).catch(() => undefined);
    await shareTopic(agent, topic.id, mallory.user.email, 'editor').catch(() => undefined);
    await setRadarTopic(agent, radar.id, topic.id).catch(() => undefined);

    const reached = await getRadarAccess(radar.id, mallory);
    expect(reached?.canRead ?? false).toBe(false);
    expect(reached?.role ?? null).toBeNull();
  });

  /* ------------------------- handing a radar over ------------------------- */

  it("cannot grant 'owner' on a radar, which is handing it over rather than sharing it", async () => {
    const radar = await createRadar(alice, { name: `Handover ${Math.random()}` });

    // `owner` in radar_members is canManage: publish, re-share, and delete.
    expect(
      message(await refusal(() => shareRadar(agent, radar.id, mallory.user.email, 'owner'))),
    ).toMatch(/handing the radar over/);

    // The two reversible halves stay an agent's job, which is the whole point of
    // drawing the line at 'owner' rather than at sharing.
    await expect(shareRadar(agent, radar.id, mallory.user.email, 'editor')).resolves.toMatchObject({
      role: 'editor',
    });
    await expect(shareRadar(agent, radar.id, eve.user.email, 'viewer')).resolves.toMatchObject({
      role: 'viewer',
    });
    // And a person may still do it.
    await expect(shareRadar(alice, radar.id, mallory.user.email, 'owner')).resolves.toMatchObject({
      role: 'owner',
    });
  });

  /* --------------------------- being interrupted -------------------------- */

  it('cannot touch how the user is notified — the switches, the level, or a device', async () => {
    // `docs/MCP.md` promises this outright. It was kept by there being no MCP
    // tool, which left every one of these reachable over REST.
    const radar = await createRadar(alice, { name: `Loud ${Math.random()}` });

    expect(message(await refusal(() => updateSettings(agent, { emailEnabled: false })))).toMatch(
      /control over being interrupted/,
    );
    expect(message(await refusal(() => setRadarLevel(agent, radar.id, 'none')))).toMatch(
      /being interrupted/,
    );
    expect(
      message(
        await refusal(() => unsubscribePush(agent, 'https://fcm.googleapis.com/fcm/send/probe')),
      ),
    ).toMatch(/belongs to one browser/);
    expect(
      message(
        await refusal(() =>
          subscribePush(agent, {
            endpoint: 'https://fcm.googleapis.com/fcm/send/probe2',
            keys: { p256dh: 'x', auth: 'y' },
          }),
        ),
      ),
    ).toMatch(/registered by their signed-in user/);

    await expect(updateSettings(alice, { emailEnabled: false })).resolves.toBeUndefined();
    await expect(setRadarLevel(alice, radar.id, 'none')).resolves.toBeUndefined();
  });
});

/* ===================== suspension reaches every credential ================ */

describe.skipIf(!hasDatabase)('suspension revokes tokens too (real postgres)', () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    await runMigrations();
    app = createApp();
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  async function setState(actor: Actor, state: 'active' | 'suspended' | 'pending') {
    await getDb().update(schema.users).set({ state }).where(eq(schema.users.id, actor.user.id));
  }

  /**
   * Suspension has always deleted session rows and never touched tokens, so a
   * suspended account's agent kept reading indefinitely. Enforced at resolution
   * rather than by revoking the rows, because a PAT has to survive an
   * unsuspension — the human deliberately connected that agent.
   */
  it('a suspended account’s PAT stops resolving, and resolves again when reinstated', async () => {
    const user = await makeUser('sus-pat');
    const secret = await mintPat(user);
    expect(await resolveBearerToken(secret)).not.toBeNull();

    await setState(user, 'suspended');
    expect(await resolveBearerToken(secret)).toBeNull();

    await setState(user, 'active');
    expect(await resolveBearerToken(secret)).not.toBeNull();
  });

  it('a never-approved account’s token does not resolve either', async () => {
    const user = await makeUser('sus-pending');
    const secret = await mintPat(user);
    await setState(user, 'pending');
    expect(await resolveBearerToken(secret)).toBeNull();
  });

  it('a suspended account’s OAuth access token stops resolving', async () => {
    const user = await makeUser('sus-oauth');
    const access = randomToken(32);
    await getDb()
      .insert(schema.oauthTokens)
      .values({
        accessTokenHash: hashSecret(access),
        clientId: 'omr_client_suspend',
        userId: user.user.id,
        scope: TOKEN_SCOPES.join(' '),
        scopeConsented: true,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    expect(await resolveBearerToken(access)).not.toBeNull();
    await setState(user, 'suspended');
    expect(await resolveBearerToken(access)).toBeNull();
  });

  /**
   * The half that would otherwise leave the credential alive. Rotation writes a
   * fresh row with a fresh `created_at`, so the refresh window restarts on every
   * call — without a state check a suspended account's client keeps a working
   * grant for as long as anything keeps refreshing it.
   */
  it('a suspended account cannot refresh, so the grant does not outlive the suspension', async () => {
    const user = await makeUser('sus-refresh');
    const refresh = randomToken(32);
    await getDb()
      .insert(schema.oauthTokens)
      .values({
        accessTokenHash: hashSecret(randomToken(32)),
        refreshTokenHash: hashSecret(refresh),
        clientId: 'omr_client_refresh',
        userId: user.user.id,
        scope: TOKEN_SCOPES.join(' '),
        scopeConsented: true,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    await setState(user, 'suspended');

    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }).toString(),
    });
    expect(res.status).toBe(400);
    // `Response.json()` is typed `unknown`, honestly — nothing about a Response
    // says what came back. This is an OAuth error body, not the API's
    // `{ error: { code, message } }` envelope.
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('invalid_grant');
  });

  /**
   * `/api/blips/:id/comments` and `/api/attachments/:id` serve an anonymous
   * caller and a signed-in one through one code path, so they take the actor
   * without `requireActor`. A suspended session therefore arrived as a
   * fully-formed actor and was authorized on its memberships.
   */
  it('a suspended session reads a shared radar’s thread as a stranger, not as a member', async () => {
    const owner = await makeUser('sus-owner');
    const member = await makeUser('sus-member');
    const radar = await createRadar(owner, { name: `Thread ${Math.random()}` });
    await shareRadar(owner, radar.id, member.user.email, 'viewer');
    const blip = await createBlip(owner, radar.id, { body: 'members only' });
    const cookie = `${SESSION_COOKIE}=${(await createSession(member.user)).token}`;

    const before = await app.request(`/api/blips/${blip.id}/comments`, { headers: { cookie } });
    expect(before.status).toBe(200);

    await setState(member, 'suspended');
    const after = await app.request(`/api/blips/${blip.id}/comments`, { headers: { cookie } });
    // 404, not 403: the radar is private, and a caller who may not read one is
    // told it does not exist. Same rule as everywhere else.
    expect(after.status).toBe(404);
  });
});
