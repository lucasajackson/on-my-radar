/**
 * Helpdesk slice 1: the template, and the leak cases it closes (docs/HELPDESK.md
 * §6.1, §9 T2).
 *
 * A helpdesk radar is the one radar whose comments include internal notes about
 * an outside client. Slice 1 gives it exactly two rules, and each assertion
 * below is written as the leak that would happen without it:
 *
 * - **Never public, on every path.** A public link would serve the internal
 *   notes to anybody with the URL. Refused by `setVisibility`, by `updateRadar`
 *   switching a published radar onto the template (the path `setVisibility`
 *   cannot see), by `getRadarAccess` and the public route even if a row slipped
 *   through, and by a CHECK constraint behind all of them.
 * - **A client is only ever shown a fixed status, never a lane label.** Every
 *   lane maps to one of six `clientStatus` values; a radar's own vocabulary,
 *   which an agent may rename, cannot reach a client.
 *
 * And one non-rule, asserted just as hard because Lucas corrected the design
 * on it (2026-10-02): **sharing with internal collaborators is unchanged.** A
 * member, a pending invitee and a cascaded topic member keep exactly the access
 * they had when a radar moves onto the template. Nothing in this slice may hide
 * content from them or break their access.
 *
 * Plus the `template:` search filter and `?template=` on radar listings, which
 * must narrow and never widen.
 *
 * Skipped when DATABASE_URL is absent. CI sets it.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  CLIENT_FACING_TEMPLATE_IDS,
  CLIENT_STATUSES,
  RADAR_TEMPLATES,
  statusesFor,
  validateLanes,
} from '@onmyradar/contract';
import { createApp } from '../app.js';
import { createSession, SESSION_COOKIE } from '../auth/session.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { ApiError, type Actor } from '../http.js';
import { buildMcpServer } from '../mcp/server.js';
import { getRadarAccess, requireRadar } from './access.js';
import { createBlip, radarStream } from './blips.js';
import { createComment, listComments } from './comments.js';
import {
  createRadar,
  listMembers,
  listRadars,
  setVisibility,
  shareRadar,
  updateRadar,
} from './radars.js';
import { searchBlips } from './search.js';
import { createTopic, setCascade, setRadarTopic, shareTopic } from './topics.js';

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

/** The lanes the first eight helpdesk radars were given as a custom kanban vocabulary. */
const LULU_LANES = [
  { id: 'new', label: 'New', state: 'inbox' as const },
  { id: 'scheduled', label: 'Scheduled', state: 'later' as const },
  { id: 'in-progress', label: 'In progress', state: 'active' as const },
  { id: 'waiting-on-client', label: 'Waiting on client', state: 'active' as const },
  { id: 'resolved', label: 'Resolved', state: 'done' as const, terminal: true },
  { id: 'declined', label: 'Declined', state: 'dropped' as const, terminal: true },
];

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected a refusal, got success');
}

describe('the helpdesk template in the registry (no database)', () => {
  it('is the one client-facing template, and every one of its lanes names a client status', () => {
    expect(CLIENT_FACING_TEMPLATE_IDS).toEqual(['helpdesk']);
    const lanes = statusesFor('helpdesk');
    expect(lanes.map((lane) => lane.id)).toEqual(LULU_LANES.map((lane) => lane.id));
    for (const lane of lanes) expect(CLIENT_STATUSES).toContain(lane.clientStatus);
    // A client status is never derivable from a lane label: they are separate fields.
    expect(lanes.find((l) => l.id === 'waiting-on-client')?.clientStatus).toBe('waiting_on_you');
  });

  it('refuses a helpdesk lane set that leaves any lane without a client status', () => {
    const check = validateLanes('helpdesk', LULU_LANES);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.problems.filter((p) => p.code === 'missing-client-status')).toHaveLength(6);
  });

  it('refuses a client status on a template with no client side', () => {
    const check = validateLanes('kanban', [
      { id: 'todo', label: 'To do', state: 'inbox', clientStatus: 'received' },
      { id: 'done', label: 'Done', state: 'done', terminal: true },
    ]);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.problems.map((p) => p.code)).toContain('unexpected-client-status');
  });

  it('accepts a renamed helpdesk lane: the label is free, the client status is what a client sees', () => {
    const lanes = statusesFor('helpdesk').map((lane) =>
      lane.id === 'declined' ? { ...lane, label: 'Ignore' } : lane,
    );
    const check = validateLanes('helpdesk', lanes);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.lanes.find((l) => l.id === 'declined')).toMatchObject({
      label: 'Ignore',
      clientStatus: 'declined',
    });
  });

  it('is never offered as a drop box', () => {
    expect(RADAR_TEMPLATES.helpdesk.inbox).toBe(false);
  });
});

