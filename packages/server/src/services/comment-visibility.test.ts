/**
 * Helpdesk slice 2: comment visibility (docs/HELPDESK.md §7, §9).
 *
 * Every test below is written as the leak it prevents. The threat model's paths
 * for an internal note or an unreviewed reply reaching a client, as far as they
 * exist before the portal does:
 *
 * - **By default** (T2): nothing a writer leaves unspecified is ever client-
 *   visible, on REST, MCP or the service.
 * - **Off a helpdesk** (T10): a client side exists only on a client-facing
 *   radar; `client` anywhere else is refused, so no ordinary radar grows one.
 * - **An agent publishing** (T3): an agent's reply is `client_pending`, always,
 *   however it asks; it cannot release, over REST or MCP; only the radar's owner
 *   in person can, and decision 3 says exactly that.
 * - **Release bound to content** (§7.2): the owner releases the hash of what they
 *   read; an edit after the review voids it; a released reply can never change
 *   again — and the database, not only the service, holds it to its hash.
 * - **Note becomes reply** (§7.3): an internal note is never released, and no
 *   edit can change a comment's visibility.
 * - **A move** (T1/T2): a blip carrying a client reply stays on its helpdesk.
 * - **A webhook** (§7.5): the owner's own subscriptions are told the visibility.
 *
 * And one non-rule, asserted as hard because Lucas set it (decision 5 and the
 * collaborator correction): **members keep seeing everything.** A collaborator
 * like Andrea reads internal notes, pending drafts and released replies, each
 * labelled; visibility is about who sees a comment outside On My Radar, never
 * about hiding it from the people working the radar.
 *
 * Plus slice 1's three QA minors.
 *
 * Skipped when DATABASE_URL is absent. CI sets it.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLIENT_FACING_TEMPLATE_IDS, type CommentDto } from '@onmyradar/contract';
import { createApp } from '../app.js';
import { hashSecret, newApiToken, tokenPrefix } from '../auth/crypto.js';
import { createSession, SESSION_COOKIE } from '../auth/session.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { ApiError, type Actor } from '../http.js';
import { buildMcpServer } from '../mcp/server.js';
import { endpointCoverage } from '../mcp/capabilities.js';
import { getRadarAccess } from './access.js';
import { createBlip, updateBlip } from './blips.js';
import {
  bodySha256,
  createComment,
  deleteComment,
  listComments,
  releaseComment,
  updateComment,
} from './comments.js';
import { setRadarLevel } from './notifications.js';
import {
  createRadar,
  createSmartRadar,
  rotatePublicSlug,
  setVisibility,
  shareRadar,
  updateRadar,
} from './radars.js';
import { createSubscription } from './subscriptions.js';

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

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected a refusal, got success');
}

async function row(commentId: string) {
  const [found] = await getDb()
    .select()
    .from(schema.blipComments)
    .where(eq(schema.blipComments.id, commentId));
  return found;
}

/** An agent connection acting for `human`, as a PAT or OAuth token arrives. */
function agentOf(human: Actor): Actor {
  return { ...human, kind: 'agent', ceiling: 'owner', tokenId: 'test-token' };
}

async function patFor(human: Actor): Promise<string> {
  const token = newApiToken();
  await getDb()
    .insert(schema.apiTokens)
    .values({
      userId: human.user.id,
      name: 'visibility test',
      prefix: tokenPrefix(token),
      tokenHash: hashSecret(token),
    });
  return token;
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- names the shape a caller parses
async function mcp<T>(actor: Actor, name: string, args: Record<string, unknown>) {
  const server = buildMcpServer(actor);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'visibility-test', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    return { isError: result.isError === true, text, json: () => JSON.parse(text) as T };
  } finally {
    await client.close();
  }
}

async function mcpToolNames(actor: Actor): Promise<string[]> {
  const server = buildMcpServer(actor);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'visibility-test', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
}

