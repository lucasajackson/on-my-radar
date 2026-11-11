/**
 * The organization term in `access.ts` (plan 161d7453, T2), on real PostgreSQL.
 *
 * What it settles: in a team org a grant counts only for somebody with an active membership
 * in that org, guests have explicit grants only, no org role adds content access, and the
 * term is computed per request so removing a membership ends access at once. Personal and
 * install orgs keep today's sharing (`access-characterization.test.ts` pins that for every
 * existing combination). Each org kind is created explicitly here; nothing leans on the
 * migration's defaults.
 *
 * Every door is asked the same question and must give the same answer: the lookup, the
 * sidebar, the readable set, the readers, search, topics and shared agents.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { hashSecret, newApiToken, tokenPrefix } from '../auth/crypto.js';
import { createSession, SESSION_COOKIE } from '../auth/session.js';
import pg from 'pg';
import { closeDb, getDb, getPool, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import { must } from '../errors.js';
import { ApiError, type Actor } from '../http.js';
import {
  getRadarAccess,
  getRepoAgentAccess,
  getTopicAccess,
  orgStanding,
  radarReaders,
  readableRadarIds,
  readableTopicQuery,
  reachableAgentQuery,
  requireGuestSupportQueue,
  requireHelpdeskRadar,
  requireRadar,
  requireTopic,
  topicReaders,
} from './access.js';
import { createBlip } from './blips.js';
import { createIntegration, enrolRadar } from './integrations.js';
import { createRadar, listRadars, setVisibility, shareRadar } from './radars.js';
import { createRepoAgent, listRepoAgents, shareAgent } from './repo-agents.js';
import { searchBlips } from './search.js';
import { createTopic, listTopics, setCascade, setRadarTopic, shareTopic } from './topics.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

type Kind = 'personal' | 'install' | 'team';
type OrgRole = 'owner' | 'admin' | 'member' | 'guest';

const db = () => getDb();
const refusal = async (run: () => Promise<unknown>): Promise<number | 'ok'> => {
  try {
    await run();
    return 'ok';
  } catch (err) {
    if (err instanceof ApiError) return err.status;
    throw err;
  }
};

async function makeUser(label: string, extra: { isAdmin?: boolean } = {}): Promise<Actor> {
  const [user] = await db()
    .insert(schema.users)
    .values({
      email: `${label.toLowerCase()}-${randomUUID()}@example.test`,
      state: 'active',
      ...extra,
    })
    .returning();
  return { user: must(user), kind: 'user' };
}

async function makeOrg(kind: Kind): Promise<string> {
  const id = randomUUID();
  await db()
    .insert(schema.organizations)
    .values({ id, kind, name: `${kind} org`, slug: `${kind}-${id}` });
  return id;
}

const join = (orgId: string, who: Actor, role: OrgRole, deactivated = false) =>
  db()
    .insert(schema.memberships)
    .values({
      orgId,
      userId: who.user.id,
      role,
      ...(deactivated ? { deactivatedAt: new Date() } : {}),
    });

/** Files a container in an org. The owner must already be a member, or the T1 trigger refuses. */
async function file(table: 'radars' | 'topics' | 'agents', id: string, orgId: string) {
  await db().execute(
    sql`UPDATE ${sql.identifier(table)} SET organization_id = ${orgId}::uuid WHERE id = ${id}::uuid`,
  );
}