describe.skipIf(!hasDatabase)('helpdesk slice 1 against a real postgres', () => {
  let app: ReturnType<typeof createApp>;
  let lucas: Actor;
  let andrea: Actor;
  let stranger: Actor;
  let lucasCookie: string;
  let strangerCookie: string;

  beforeAll(async () => {
    await runMigrations();
    app = createApp();
    lucas = await makeUser('hd-lucas');
    andrea = await makeUser('hd-andrea');
    stranger = await makeUser('hd-stranger');
    lucasCookie = `${SESSION_COOKIE}=${(await createSession(lucas.user)).token}`;
    strangerCookie = `${SESSION_COOKIE}=${(await createSession(stranger.user)).token}`;
  });

  afterAll(async () => {
    await closeDb();
  });

  /* ------------------------------ never public ----------------------------- */

  it('refuses to publish a helpdesk, and leaves it private', async () => {
    const radar = await createRadar(lucas, { name: 'Helpdesk · Publish', template: 'helpdesk' });
    const err = await refusal(setVisibility(lucas, radar.id, 'public'));
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/never public/);
    const [row] = await getDb()
      .select({ visibility: schema.radars.visibility, publicSlug: schema.radars.publicSlug })
      .from(schema.radars)
      .where(sql`${schema.radars.id} = ${radar.id}`);
    expect(row).toEqual({ visibility: 'private', publicSlug: null });
  });

  it('refuses to switch a published radar onto the helpdesk template — the path setVisibility cannot see', async () => {
    const radar = await createRadar(lucas, { name: 'Published board', template: 'kanban' });
    await setVisibility(lucas, radar.id, 'public');
    const err = await refusal(
      updateRadar(lucas, radar.id, { template: 'helpdesk', templateConfig: { lanes: null } }),
    );
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/never public.*private first/);
    const [row] = await getDb()
      .select({ template: schema.radars.template, visibility: schema.radars.visibility })
      .from(schema.radars)
      .where(sql`${schema.radars.id} = ${radar.id}`);
    // Refused before the write: nothing half-applied.
    expect(row).toEqual({ template: 'kanban', visibility: 'public' });
  });

  it('stores no public helpdesk even when every service refusal is bypassed (the 0042 CHECK)', async () => {
    const radar = await createRadar(lucas, { name: 'Helpdesk · Raw', template: 'helpdesk' });
    await expect(
      getDb().execute(
        sql`UPDATE radars SET visibility = 'public', public_slug = ${`raw-${Date.now()}`} WHERE id = ${radar.id}::uuid`,
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('never honours a public link on a helpdesk row, even one that got past the constraint', async () => {
    const radar = await createRadar(lucas, { name: 'Helpdesk · Belt', template: 'helpdesk' });
    const slug = `belt-${Date.now()}`;
    let checked = false;
    // A transaction that drops the constraint, forces the row, asks the access
    // check, and rolls everything back — so the database is never left without it.
    await getDb()
      .transaction(async (tx) => {
        await tx.execute(sql`ALTER TABLE radars DROP CONSTRAINT radars_helpdesk_is_never_public`);
        // 0044's history constraint would refuse the same row; both go for this.
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
    const constraint = await getDb().execute(
      sql`SELECT 1 FROM pg_constraint WHERE conname = 'radars_helpdesk_is_never_public'`,
    );
    expect(constraint.rows).toHaveLength(1);
  });

  it('has a constraint for every client-facing template in the registry', async () => {
    for (const template of CLIENT_FACING_TEMPLATE_IDS) {
      const radar = await createRadar(lucas, { name: `Every ${template}`, template });
      await expect(
        getDb().execute(
          sql`UPDATE radars SET visibility = 'public', public_slug = ${`every-${template}-${Date.now()}`} WHERE id = ${radar.id}::uuid`,
        ),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
    }
  });

  /* ------------------------ moving the first eight in ----------------------- */

  it('refuses a switch that would carry lanes with no client status, and names the one-call fix', async () => {
    const radar = await createRadar(lucas, {
      name: 'Helpdesk · Kanban first',
      template: 'kanban',
      templateConfig: { lanes: LULU_LANES, defaultStatus: 'new' },
    });
    const err = await refusal(updateRadar(lucas, radar.id, { template: 'helpdesk' }));
    expect(err.message).toMatch(/clientStatus/);
    expect(err.message).toMatch(/templateConfig\.lanes: null/);
  });

  it('moves a kanban helpdesk onto the template in one call, stranding nothing', async () => {
    const radar = await createRadar(lucas, {
      name: 'Helpdesk · Migrate',
      template: 'kanban',
      templateConfig: { lanes: LULU_LANES, defaultStatus: 'new' },
    });
    const waiting = await createBlip(lucas, radar.id, {
      body: 'Logo looks blurry',
      status: 'waiting-on-client',
    });
    const updated = await updateRadar(lucas, radar.id, {
      template: 'helpdesk',
      templateConfig: { lanes: null },
    });
    expect(updated.template).toBe('helpdesk');
    const page = await radarStream(await requireRadar(radar.id, lucas, 'read'), lucas, {});
    const blip = page.items.find((item) => item.id === waiting.id);
    expect(blip?.status).toBe('waiting-on-client');
    expect(statusesFor(updated.template, updated.templateConfig)).toEqual(statusesFor('helpdesk'));
  });

  /* --------------------- members keep exactly what they had ----------------- */

  it('leaves a collaborator, a pending invitee and a cascaded member exactly where they were', async () => {
    const topic = await createTopic(lucas, { name: `Meyers-like ${Date.now()}` });
    const radar = await createRadar(lucas, {
      name: 'Helpdesk · Shared before',
      template: 'kanban',
      templateConfig: { lanes: LULU_LANES, defaultStatus: 'new' },
    });
    await setRadarTopic(lucas, radar.id, topic.id);
    await shareRadar(lucas, radar.id, andrea.user.email, 'editor');
    const inviteeEmail = `invitee-${Date.now()}@example.test`;
    await shareRadar(lucas, radar.id, inviteeEmail, 'editor');
    const cascaded = await makeUser('hd-cascaded');
    await shareTopic(lucas, topic.id, cascaded.user.email, 'viewer');
    await setCascade(lucas, topic.id, true);

    const blip = await createBlip(lucas, radar.id, { body: 'Contact form sends twice' });
    await createComment(lucas, blip.id, { body: 'Internal: check the Turnstile retry' });

    const before = {
      members: (await listMembers(await requireRadar(radar.id, lucas, 'read'))).map((m) => [
        m.email,
        m.role,
        m.pending,
      ]),
      andrea: (await requireRadar(radar.id, andrea, 'read')).role,
      cascaded: (await requireRadar(radar.id, cascaded, 'read')).role,
    };

    await updateRadar(lucas, radar.id, { template: 'helpdesk', templateConfig: { lanes: null } });

    const after = {
      members: (await listMembers(await requireRadar(radar.id, lucas, 'read'))).map((m) => [
        m.email,
        m.role,
        m.pending,
      ]),
      andrea: (await requireRadar(radar.id, andrea, 'read')).role,
      cascaded: (await requireRadar(radar.id, cascaded, 'read')).role,
    };
    expect(after).toEqual(before);
    expect(after.members).toContainEqual([inviteeEmail, 'editor', true]);

    // And the content, not only the role: the collaborator reads the blip and
    // the internal note, and can still work the request.
    const thread = await listComments(andrea, blip.id);
    expect(thread.items.map((c) => c.body)).toContain('Internal: check the Turnstile retry');
    await createComment(andrea, blip.id, { body: 'Andrea: fixed on staging' });
    await updateRadar(andrea, radar.id, { tagline: 'collaborators may still edit presentation' });
  });

  it('still lets the owner share a helpdesk with a collaborator after the switch', async () => {
    const radar = await createRadar(lucas, {
      name: 'Helpdesk · Share after',
      template: 'helpdesk',
    });
    const collaborator = await makeUser('hd-collab');
    const result = await shareRadar(lucas, radar.id, collaborator.user.email, 'editor');
    expect(result.status).toBe('added');
    expect((await requireRadar(radar.id, collaborator, 'write')).canWrite).toBe(true);
  });

  /* -------------------------- template: and ?template= ---------------------- */

  it('finds blips on every readable helpdesk across topics, and never on one the caller cannot read', async () => {
    const marker = `zebra${Date.now()}`;
    const topicA = await createTopic(lucas, { name: `Client A ${Date.now()}` });
    const topicB = await createTopic(lucas, { name: `Client B ${Date.now()}` });
    const a = await createRadar(lucas, {
      name: 'Helpdesk · A',
      template: 'helpdesk',
      topicId: topicA.id,
    });
    const b = await createRadar(lucas, {
      name: 'Helpdesk · B',
      template: 'helpdesk',
      topicId: topicB.id,
    });
    const board = await createRadar(lucas, {
      name: 'Board A',
      template: 'kanban',
      topicId: topicA.id,
    });
    const strangers = await createRadar(stranger, { name: 'Their helpdesk', template: 'helpdesk' });
    for (const radar of [a, b, board])
      await createBlip(lucas, radar.id, { body: `${marker} ${radar.name}` });
    await createBlip(stranger, strangers.id, { body: `${marker} secret` });

    const mine = await searchBlips(lucas, { q: `${marker} template:helpdesk` });
    expect(mine.problems).toEqual([]);
    expect(new Set(mine.items.map((item) => item.radarId))).toEqual(new Set([a.id, b.id]));

    const theirs = await searchBlips(stranger, { q: `${marker} template:helpdesk` });
    expect(theirs.items.map((item) => item.radarId)).toEqual([strangers.id]);

    const excluded = await searchBlips(lucas, { q: `${marker} -template:helpdesk` });
    expect(excluded.items.map((item) => item.radarId)).toEqual([board.id]);
  });

  it('reports an unknown template instead of searching for it as a word', async () => {
    const result = await searchBlips(lucas, { q: 'template:blue' });
    expect(result.unresolved).toBe(true);
    expect(result.problems[0]?.message).toMatch(/not a radar template/);
    expect(result.items).toEqual([]);
  });

  it("lists only helpdesks with ?template=helpdesk, on REST and on MCP, and only the caller's", async () => {
    const own = await createRadar(lucas, { name: 'Helpdesk · Listed', template: 'helpdesk' });
    await createRadar(stranger, { name: 'Helpdesk · Not yours', template: 'helpdesk' });

    const res = await app.request('/api/radars?template=helpdesk', {
      headers: { cookie: lucasCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { radars: Array<{ id: string; template: string }> };
    expect(body.radars.length).toBeGreaterThan(0);
    expect(body.radars.every((radar) => radar.template === 'helpdesk')).toBe(true);
    expect(body.radars.map((radar) => radar.id)).toContain(own.id);
    expect((await listRadars(lucas)).length).toBeGreaterThan(body.radars.length);

    const bad = await app.request('/api/radars?template=blue', {
      headers: { cookie: lucasCookie },
    });
    expect(bad.status).toBe(400);

    const strangers = await app.request('/api/radars?template=helpdesk', {
      headers: { cookie: strangerCookie },
    });
    const theirs = (await strangers.json()) as { radars: Array<{ id: string }> };
    expect(theirs.radars.map((radar) => radar.id)).not.toContain(own.id);

    const server = buildMcpServer(lucas);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'helpdesk-test', version: '1' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      const result = await client.callTool({
        name: 'list_radars',
        arguments: { template: 'helpdesk' },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
      const listed = JSON.parse(text) as Array<{ id: string; template: string }>;
      expect(listed.map((radar) => radar.id)).toEqual(body.radars.map((radar) => radar.id));
    } finally {
      await client.close();
    }
  });
});