describe('the content hash (no database needed for the shape)', () => {
  it('is hex sha256 over UTF-8, so a body with non-ASCII text hashes the same everywhere', () => {
    expect(bodySha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(bodySha256('café — “quoted”')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe.skipIf(!hasDatabase)('comment visibility on helpdesk radars (real postgres)', () => {
  let app: ReturnType<typeof createApp>;
  let lucas: Actor;
  let andrea: Actor; // a collaborator: editor on the helpdesk
  let viewer: Actor;
  let stranger: Actor;
  let lucasCookie: string;
  let andreaCookie: string;
  let strangerCookie: string;
  let lucasPat: string;
  let helpdeskId: string;
  let kanbanId: string;

  const blipOn = async (radarId: string, body = 'Please fix the contact form') =>
    (await createBlip(lucas, radarId, { body })).id;

  const restComment = async (
    auth: { cookie?: string; bearer?: string },
    blipId: string,
    body: Record<string, unknown>,
  ) =>
    app.request(`/api/blips/${blipId}/comments`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth.cookie ? { cookie: auth.cookie } : {}),
        ...(auth.bearer ? { authorization: `Bearer ${auth.bearer}` } : {}),
      },
      body: JSON.stringify(body),
    });

  const restRelease = async (
    auth: { cookie?: string; bearer?: string },
    commentId: string,
    hash: string,
  ) =>
    app.request(`/api/comments/${commentId}/release`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth.cookie ? { cookie: auth.cookie } : {}),
        ...(auth.bearer ? { authorization: `Bearer ${auth.bearer}` } : {}),
      },
      body: JSON.stringify({ bodySha256: hash }),
    });

  beforeAll(async () => {
    await runMigrations();
    app = createApp();
    lucas = await makeUser('cv-lucas');
    andrea = await makeUser('cv-andrea');
    viewer = await makeUser('cv-viewer');
    stranger = await makeUser('cv-stranger');
    lucasCookie = `${SESSION_COOKIE}=${(await createSession(lucas.user)).token}`;
    andreaCookie = `${SESSION_COOKIE}=${(await createSession(andrea.user)).token}`;
    strangerCookie = `${SESSION_COOKIE}=${(await createSession(stranger.user)).token}`;
    lucasPat = await patFor(lucas);
    helpdeskId = (await createRadar(lucas, { name: 'Helpdesk · CV', template: 'helpdesk' })).id;
    kanbanId = (await createRadar(lucas, { name: 'Board · CV', template: 'kanban' })).id;
    await shareRadar(lucas, helpdeskId, andrea.user.email, 'editor');
    await shareRadar(lucas, helpdeskId, viewer.user.email, 'viewer');
  }, 60_000);

  afterAll(async () => {
    await closeDb();
  });

  /* ------------------------------- by default ------------------------------ */

  it('makes every comment internal unless client was asked for — service, REST and MCP', async () => {
    const blipId = await blipOn(helpdeskId);
    const viaService = await createComment(lucas, blipId, { body: 'note one' });
    const viaRest = await restComment({ cookie: lucasCookie }, blipId, { body: 'note two' });
    expect(viaRest.status).toBe(201);
    const restDto = ((await viaRest.json()) as { comment: CommentDto }).comment;
    const viaMcp = await mcp<{ id: string; visibility?: string }>(
      agentOf(lucas),
      'create_comment',
      { blipId, body: 'note three' },
    );
    expect(viaMcp.isError).toBe(false);
    const mcpId = viaMcp.json().id;
    expect(viaMcp.json().visibility).toBeUndefined();

    for (const id of [viaService.id, restDto.id, mcpId]) {
      expect((await row(id))?.visibility).toBe('internal');
    }
    expect(viaService.visibility).toBe('internal');
    expect(viaService.bodySha256).toBeUndefined();
  });

  it('refuses client_pending as a request: it is an outcome, never something a writer chooses', async () => {
    const blipId = await blipOn(helpdeskId);
    const res = await restComment({ cookie: lucasCookie }, blipId, {
      body: 'skip the review',
      visibility: 'client_pending',
    });
    expect(res.status).toBe(400);
  });

  /* ----------------------------- off a helpdesk ---------------------------- */

  it('refuses a client reply on a radar with no client side, and writes nothing', async () => {
    const blipId = await blipOn(kanbanId);
    const before = await getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.blipComments)
      .where(eq(schema.blipComments.blipId, blipId));
    const err = await refusal(
      createComment(lucas, blipId, { body: 'to the client', visibility: 'client' }),
    );
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/Only a Helpdesk radar has a client side/);
    const viaMcp = await mcp(agentOf(lucas), 'create_comment', {
      blipId,
      body: 'to the client',
      visibility: 'client',
    });
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.text).toMatch(/Only a Helpdesk radar has a client side/);
    const after = await getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.blipComments)
      .where(eq(schema.blipComments.blipId, blipId));
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  /* -------------------------- who publishes, who drafts -------------------------- */

  it('publishes the owner’s own reply at once, recording the hash of exactly what was typed', async () => {
    const blipId = await blipOn(helpdeskId);
    const res = await restComment({ cookie: lucasCookie }, blipId, {
      body: 'Fixed — the form sends once now.',
      visibility: 'client',
    });
    expect(res.status).toBe(201);
    const dto = ((await res.json()) as { comment: CommentDto }).comment;
    expect(dto.visibility).toBe('client');
    expect(dto.releasedAt).toBeTruthy();
    const stored = await row(dto.id);
    expect(stored?.releasedBy).toBe(lucas.user.id);
    expect(stored?.releasedBodySha256).toBe(bodySha256('Fixed — the form sends once now.'));
    // The Node hash and the database's are the same number — the CHECK uses this.
    const [pg] = await getDb()
      .execute<{ h: string }>(
        sql`SELECT encode(sha256(convert_to(body, 'UTF8')), 'hex') AS h FROM blip_comments WHERE id = ${dto.id}::uuid`,
      )
      .then((r) => r.rows);
    expect(pg?.h).toBe(stored?.releasedBodySha256);
  });

  it('holds an agent’s reply for review however it asks — PAT over REST, and MCP — even writing as the owner', async () => {
    const blipId = await blipOn(helpdeskId);
    const rest = await restComment({ bearer: lucasPat }, blipId, {
      body: 'Agent draft over REST',
      visibility: 'client',
    });
    expect(rest.status).toBe(201);
    const restDto = ((await rest.json()) as { comment: CommentDto }).comment;
    expect(restDto.visibility).toBe('client_pending');
    expect(restDto.bodySha256).toBe(bodySha256('Agent draft over REST'));

    const viaMcp = await mcp<{ id: string; visibility: string }>(agentOf(lucas), 'create_comment', {
      blipId,
      body: 'Agent draft over MCP',
      visibility: 'client',
      as: 'me',
    });
    expect(viaMcp.isError).toBe(false);
    expect(viaMcp.json().visibility).toBe('client_pending');

    for (const id of [restDto.id, viaMcp.json().id]) {
      const stored = await row(id);
      expect(stored?.visibility).toBe('client_pending');
      expect(stored?.releasedAt).toBeNull();
      expect(stored?.releasedBy).toBeNull();
    }
  });

  it('holds a collaborator’s reply for the owner’s review, and refuses a viewer outright', async () => {
    const blipId = await blipOn(helpdeskId);
    const fromAndrea = await createComment(andrea, blipId, {
      body: 'Andrea: we will look Monday',
      visibility: 'client',
    });
    expect(fromAndrea.visibility).toBe('client_pending');

    const err = await refusal(
      createComment(viewer, blipId, { body: 'viewer to client', visibility: 'client' }),
    );
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/needs edit access/);
    // A viewer can still join the internal conversation, as on any radar.
    const note = await createComment(viewer, blipId, { body: 'viewer note' });
    expect(note.visibility).toBe('internal');
  });

  /* ------------------------------- the release ------------------------------- */

  it('refuses a release from an agent over REST, naming the reason, and offers none over MCP', async () => {
    const blipId = await blipOn(helpdeskId);
    const draft = await createComment(agentOf(lucas), blipId, {
      body: 'Agent wants to self-release',
      visibility: 'client',
    });
    const hash = draft.bodySha256 ?? '';
    const res = await restRelease({ bearer: lucasPat }, draft.id, hash);
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/owner’s review.*never publish it/);
    const err = await refusal(releaseComment(agentOf(lucas), draft.id, { bodySha256: hash }));
    expect(err.message).toMatch(/never publish it/);
    expect((await row(draft.id))?.visibility).toBe('client_pending');

    const tools = await mcpToolNames(agentOf(lucas));
    expect(tools.filter((name) => /release/.test(name))).toEqual([]);
    expect(
      endpointCoverage.find((entry) => entry.route === 'blips:commentRoutes.post /:id/release')
        ?.reason ?? '',
    ).toMatch(/human-only/);
  });

  it('refuses a release from a collaborator (403, she can read it) and a stranger (404, they cannot)', async () => {
    const blipId = await blipOn(helpdeskId);
    const draft = await createComment(agentOf(lucas), blipId, {
      body: 'Waiting on Lucas',
      visibility: 'client',
    });
    const hash = draft.bodySha256 ?? '';
    const asAndrea = await restRelease({ cookie: andreaCookie }, draft.id, hash);
    expect(asAndrea.status).toBe(403);
    expect(await asAndrea.text()).toMatch(/Only the owner of this radar/);
    const asStranger = await restRelease({ cookie: strangerCookie }, draft.id, hash);
    expect(asStranger.status).toBe(404);
    expect((await row(draft.id))?.visibility).toBe('client_pending');
  });

  it('releases exactly the reviewed text, and refuses once the draft changed after the review', async () => {
    const blipId = await blipOn(helpdeskId);
    const agent = agentOf(lucas);
    const draft = await createComment(agent, blipId, {
      body: 'Version one',
      visibility: 'client',
    });
    const reviewed = draft.bodySha256 ?? '';
    // The agent edits after Lucas read version one.
    await updateComment({ ...lucas, viaCookie: true }, draft.id, {
      body: 'Version two, with the Garst notes',
    });

    const stale = await restRelease({ cookie: lucasCookie }, draft.id, reviewed);
    expect(stale.status).toBe(409);
    expect(await stale.text()).toMatch(/changed after you reviewed it/);
    expect((await row(draft.id))?.visibility).toBe('client_pending');

    const [current] = (await listComments(lucas, blipId)).items.filter((c) => c.id === draft.id);
    expect(current?.bodySha256).toBe(bodySha256('Version two, with the Garst notes'));
    const ok = await restRelease({ cookie: lucasCookie }, draft.id, current?.bodySha256 ?? '');
    expect(ok.status).toBe(200);
    const released = ((await ok.json()) as { comment: CommentDto }).comment;
    expect(released.visibility).toBe('client');
    const stored = await row(draft.id);
    expect(stored?.releasedBy).toBe(lucas.user.id);
    expect(stored?.releasedBodySha256).toBe(current?.bodySha256);
    expect(stored?.body).toBe('Version two, with the Garst notes');
  });

  it('never turns an internal note into a reply, and does not release twice', async () => {
    const blipId = await blipOn(helpdeskId);
    const note = await createComment(lucas, blipId, { body: 'internal: client is slow to pay' });
    const err = await refusal(
      releaseComment(lucas, note.id, { bodySha256: bodySha256(note.body) }),
    );
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/internal note/);
    expect((await row(note.id))?.visibility).toBe('internal');

    const reply = await createComment(lucas, blipId, { body: 'Done.', visibility: 'client' });
    const again = await refusal(
      releaseComment(lucas, reply.id, { bodySha256: bodySha256('Done.') }),
    );
    expect(again.status).toBe(409);
    expect(again.message).toMatch(/already released/);
  });

  it('refuses to release once the radar has left the helpdesk template', async () => {
    const radar = await createRadar(lucas, { name: 'Helpdesk · Switch', template: 'helpdesk' });
    const blipId = await blipOn(radar.id);
    const draft = await createComment(agentOf(lucas), blipId, {
      body: 'Pending while switching',
      visibility: 'client',
    });
    await updateRadar(lucas, radar.id, { template: 'kanban', templateConfig: { lanes: null } });
    const err = await refusal(
      releaseComment(lucas, draft.id, { bodySha256: draft.bodySha256 ?? '' }),
    );
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/Only a Helpdesk radar has a client side/);
    expect((await row(draft.id))?.visibility).toBe('client_pending');
  });

  /* ------------------------------- immutability ------------------------------ */

  it('refuses to edit a released reply, through the service and over REST', async () => {
    const blipId = await blipOn(helpdeskId);
    const reply = await createComment(lucas, blipId, {
      body: 'Released words',
      visibility: 'client',
    });
    const err = await refusal(
      updateComment({ ...lucas, viaCookie: true }, reply.id, { body: 'Rewritten words' }),
    );
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/released to the client/);
    const res = await app.request(`/api/comments/${reply.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: lucasCookie },
      body: JSON.stringify({ body: 'Rewritten words' }),
    });
    expect(res.status).toBe(409);
    expect((await row(reply.id))?.body).toBe('Released words');
  });

  it('cannot change visibility through an edit: the field is not part of an update', async () => {
    const blipId = await blipOn(helpdeskId);
    const note = await createComment(lucas, blipId, { body: 'a note' });
    const res = await app.request(`/api/comments/${note.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: lucasCookie },
      body: JSON.stringify({ body: 'a note, edited', visibility: 'client' }),
    });
    expect(res.status).toBe(200);
    const stored = await row(note.id);
    expect(stored?.visibility).toBe('internal');
    expect(stored?.releasedAt).toBeNull();
  });

  it('holds a released body to its hash in the database, whatever path writes it (0043 CHECKs)', async () => {
    const blipId = await blipOn(helpdeskId);
    const reply = await createComment(lucas, blipId, {
      body: 'Approved text',
      visibility: 'client',
    });
    const violates = (statement: ReturnType<typeof sql>) =>
      expect(getDb().execute(statement)).rejects.toMatchObject({ cause: { code: '23514' } });

    // An edit by hand to a released body.
    await violates(
      sql`UPDATE blip_comments SET body = 'Edited by hand' WHERE id = ${reply.id}::uuid`,
    );
    // Client-visible with nothing that put it there.
    const note = await createComment(lucas, blipId, { body: 'note' });
    await violates(sql`UPDATE blip_comments SET visibility = 'client' WHERE id = ${note.id}::uuid`);
    // A pending reply carrying a release.
    await violates(
      sql`UPDATE blip_comments SET visibility = 'client_pending', released_at = now(), released_body_sha256 = 'x' WHERE id = ${note.id}::uuid`,
    );
    // A release without the approved hash.
    await violates(
      sql`UPDATE blip_comments SET visibility = 'client', released_at = now() WHERE id = ${note.id}::uuid`,
    );
    // A release whose hash is not the body's.
    await violates(
      sql`UPDATE blip_comments SET visibility = 'client', released_at = now(), released_body_sha256 = ${bodySha256('other text')} WHERE id = ${note.id}::uuid`,
    );
    // A value outside the vocabulary.
    await violates(sql`UPDATE blip_comments SET visibility = 'public' WHERE id = ${note.id}::uuid`);
    expect((await row(reply.id))?.body).toBe('Approved text');
  });

  it('lets an owner delete a released reply (moderation) and a person discard a draft', async () => {
    const blipId = await blipOn(helpdeskId);
    const reply = await createComment(lucas, blipId, {
      body: 'Sent in error',
      visibility: 'client',
    });
    await deleteComment({ ...lucas, viaCookie: true }, reply.id);
    expect(await row(reply.id)).toBeUndefined();
    const draft = await createComment(agentOf(lucas), blipId, {
      body: 'Never mind',
      visibility: 'client',
    });
    // A sessionless token is no agent and not the person, so it cannot discard even its own draft.
    await expect(deleteComment(agentOf(lucas), draft.id)).rejects.toMatchObject({ status: 403 });
    expect(await row(draft.id)).toBeDefined();
    await deleteComment({ ...lucas, viaCookie: true }, draft.id);
    expect(await row(draft.id)).toBeUndefined();
  });

  it('survives deleting the person who released a reply they wrote (the DEFERRABLE released_by)', async () => {
    const owner = await makeUser('cv-deleted-owner');
    const radar = await createRadar(owner, { name: 'Helpdesk · Gone', template: 'helpdesk' });
    const blipId = (await createBlip(owner, radar.id, { body: 'request' })).id;
    const andreaElsewhere = await makeUser('cv-other-collab');
    await shareRadar(owner, radar.id, andreaElsewhere.user.email, 'editor');
    // The owner writes and releases their own reply, so author_id and
    // released_by name the same person on one row, and their agent drafts one
    // they release — three referential actions meeting rows the radar's
    // cascade is also deleting.
    await createComment(owner, blipId, { body: 'Owner reply', visibility: 'client' });
    const own = await createComment(agentOf(owner), blipId, {
      body: 'Agent draft',
      visibility: 'client',
    });
    await releaseComment(owner, own.id, { bodySha256: own.bodySha256 ?? '' });
    const draft = await createComment(andreaElsewhere, blipId, {
      body: 'Collaborator draft',
      visibility: 'client',
    });
    await releaseComment(owner, draft.id, { bodySha256: draft.bodySha256 ?? '' });
    // Deleting the collaborator SET NULLs their authorship on a released reply.
    await getDb().delete(schema.users).where(eq(schema.users.id, andreaElsewhere.user.id));
    const survived = await row(draft.id);
    expect(survived?.authorId).toBeNull();
    expect(survived?.visibility).toBe('client');
    await expect(
      getDb().delete(schema.users).where(eq(schema.users.id, owner.user.id)),
    ).resolves.toBeDefined();
    // The behavioural half above passes with the FK non-deferrable too on this
    // fixture (measured by sabotage, 2026-10-02): trigger order is fixture-
    // dependent, which is the 0015 lesson. So the shape is asserted directly,
    // matching every other authorship FK in the schema.
    const [fk] = await getDb()
      .execute<{ deferrable: boolean; deferred: boolean }>(
        sql`SELECT condeferrable AS deferrable, condeferred AS deferred FROM pg_constraint WHERE conname = 'blip_comments_released_by_fkey'`,
      )
      .then((r) => r.rows);
    expect(fk).toEqual({ deferrable: true, deferred: true });
  });

  /* ---------------------------------- moves --------------------------------- */

  it('keeps a blip carrying a client reply on its helpdesk, and moves one with only notes', async () => {
    const otherHelpdesk = (
      await createRadar(lucas, { name: 'Helpdesk · Other client', template: 'helpdesk' })
    ).id;
    const replied = await blipOn(helpdeskId, 'replied request');
    await createComment(lucas, replied, { body: 'Reply to client A', visibility: 'client' });
    for (const target of [otherHelpdesk, kanbanId]) {
      const err = await refusal(updateBlip(lucas, replied, { radarId: target }));
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/reply to a client on it/);
    }
    const drafted = await blipOn(helpdeskId, 'drafted request');
    await createComment(agentOf(lucas), drafted, { body: 'Draft for A', visibility: 'client' });
    expect((await refusal(updateBlip(lucas, drafted, { radarId: kanbanId }))).status).toBe(400);
    // Nothing half-moved: the thread is still where the blip is.
    const comments = await getDb()
      .select({ radarId: schema.blipComments.radarId })
      .from(schema.blipComments)
      .where(eq(schema.blipComments.blipId, replied));
    expect(comments.every((c) => c.radarId === helpdeskId)).toBe(true);

    // A blip with no conversation at all is the owner's own capture: it moves.
    const bare = await blipOn(helpdeskId, 'nothing said yet');
    expect((await updateBlip(lucas, bare, { radarId: kanbanId })).radarId).toBe(kanbanId);
  });

  /* ------------------------- members see everything ------------------------ */

  it('shows a collaborator every comment — notes, drafts and released replies — labelled, over REST and MCP', async () => {
    const blipId = await blipOn(helpdeskId);
    const note = await createComment(lucas, blipId, { body: 'INTERNAL-CANARY note' });
    const draft = await createComment(agentOf(lucas), blipId, {
      body: 'Draft reply',
      visibility: 'client',
    });
    const reply = await createComment(lucas, blipId, { body: 'Sent reply', visibility: 'client' });

    const res = await app.request(`/api/blips/${blipId}/comments`, {
      headers: { cookie: andreaCookie },
    });
    expect(res.status).toBe(200);
    const page = (await res.json()) as { items: CommentDto[] };
    const byId = new Map(page.items.map((c) => [c.id, c]));
    expect(byId.get(note.id)).toMatchObject({
      visibility: 'internal',
      body: 'INTERNAL-CANARY note',
    });
    expect(byId.get(draft.id)).toMatchObject({
      visibility: 'client_pending',
      bodySha256: bodySha256('Draft reply'),
    });
    expect(byId.get(reply.id)).toMatchObject({ visibility: 'client', body: 'Sent reply' });
    // Only the owner, in person, is offered the release — decided by the server.
    expect(byId.get(draft.id)?.canRelease).toBe(false);
    const asOwner = (await listComments(lucas, blipId)).items.find((c) => c.id === draft.id);
    expect(asOwner?.canRelease).toBe(true);
    const asAgent = (await listComments(agentOf(lucas), blipId)).items.find(
      (c) => c.id === draft.id,
    );
    expect(asAgent?.canRelease).toBe(false);

    const viaMcp = await mcp<{ comments: Array<{ id: string; visibility?: string }> }>(
      agentOf(andrea),
      'list_comments',
      { blipId },
    );
    const listed = new Map(viaMcp.json().comments.map((c) => [c.id, c.visibility]));
    expect(listed.get(note.id)).toBeUndefined();
    expect(listed.get(draft.id)).toBe('client_pending');
    expect(listed.get(reply.id)).toBe('client');

    // And she can still take part internally.
    expect((await createComment(andrea, blipId, { body: 'Andrea note' })).visibility).toBe(
      'internal',
    );
  });

  /* ------------------------------ notifications ----------------------------- */

  it('tells the owner a reply waits for review — their own agent’s included — folded per radar', async () => {
    const radar = await createRadar(lucas, { name: 'Helpdesk · Notify', template: 'helpdesk' });
    await shareRadar(lucas, radar.id, andrea.user.email, 'editor');
    const pendingRows = () =>
      getDb()
        .select()
        .from(schema.notifications)
        .where(
          and(
            eq(schema.notifications.userId, lucas.user.id),
            eq(schema.notifications.kind, 'reply_pending'),
            eq(schema.notifications.radarId, radar.id),
          ),
        );
    const one = await blipOn(radar.id, 'first');
    await createComment(agentOf(lucas), one, { body: 'Draft one', visibility: 'client' });
    let rows = await pendingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(1);
    expect(rows[0]?.excerpt).toBe('Draft one');

    const two = await blipOn(radar.id, 'second');
    await createComment(andrea, two, { body: 'Draft two', visibility: 'client' });
    rows = await pendingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(2);

    // Lucas's own reply is no review request; nor is an internal note.
    await createComment(lucas, two, { body: 'Mine', visibility: 'client' });
    await createComment(agentOf(lucas), two, { body: 'just a note' });
    expect((await pendingRows())[0]?.count).toBe(2);
    // Nobody else hears about review requests.
    const others = await getDb()
      .select()
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.userId, andrea.user.id),
          eq(schema.notifications.kind, 'reply_pending'),
        ),
      );
    expect(others).toHaveLength(0);
  });

  it('keeps a muted radar muted for review requests', async () => {
    const radar = await createRadar(lucas, { name: 'Helpdesk · Muted', template: 'helpdesk' });
    await setRadarLevel(lucas, radar.id, 'none');
    const blipId = await blipOn(radar.id);
    await createComment(agentOf(lucas), blipId, { body: 'quiet draft', visibility: 'client' });
    const rows = await getDb()
      .select()
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.radarId, radar.id),
          eq(schema.notifications.kind, 'reply_pending'),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  /* ------------------------------- webhooks -------------------------------- */

  it('tells the owner’s own subscriptions the visibility of each new comment', async () => {
    const radar = await createRadar(lucas, { name: 'Helpdesk · Hooks', template: 'helpdesk' });
    const sub = await createSubscription(lucas, radar.id, {
      name: 'Own receiver',
      url: 'https://receiver.example/events',
      events: ['comment.created'],
    });
    const blipId = await blipOn(radar.id);
    const note = await createComment(lucas, blipId, { body: 'n' });
    const draft = await createComment(agentOf(lucas), blipId, { body: 'd', visibility: 'client' });
    const reply = await createComment(lucas, blipId, { body: 'r', visibility: 'client' });
    const deliveries = await getDb()
      .select({ payload: schema.subscriptionDeliveries.payload })
      .from(schema.subscriptionDeliveries)
      .where(eq(schema.subscriptionDeliveries.subscriptionId, sub.id));
    const seen = new Map(
      deliveries.map((d) => {
        const comment = d.payload.comment as { id: string; visibility: string };
        return [comment.id, comment.visibility];
      }),
    );
    expect(seen.get(note.id)).toBe('internal');
    expect(seen.get(draft.id)).toBe('client_pending');
    expect(seen.get(reply.id)).toBe('client');
  });

  /* ---------------------------- slice 1 QA minors --------------------------- */

  it('refuses to rotate a public link on a helpdesk (minor a)', async () => {
    const err = await refusal(rotatePublicSlug(lucas, helpdeskId));
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/no public link/);
    const [radar] = await getDb()
      .select({ publicSlug: schema.radars.publicSlug })
      .from(schema.radars)
      .where(eq(schema.radars.id, helpdeskId));
    expect(radar?.publicSlug).toBeNull();
  });

  it('refuses the helpdesk template on a smart radar, at creation and on a switch (minor b)', async () => {
    const created = await refusal(
      createSmartRadar(lucas, {
        name: 'Smart helpdesk',
        filter: { tags: ['x'] },
        template: 'helpdesk',
      }),
    );
    expect(created.status).toBe(400);
    expect(created.message).toMatch(/smart radar cannot be a Helpdesk/);
    const smart = await createSmartRadar(lucas, { name: 'Smart view', filter: { tags: ['y'] } });
    const switched = await refusal(updateRadar(lucas, smart.id, { template: 'helpdesk' }));
    expect(switched.status).toBe(400);
    expect(switched.message).toMatch(/smart radar cannot be a Helpdesk/);
    const [stored] = await getDb()
      .select({ template: schema.radars.template })
      .from(schema.radars)
      .where(eq(schema.radars.id, smart.id));
    expect(stored?.template).not.toBe('helpdesk');
  });

  it('drops client statuses from a lane set leaving the helpdesk, so they cannot ride back (minor c)', async () => {
    const radar = await createRadar(lucas, { name: 'Helpdesk · Lanes', template: 'helpdesk' });
    const lanes = [
      { id: 'todo', label: 'To do', state: 'inbox' as const, clientStatus: 'received' as const },
      {
        id: 'done',
        label: 'Done',
        state: 'done' as const,
        terminal: true,
        clientStatus: 'resolved' as const,
      },
    ];
    await updateRadar(lucas, radar.id, { templateConfig: { lanes } });
    await updateRadar(lucas, radar.id, { template: 'kanban' });
    const [stored] = await getDb()
      .select({ config: schema.radars.templateConfig })
      .from(schema.radars)
      .where(eq(schema.radars.id, radar.id));
    const storedLanes =
      (stored?.config as unknown as { lanes?: Array<Record<string, unknown>> }).lanes ?? [];
    expect(storedLanes.map((lane) => lane['id'])).toEqual(['todo', 'done']);
    expect(storedLanes.some((lane) => 'clientStatus' in lane)).toBe(false);
    // Coming back asks for the mapping again rather than reusing a stale one.
    const back = await refusal(updateRadar(lucas, radar.id, { template: 'helpdesk' }));
    expect(back.status).toBe(400);
    expect(back.message).toMatch(/clientStatus/);
  });

  /* ------------------- qa-reviewer: once a helpdesk, never public ------------------- */

  it('refuses to publish a former helpdesk — owner, co-owner or agent — and the public route serves nothing', async () => {
    const coOwner = await makeUser('cv-co-owner');
    const radar = await createRadar(lucas, { name: 'Board then helpdesk', template: 'kanban' });
    // Published once, so it carries a slug that survives going private.
    const published = await setVisibility(lucas, radar.id, 'public');
    const slug = published.publicSlug ?? '';
    expect(slug).not.toBe('');
    await setVisibility(lucas, radar.id, 'private');
    await updateRadar(lucas, radar.id, { template: 'helpdesk', templateConfig: { lanes: null } });
    await shareRadar(lucas, radar.id, coOwner.user.email, 'owner');
    const blipId = await blipOn(radar.id);
    await createComment(lucas, blipId, { body: 'INTERNAL-CANARY about the client' });
    await createComment(agentOf(lucas), blipId, { body: 'DRAFT-CANARY', visibility: 'client' });

    // The co-owner switches it off the template — allowed — then tries to publish.
    await updateRadar(coOwner, radar.id, { template: 'kanban', templateConfig: { lanes: null } });
    for (const who of [coOwner, agentOf(lucas), lucas]) {
      const err = await refusal(setVisibility(who, radar.id, 'public'));
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/has been a Helpdesk, so it can never be public/);
    }
    expect((await refusal(rotatePublicSlug(lucas, radar.id))).message).toMatch(/no public link/);
    const [row] = await getDb()
      .select({ visibility: schema.radars.visibility, was: schema.radars.wasClientFacing })
      .from(schema.radars)
      .where(eq(schema.radars.id, radar.id));
    expect(row).toEqual({ visibility: 'private', was: true });

    for (const path of [`/api/public/radars/${slug}`, `/api/public/radars/${slug}/blips`]) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toMatch(/CANARY/);
    }
    // Over the wire with the owner's own session too, not only the service.
    const rest = await app.request(`/api/radars/${radar.id}/visibility`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: lucasCookie },
      body: JSON.stringify({ visibility: 'public' }),
    });
    expect(rest.status).toBe(400);
    expect(
      (
        await getDb()
          .select({ visibility: schema.radars.visibility })
          .from(schema.radars)
          .where(eq(schema.radars.id, radar.id))
      )[0]?.visibility,
    ).toBe('private');
  });

  it('keeps the flag in the database: set on entry by any statement, never cleared, CHECK behind it (0044)', async () => {
    const radar = await createRadar(lucas, { name: 'Raw path', template: 'kanban' });
    const flag = async () =>
      (
        await getDb()
          .select({ was: schema.radars.wasClientFacing })
          .from(schema.radars)
          .where(eq(schema.radars.id, radar.id))
      )[0]?.was;
    expect(await flag()).toBe(false);
    // A path that forgets the flag entirely still sets it.
    await getDb().execute(
      sql`UPDATE radars SET template = 'helpdesk' WHERE id = ${radar.id}::uuid`,
    );
    expect(await flag()).toBe(true);
    // Nothing clears it, not even a statement that asks to.
    await getDb().execute(
      sql`UPDATE radars SET template = 'kanban', was_client_facing = false WHERE id = ${radar.id}::uuid`,
    );
    expect(await flag()).toBe(true);
    await expect(
      getDb().execute(
        sql`UPDATE radars SET visibility = 'public', public_slug = ${`raw-was-${Date.now()}`} WHERE id = ${radar.id}::uuid`,
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    // Every client-facing template in the registry trips the trigger.
    for (const template of CLIENT_FACING_TEMPLATE_IDS) {
      const r = await createRadar(lucas, { name: `Trigger ${template}`, template });
      const [stored] = await getDb()
        .select({ was: schema.radars.wasClientFacing })
        .from(schema.radars)
        .where(eq(schema.radars.id, r.id));
      expect(stored?.was).toBe(true);
    }
  });

  it('never honours a public link on a former helpdesk, even one forced past the constraint', async () => {
    const radar = await createRadar(lucas, { name: 'Former · Belt', template: 'helpdesk' });
    await updateRadar(lucas, radar.id, { template: 'kanban', templateConfig: { lanes: null } });
    const slug = `former-belt-${Date.now()}`;
    let checked = false;
    await getDb()
      .transaction(async (tx) => {
        await tx.execute(
          sql`ALTER TABLE radars DROP CONSTRAINT radars_once_client_facing_never_public`,
        );
        await tx.execute(
          sql`UPDATE radars SET visibility = 'public', public_slug = ${slug} WHERE id = ${radar.id}::uuid`,
        );
        const access = await getRadarAccess(slug, null, tx);
        // Refused outright: a denied lookup is null, never an object saying canRead:false.
        expect(access).toBeNull();
        checked = true;
        tx.rollback();
      })
      .catch((err: unknown) => {
        if (!checked) throw err;
      });
    expect(checked).toBe(true);
  });

  /* ---------------- qa-reviewer: internal notes stay with their audience ---------------- */

  it('moves a blip with internal notes only to a never-public radar shared with no one new', async () => {
    const source = (await createRadar(lucas, { name: 'Helpdesk · Src', template: 'helpdesk' })).id;
    await shareRadar(lucas, source, andrea.user.email, 'editor');
    const narrower = (await createRadar(lucas, { name: 'Helpdesk · Same', template: 'helpdesk' }))
      .id;
    await shareRadar(lucas, narrower, andrea.user.email, 'viewer');
    const wider = (await createRadar(lucas, { name: 'Helpdesk · Wider', template: 'helpdesk' })).id;
    await shareRadar(lucas, wider, stranger.user.email, 'viewer');
    const invited = (await createRadar(lucas, { name: 'Helpdesk · Invite', template: 'helpdesk' }))
      .id;
    await shareRadar(lucas, invited, `cv-nobody-${Date.now()}@example.test`, 'viewer');
    const publicBoard = (await createRadar(lucas, { name: 'Public board', template: 'kanban' })).id;
    await setVisibility(lucas, publicBoard, 'public');

    const noted = await blipOn(source, 'request with a note');
    await createComment(lucas, noted, { body: 'internal only' });
    for (const [target, why] of [
      [kanbanId, /could be published/],
      [publicBoard, /could be published/],
      [wider, /shared with people who cannot read them/],
      [invited, /shared with people who cannot read them/],
    ] as const) {
      const err = await refusal(updateBlip(lucas, noted, { radarId: target }));
      expect(err.status).toBe(400);
      expect(err.message).toMatch(why);
    }
    const [still] = await getDb()
      .select({ radarId: schema.blipComments.radarId })
      .from(schema.blipComments)
      .where(eq(schema.blipComments.blipId, noted));
    expect(still?.radarId).toBe(source);
    // Same people or fewer, and never public: allowed.
    expect((await updateBlip(lucas, noted, { radarId: narrower })).radarId).toBe(narrower);
  });

  /* ------------------- qa-reviewer: a deleted reply leaves its record ------------------- */

  it('records the released text and its hash when a released reply is deleted', async () => {
    const blipId = await blipOn(helpdeskId);
    const reply = await createComment(lucas, blipId, {
      body: 'What the client was told',
      visibility: 'client',
    });
    await deleteComment({ ...lucas, viaCookie: true }, reply.id);
    const audits = await getDb()
      .select({ action: schema.auditLog.action, meta: schema.auditLog.meta })
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.subjectId, reply.id), eq(schema.auditLog.action, 'comment.delete')),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.meta).toMatchObject({
      visibility: 'client',
      body: 'What the client was told',
      releasedBodySha256: bodySha256('What the client was told'),
      releasedBy: lucas.user.id,
    });
    // An internal note's deletion stays the short record it always was.
    const note = await createComment(lucas, blipId, { body: 'private words' });
    await deleteComment({ ...lucas, viaCookie: true }, note.id);
    const [noteAudit] = await getDb()
      .select({ meta: schema.auditLog.meta })
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.subjectId, note.id), eq(schema.auditLog.action, 'comment.delete')),
      );
    expect(noteAudit?.meta).not.toHaveProperty('body');
  });
});