describe.skipIf(!hasDatabase)('the organization term (real postgres)', () => {
  let team: string;
  let install: string;
  const u: Record<string, Actor> = {};
  let teamRadar: string;
  let publicRadar: string;
  let publicSlug: string;
  let teamTopic: string;
  let teamAgent: string;
  let personalRadar: string;
  let installRadar: string;
  const database = `omr_orgs_${randomUUID().replaceAll('-', '')}`;
  let pool: pg.Pool;
  let databaseUrl: string;
  const clientEnds: Array<Promise<void>> = [];
  const configure = (extra: Record<string, string> = {}) =>
    setEnvForTesting(
      loadEnv({
        DATABASE_URL: databaseUrl,
        SESSION_SECRET: 'access-orgs-synthetic-session-secret',
        NODE_ENV: 'test',
        LOG_LEVEL: 'fatal',
        ...extra,
      }),
    );

  beforeAll(async () => {
    // Its own database: an install has exactly one install org, which another suite's
    // fixtures would otherwise collide with.
    pool = new pg.Pool({ connectionString: must(process.env['DATABASE_URL']) });
    await pool.query(`CREATE DATABASE ${database}`);
    const url = new URL(must(process.env['DATABASE_URL']));
    url.pathname = `/${database}`;
    databaseUrl = url.toString();
    configure();
    getPool().on('connect', (client) =>
      clientEnds.push(new Promise<void>((resolve) => client.once('end', resolve))),
    );
    await runMigrations();
    for (const label of [
      'owner',
      'admin',
      'orgOwner',
      'viewer',
      'guest',
      'guestViaTopic',
      'deactivated',
      'removed',
      'topicMember',
      'topicOutsider',
      'stranger',
    ])
      u[label] = await makeUser(label);
    const who = (label: string) => must(u[label]);

    team = await makeOrg('team');
    install = await makeOrg('install');
    await join(team, who('owner'), 'member');
    await join(team, who('admin'), 'admin');
    await join(team, who('orgOwner'), 'owner');
    await join(team, who('viewer'), 'member');
    await join(team, who('guest'), 'guest');
    await join(team, who('guestViaTopic'), 'guest');
    await join(team, who('deactivated'), 'member', true);
    await join(team, who('topicMember'), 'member');
    await join(install, who('owner'), 'member');

    const owner = who('owner');
    // A cascading topic in the team org, with people in it from inside and outside.
    teamTopic = (await createTopic(owner, { name: 'Team topic' })).id;
    await file('topics', teamTopic, team);
    await setCascade(owner, teamTopic, true);
    for (const label of ['topicMember', 'guestViaTopic', 'topicOutsider'])
      await shareTopic(owner, teamTopic, who(label).user.email, 'viewer');

    teamRadar = (await createRadar(owner, { name: 'Team radar' })).id;
    await file('radars', teamRadar, team);
    await setRadarTopic(owner, teamRadar, teamTopic);
    for (const label of ['viewer', 'guest', 'deactivated', 'removed'])
      await shareRadar(owner, teamRadar, who(label).user.email, 'viewer');
    await createBlip(owner, teamRadar, { body: 'quarterly-secret-plans in the team radar' });

    publicRadar = (await createRadar(owner, { name: 'Team public' })).id;
    await file('radars', publicRadar, team);
    publicSlug = must((await setVisibility(owner, publicRadar, 'public')).publicSlug);
    await shareRadar(owner, publicRadar, who('removed').user.email, 'editor');

    // The two kinds that keep today's sharing: a personal org (the default) and an install org.
    personalRadar = (await createRadar(owner, { name: 'Personal radar' })).id;
    await shareRadar(owner, personalRadar, who('removed').user.email, 'viewer');
    installRadar = (await createRadar(owner, { name: 'Install radar' })).id;
    await file('radars', installRadar, install);
    await shareRadar(owner, installRadar, who('stranger').user.email, 'viewer');

    // An agent in the team org, shared to a person and to the cascading topic.
    teamAgent = (await createRepoAgent(owner, { name: 'Team agent', prompt: 'p' })).id;
    await file('agents', teamAgent, team);
    await shareAgent(owner, teamAgent, { email: who('viewer').user.email, preset: 'use' });
    await shareAgent(owner, teamAgent, { email: who('removed').user.email, preset: 'use' });
    await shareAgent(owner, teamAgent, { topicId: teamTopic, preset: 'use' });
  }, 120_000);

  afterAll(async () => {
    await closeDb();
    await Promise.all(clientEnds);
    setEnvForTesting(null);
    await pool.query(`DROP DATABASE ${database}`);
    await pool.end();
  });

  /** One radar, asked through every door. They must agree with each other and with the rule. */
  async function doors(label: string, radarId: string) {
    const actor = must(u[label]);
    const lookup = (await getRadarAccess(radarId, actor))?.canRead === true;
    const required = await refusal(() => requireRadar(radarId, actor, 'read'));
    const listed = (await listRadars(actor, { includeArchived: true })).some(
      (r) => r.id === radarId,
    );
    const readable = (await readableRadarIds(actor.user.id)).includes(radarId);
    const [radar] = await db().select().from(schema.radars).where(eq(schema.radars.id, radarId));
    const reader = (await radarReaders(must(radar))).some((r) => r.id === actor.user.id);
    const found = (await searchBlips(actor, { q: 'quarterly-secret-plans' })).items.some(
      (b) => b.radarId === radarId,
    );
    return { lookup, required, listed, readable, reader, found };
  }

  const ALLOWED = ['owner', 'viewer', 'guest', 'topicMember'];
  const REFUSED = [
    'admin',
    'orgOwner',
    'guestViaTopic',
    'deactivated',
    'removed',
    'topicOutsider',
    'stranger',
  ];

  it('team org: a grant counts only with an active membership, and every door agrees', async () => {
    for (const label of ALLOWED) {
      const d = await doors(label, teamRadar);
      expect(d, label).toMatchObject({
        lookup: true,
        required: 'ok',
        listed: true,
        readable: true,
        reader: true,
        found: true,
      });
    }
    for (const label of REFUSED) {
      const d = await doors(label, teamRadar);
      // A 404, never a 403: the answer must not confirm the radar is there.
      expect(d, label).toMatchObject({
        lookup: false,
        required: 404,
        listed: false,
        readable: false,
        reader: false,
        found: false,
      });
    }
  });

  it('no org role adds content: an org owner and an org admin see nothing nobody shared with them', async () => {
    for (const label of ['admin', 'orgOwner']) {
      const actor = must(u[label]);
      expect(await refusal(() => requireRadar(teamRadar, actor, 'read'))).toBe(404);
      expect(await refusal(() => requireTopic(teamTopic, actor, 'read'))).toBe(404);
      expect((await listRadars(actor)).map((r) => r.id)).not.toContain(teamRadar);
      expect((await listTopics(actor)).map((t) => t.id)).not.toContain(teamTopic);
      expect(await readableRadarIds(actor.user.id)).not.toContain(teamRadar);
      expect(await getRepoAgentAccess(teamAgent, actor)).toBeNull();
    }
  });

  it('guests have explicit grants only: a share counts, a cascade does not, and they own nothing', async () => {
    const guest = must(u['guest']);
    const viaTopic = must(u['guestViaTopic']);
    expect((await getRadarAccess(teamRadar, guest))?.via).toBe('member');
    expect(await getRadarAccess(teamRadar, viaTopic)).toBeNull();
    // Their own topic membership is an explicit grant, so they can see the topic itself.
    expect((await getTopicAccess(teamTopic, viaTopic))?.role).toBe('viewer');
    // A guest who ends up owning something in the org is no owner of it.
    const owned = (await createRadar(guest, { name: 'Guest owned' })).id;
    await file('radars', owned, team);
    expect(await refusal(() => requireRadar(owned, guest, 'read'))).toBe(404);
  });

  it('a public team radar is read-only to everybody, and a former member reads it as a stranger does', async () => {
    for (const label of ['removed', 'stranger', 'deactivated']) {
      const access = await getRadarAccess(publicSlug, must(u[label]));
      expect(access, label).toMatchObject({ canRead: true, canWrite: false, viaPublicLink: true });
    }
    // By id the public link is not the identifier, so the dead grant is a 404.
    expect(await refusal(() => requireRadar(publicRadar, must(u['removed']), 'read'))).toBe(404);
    expect(await getRadarAccess(publicSlug, null)).toMatchObject({ viaPublicLink: true });
    // And a member keeps the role they were shared.
    expect(await getRadarAccess(publicSlug, must(u['owner']))).toMatchObject({
      role: 'owner',
      viaPublicLink: false,
    });
  });

  it('personal and install orgs keep today’s sharing, whoever is a member of what', async () => {
    expect(orgStanding('personal', null)).toBe('open');
    expect(orgStanding('install', null)).toBe('open');
    expect(await refusal(() => requireRadar(personalRadar, must(u['removed']), 'read'))).toBe('ok');
    expect(await refusal(() => requireRadar(installRadar, must(u['stranger']), 'read'))).toBe('ok');
    expect(await readableRadarIds(must(u['stranger']).user.id)).toContain(installRadar);
    expect((await listRadars(must(u['removed']))).map((r) => r.id)).toContain(personalRadar);
  });

  it('a membership removed mid-session ends access on the next request, for a session and a token', async () => {
    const app = createApp();
    const viewer = must(u['viewer']);
    const cookie = `${SESSION_COOKIE}=${(await createSession(viewer.user)).token}`;
    const pat = newApiToken();
    await db()
      .insert(schema.apiTokens)
      .values({
        userId: viewer.user.id,
        name: 't2',
        prefix: tokenPrefix(pat),
        tokenHash: hashSecret(pat),
      });
    const get = (headers: Record<string, string>) =>
      app.request(`/api/radars/${teamRadar}`, { headers });
    const as = { cookie: { cookie }, token: { authorization: `Bearer ${pat}` } };
    expect((await get(as.cookie)).status).toBe(200);
    expect((await get(as.token)).status).toBe(200);

    const where = and(
      eq(schema.memberships.orgId, team),
      eq(schema.memberships.userId, viewer.user.id),
    );
    await db().update(schema.memberships).set({ deactivatedAt: new Date() }).where(where);
    expect((await get(as.cookie)).status).toBe(404);
    expect((await get(as.token)).status).toBe(404);
    // The agent-bound shape of the same connection: a capped bearer actor is refused too.
    expect(
      await refusal(() =>
        requireRadar(teamRadar, { ...viewer, kind: 'agent', ceiling: 'editor' }, 'read'),
      ),
    ).toBe(404);

    await db().update(schema.memberships).set({ deactivatedAt: null }).where(where);
    expect((await get(as.cookie)).status).toBe(200);
    await db().delete(schema.memberships).where(where);
    expect((await get(as.cookie)).status).toBe(404);
    expect((await get(as.token)).status).toBe(404);
    await join(team, viewer, 'member');
  });

  it('a membership deleted behind the triggers leaves its owner no access, and the people shared in keep theirs', async () => {
    const lone = await makeUser('lone');
    await join(team, lone, 'member');
    const radar = (await createRadar(lone, { name: 'Left behind' })).id;
    await file('radars', radar, team);
    await shareRadar(lone, radar, must(u['viewer']).user.email, 'viewer');
    expect(await refusal(() => requireRadar(radar, lone, 'manage'))).toBe('ok');
    // Directly, as nothing in the app does: the T1 invariants (a container's owner is a
    // member of its org) no longer hold. The term fails closed.
    await db()
      .delete(schema.memberships)
      .where(and(eq(schema.memberships.orgId, team), eq(schema.memberships.userId, lone.user.id)));
    expect(await refusal(() => requireRadar(radar, lone, 'read'))).toBe(404);
    expect((await listRadars(lone)).map((r) => r.id)).not.toContain(radar);
    expect(await readableRadarIds(lone.user.id)).not.toContain(radar);
    expect(await refusal(() => requireRadar(radar, must(u['viewer']), 'read'))).toBe('ok');
  });

  it('a deleted home membership changes nothing in a personal org', async () => {
    const solo = await makeUser('solo');
    const friend = await makeUser('friend');
    const radar = (await createRadar(solo, { name: 'Solo radar' })).id;
    await shareRadar(solo, radar, friend.user.email, 'viewer');
    await db().delete(schema.memberships).where(eq(schema.memberships.userId, solo.user.id));
    expect(await refusal(() => requireRadar(radar, solo, 'manage'))).toBe('ok');
    expect(await refusal(() => requireRadar(radar, friend, 'read'))).toBe('ok');
  });

  it('a topic never cascades across orgs: filing is refused, and a forced placement is inert', async () => {
    const owner = must(u['owner']);
    const home = (await createTopic(owner, { name: 'Home topic' })).id;
    await setCascade(owner, home, true);
    await shareTopic(owner, home, must(u['topicOutsider']).user.email, 'editor');
    const radar = (await createRadar(owner, { name: 'In the team' })).id;
    await file('radars', radar, team);
    expect(await refusal(() => setRadarTopic(owner, radar, home))).toBe(400);

    // Forced in below the service, as a migration or a bad write could: still nothing reaches it.
    await db().execute(sql`UPDATE radars SET topic_id = ${home}::uuid WHERE id = ${radar}::uuid`);
    const outsider = must(u['topicOutsider']);
    expect(await refusal(() => requireRadar(radar, outsider, 'read'))).toBe(404);
    expect(await readableRadarIds(outsider.user.id)).not.toContain(radar);
    expect((await getRadarAccess(radar, owner))?.topic).toBeNull();

    // And the other way: a personal radar forced into a team topic is not handed to its members.
    const personal = (await createRadar(owner, { name: 'Mine' })).id;
    await db().execute(
      sql`UPDATE radars SET topic_id = ${teamTopic}::uuid WHERE id = ${personal}::uuid`,
    );
    expect(await refusal(() => requireRadar(personal, must(u['topicMember']), 'read'))).toBe(404);
  });

  it('topics: owner and members as their org honours them, in the lookup, the list and the set', async () => {
    for (const [label, expected] of [
      ['owner', 'owner'],
      ['topicMember', 'viewer'],
      ['guestViaTopic', 'viewer'],
      ['topicOutsider', null],
      ['admin', null],
      ['deactivated', null],
    ] as const) {
      const actor = must(u[label]);
      expect((await getTopicAccess(teamTopic, actor))?.role ?? null, label).toBe(expected);
      expect(
        (await listTopics(actor)).some((t) => t.id === teamTopic),
        label,
      ).toBe(expected !== null);
      expect(
        (await readableTopicQuery(actor.user.id)).some((t) => t.id === teamTopic),
        label,
      ).toBe(expected !== null);
    }
    // Who is told about a topic share: only people who can still read the topic.
    const readers = await topicReaders(
      teamTopic,
      ['owner', 'topicMember', 'topicOutsider', 'deactivated'].map((l) => must(u[l]).user.id),
    );
    expect([...readers].sort()).toEqual(
      ['owner', 'topicMember'].map((l) => must(u[l]).user.id).sort(),
    );
  });

  it('agents: shares count as far as the agent’s org honours them', async () => {
    const seen = async (label: string) => {
      const actor = must(u[label]);
      const lookup = (await getRepoAgentAccess(teamAgent, actor)) !== null;
      const reachable = (await reachableAgentQuery(actor.user.id)).some((a) => a.id === teamAgent);
      const view = label === 'owner' ? 'mine' : 'shared';
      const listed = (await listRepoAgents(actor, { view })).some((a) => a.id === teamAgent);
      return { lookup, reachable, listed };
    };
    for (const label of ['owner', 'viewer', 'topicMember'])
      expect(await seen(label), label).toEqual({ lookup: true, reachable: true, listed: true });
    // removed: a user share, but no membership. guestViaTopic: topic share, but a guest.
    // topicOutsider: topic share, no membership. admin: no share at all.
    for (const label of ['removed', 'guestViaTopic', 'topicOutsider', 'admin', 'deactivated'])
      expect(await seen(label), label).toEqual({ lookup: false, reachable: false, listed: false });
  });

  it('the helpdesk door follows the owner’s membership', async () => {
    const operator = await makeUser('operator');
    await join(team, operator, 'member');
    const radar = (await createRadar(operator, { name: 'Helpdesk', template: 'helpdesk' })).id;
    await file('radars', radar, team);
    const integration = await createIntegration(operator, { name: 'portal' });
    await enrolRadar(operator, integration.id, { radarId: radar });
    const actor: Actor = {
      user: operator.user,
      kind: 'integration',
      integrationId: integration.id,
      ceiling: 'editor',
    };
    expect(await refusal(() => requireHelpdeskRadar(radar, actor))).toBe('ok');
    await db()
      .update(schema.memberships)
      .set({ deactivatedAt: new Date() })
      .where(
        and(eq(schema.memberships.orgId, team), eq(schema.memberships.userId, operator.user.id)),
      );
    expect(await refusal(() => requireHelpdeskRadar(radar, actor))).toBe(404);
  });

  it('the support queue stops taking captures once its owner has left the org it lives in', async () => {
    const staff = await makeUser('staff', { isAdmin: true });
    await join(team, staff, 'member');
    const queue = (await createRadar(staff, { name: 'Support', template: 'helpdesk' })).id;
    await file('radars', queue, team);
    configure({ SUPPORT_OWNER_ID: staff.user.id, SUPPORT_RADAR_ID: queue });
    expect(await refusal(() => requireGuestSupportQueue())).toBe('ok');
    await db()
      .update(schema.memberships)
      .set({ deactivatedAt: new Date() })
      .where(and(eq(schema.memberships.orgId, team), eq(schema.memberships.userId, staff.user.id)));
    expect(await refusal(() => requireGuestSupportQueue())).toBe(503);
  });
});
