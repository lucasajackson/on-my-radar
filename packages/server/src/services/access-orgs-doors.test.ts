/**
 * The doors that do not go through a radar lookup, held to the same organization term
 * (plan 161d7453, T2, Codex round 1): the account export and its download tickets, the
 * drop box, binding a credential to an agent, and a bound credential at request time.
 *
 * Someone who has left a team organization keeps no claim on what is in it, whatever the
 * ledger, an owner column or a stored credential still says.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { TOKEN_SCOPES } from '@onmyradar/contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashSecret, newApiToken, randomToken, tokenPrefix } from '../auth/crypto.js';
import { resolveBearerToken } from '../auth/bearer.js';
import { createSession } from '../auth/session.js';
import { closeDb, getDb, getPool, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import { must } from '../errors.js';
import type { Actor } from '../http.js';
import {
  authorizeEmailDelivery,
  claimEmailCaptureIdentity,
  updateRadarEmailCapture,
} from './inbound-email.js';
import { getRadarAccess } from './access.js';
import { openAccountExport } from './account-export-collector.js';
import { accountExportTicket } from './account-export.js';
import { remember } from './agent-memory.js';
import { listAgents, requireOwnLiveAgent } from './agents.js';
import { createBlip } from './blips.js';
import { createDashboard, listDashboards } from './dashboards.js';
import { createRadar, deleteRadar, getDropBox, shareRadar } from './radars.js';
import { createRepoAgent } from './repo-agents.js';
import { createTopic } from './topics.js';
import { createToken } from './tokens.js';
import type * as Storage from './storage.js';

vi.mock('./storage.js', async (original) => ({
  ...(await original<typeof Storage>()),
  accountExportObjectMetadata: vi.fn(async () => ({ size: 5, etag: 'fixed-etag' })),
  accountExportObjectUrl: vi.fn(async () => 'https://storage.example.test/synthetic-file'),
}));

const hasDatabase = Boolean(process.env['DATABASE_URL']);
const rnd = () => Math.random().toString(36).slice(2, 8);

async function refusal(run: () => Promise<unknown>): Promise<number | 'ok'> {
  try {
    await run();
    return 'ok';
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === undefined) throw err;
    return status;
  }
}

describe.skipIf(!hasDatabase)(
  'the other doors, under the organization term (real postgres)',
  () => {
    const database = `omr_doors_${randomUUID().replaceAll('-', '')}`;
    let pool: pg.Pool;
    const clientEnds: Array<Promise<void>> = [];
    let team: string;

    const configure = (url: string) =>
      setEnvForTesting(
        loadEnv({
          DATABASE_URL: url,
          SESSION_SECRET: 'access-orgs-doors-synthetic-session-secret',
          EMAIL_CAPTURE_DOMAIN: 'onmyradar.io',
          EMAIL_CAPTURE_ENABLED: 'true',
          EMAIL_INGEST_SECRET: 'access-orgs-doors-synthetic-ingest-secret',
          NODE_ENV: 'test',
          LOG_LEVEL: 'fatal',
        }),
      );

    beforeAll(async () => {
      pool = new pg.Pool({ connectionString: must(process.env['DATABASE_URL']) });
      await pool.query(`CREATE DATABASE ${database}`);
      const url = new URL(must(process.env['DATABASE_URL']));
      url.pathname = `/${database}`;
      configure(url.toString());
      getPool().on('connect', (client) =>
        clientEnds.push(new Promise<void>((resolve) => client.once('end', resolve))),
      );
      await runMigrations();
      team = randomUUID();
      await getDb()
        .insert(schema.organizations)
        .values({ id: team, kind: 'team', name: 'Team', slug: `team-${team}` });
    }, 60_000);

    afterAll(async () => {
      await closeDb();
      await Promise.all(clientEnds);
      setEnvForTesting(null);
      await pool.query(`DROP DATABASE ${database}`);
      await pool.end();
    });

    /** A signed-in person (with a real session) who is a member of the team org. */
    async function member(label: string, asHome = false): Promise<Actor> {
      const id = randomUUID();
      await getDb().transaction(async (tx) => {
        await tx
          .insert(schema.users)
          .values({ id, email: `${label}-${rnd()}@example.test`, state: 'active' });
        await tx
          .insert(schema.memberships)
          .values({ orgId: team, userId: id, role: 'member', isHome: asHome });
      });
      const [user] = await getDb().select().from(schema.users).where(eq(schema.users.id, id));
      const session = await createSession(must(user));
      const [row] = await getDb()
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.tokenHash, hashSecret(session.token)));
      return { user: must(user), kind: 'user', sessionId: must(row).id };
    }
    async function createSoloUser(): Promise<Actor> {
      const [user] = await getDb()
        .insert(schema.users)
        .values({ email: `solo-${rnd()}@example.test`, state: 'active' })
        .returning();
      const session = await createSession(must(user));
      const [row] = await getDb()
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.tokenHash, hashSecret(session.token)));
      return { user: must(user), kind: 'user', sessionId: must(row).id };
    }
    const leave = (who: Actor) =>
      getDb()
        .update(schema.memberships)
        .set({ deactivatedAt: new Date() })
        .where(and(eq(schema.memberships.orgId, team), eq(schema.memberships.userId, who.user.id)));
    const file = (table: 'radars' | 'topics' | 'agents' | 'dashboards', id: string) =>
      getDb().execute(
        sql`UPDATE ${sql.identifier(table)} SET organization_id = ${team}::uuid WHERE id = ${id}::uuid`,
      );

    async function exported(who: Actor): Promise<string> {
      const snapshot = await openAccountExport(who);
      let text = '';
      try {
        for await (const entry of snapshot.entries) {
          if (!entry.path.endsWith('.json')) continue;
          for await (const chunk of entry.bytes) text += Buffer.from(chunk).toString();
        }
      } finally {
        await snapshot.close();
      }
      return text;
    }

    it('the account export hands a former member nothing that lives in the organization', async () => {
      const leaver = await member('leaver');
      const agent = await createRepoAgent(leaver, {
        name: `Team agent ${rnd()}`,
        prompt: 'PROMPT-CANARY',
      });
      await file('agents', agent.id);
      await remember(leaver, agent.id, {
        name: 'edited-by-the-team',
        mode: 'create',
        type: 'project',
        description: 'd',
        body: 'MEMORY-CANARY written for the team',
      });
      const topic = await createTopic(leaver, { name: 'TOPIC-CANARY' });
      await file('topics', topic.id);
      const radar = await createRadar(leaver, { name: 'RADAR-CANARY' });
      await file('radars', radar.id);
      await createBlip(leaver, radar.id, { body: 'BLIP-CANARY' });
      const board = await createDashboard(leaver, 'DASHBOARD-CANARY');
      await file('dashboards', board.id);

      expect((await listDashboards(leaver)).map((d) => d.id)).toContain(board.id);
      const before = await exported(leaver);
      for (const canary of [
        'PROMPT-CANARY',
        'MEMORY-CANARY',
        'TOPIC-CANARY',
        'RADAR-CANARY',
        'BLIP-CANARY',
        'DASHBOARD-CANARY',
      ])
        expect(before, canary).toContain(canary);

      await leave(leaver);
      expect((await listDashboards(leaver)).map((d) => d.id)).not.toContain(board.id);
      const after = await exported(leaver);
      for (const canary of [
        'PROMPT-CANARY',
        'MEMORY-CANARY',
        'TOPIC-CANARY',
        'RADAR-CANARY',
        'BLIP-CANARY',
        'DASHBOARD-CANARY',
      ])
        expect(after, canary).not.toContain(canary);
    });

    it('an export download ticket follows current access to the file’s radar', async () => {
      const owner = await member('ticket-owner');
      const radar = await createRadar(owner, { name: 'Ticketed' });
      await file('radars', radar.id);
      const blip = await createBlip(owner, radar.id, { body: 'with a file' });
      const key = `radars/${radar.id}/${randomUUID()}-report.pdf`;
      await getDb().execute(sql`INSERT INTO storage_objects
      (bucket,object_key,owner_id,radar_id,blip_id,kind,state,bytes,content_type)
      VALUES ('on-my-radar',${key},${owner.user.id}::uuid,${radar.id}::uuid,${blip.id}::uuid,
        'legacy','live',5,'application/pdf')`);
      expect(await refusal(() => accountExportTicket(owner, { key, etag: 'fixed-etag' }))).toBe(
        'ok',
      );
      await leave(owner);
      // The ledger still names them as who stored it. That is not who may read it now.
      expect(await refusal(() => accountExportTicket(owner, { key, etag: 'fixed-etag' }))).toBe(
        404,
      );
    });

    it('a file left behind by a deleted radar gives a former owner no key and no ticket', async () => {
      const a = await member('deleted-a');
      const b = await member('deleted-b');
      const radar = await createRadar(a, { name: 'Soon gone' });
      await file('radars', radar.id);
      await shareRadar(a, radar.id, b.user.email, 'owner');
      const blip = await createBlip(b, radar.id, { body: 'uploaded by the co-owner' });
      const key = `radars/${radar.id}/${randomUUID()}-b-upload.pdf`;
      await getDb().execute(sql`INSERT INTO storage_objects
      (bucket,object_key,owner_id,radar_id,blip_id,kind,state,bytes,content_type)
      VALUES ('on-my-radar',${key},${a.user.id}::uuid,${radar.id}::uuid,${blip.id}::uuid,
        'legacy','live',5,'application/pdf')`);
      expect(await exported(a)).toContain(key);
      expect(await refusal(() => accountExportTicket(a, { key, etag: 'fixed-etag' }))).toBe('ok');

      await leave(a);
      await deleteRadar(b, radar.id);
      // Cleanup of the file is still pending: the ledger row outlives the radar.
      const left = await getPool().query('SELECT 1 FROM storage_objects WHERE object_key=$1', [
        key,
      ]);
      expect(left.rowCount).toBe(1);
      expect(await exported(a)).not.toContain(key);
      expect(await refusal(() => accountExportTicket(a, { key, etag: 'fixed-etag' }))).toBe(404);
    });

    it('a single user still exports their file and gets a ticket for it', async () => {
      const solo = await createSoloUser();
      const radar = await createRadar(solo, { name: 'Mine' });
      const blip = await createBlip(solo, radar.id, { body: 'with a file' });
      const key = `radars/${radar.id}/${randomUUID()}-mine.pdf`;
      await getDb().execute(sql`INSERT INTO storage_objects
      (bucket,object_key,owner_id,radar_id,blip_id,kind,state,bytes,content_type)
      VALUES ('on-my-radar',${key},${solo.user.id}::uuid,${radar.id}::uuid,${blip.id}::uuid,
        'legacy','live',5,'application/pdf')`);
      expect(await exported(solo)).toContain(key);
      expect(await refusal(() => accountExportTicket(solo, { key, etag: 'fixed-etag' }))).toBe(
        'ok',
      );
    });

    it('a deactivated owner’s drop box is a 404 on every road to it, not a served empty radar', async () => {
      const owner = await member('dropbox-owner', true);
      const box = await getDropBox(owner);
      expect(box.isDropBox).toBe(true);
      await leave(owner);
      expect(await refusal(() => getDropBox(owner))).toBe(404);
      // The lookup the MCP tool and the REST route share answers null, so a null check is enough.
      expect(await getRadarAccess(box.id, owner)).toBeNull();
    });

    it('a credential cannot be bound to an agent whose organization the owner has left', async () => {
      const owner = await member('binder');
      const agent = await createRepoAgent(owner, { name: `Bindable ${rnd()}` });
      await file('agents', agent.id);
      expect((await listAgents(owner)).map((a) => a.id)).toContain(agent.id);
      expect(await refusal(() => requireOwnLiveAgent(owner, agent.id))).toBe('ok');
      expect(await refusal(() => createToken(owner, { name: 'bound', agentId: agent.id }))).toBe(
        'ok',
      );
      await leave(owner);
      expect((await listAgents(owner)).map((a) => a.id)).not.toContain(agent.id);
      expect(await refusal(() => requireOwnLiveAgent(owner, agent.id))).toBe(404);
      expect(
        await refusal(() => createToken(owner, { name: 'bound again', agentId: agent.id })),
      ).toBe(404);
    });

    for (const family of ['personal access token', 'OAuth grant'] as const) {
      it(`a ${family} bound to a team agent loses the persona when its owner leaves, and gets it back on return`, async () => {
        const owner = await member(`bearer-${family.slice(0, 3)}`);
        const agent = await createRepoAgent(owner, { name: `Persona ${rnd()}` });
        await file('agents', agent.id);
        const secret = family === 'OAuth grant' ? randomToken(32) : newApiToken();
        if (family === 'OAuth grant')
          await getDb()
            .insert(schema.oauthTokens)
            .values({
              accessTokenHash: hashSecret(secret),
              refreshTokenHash: hashSecret(randomToken(32)),
              clientId: `client-${rnd()}`,
              userId: owner.user.id,
              scope: TOKEN_SCOPES.join(' '),
              scopeConsented: true,
              agentId: agent.id,
              agentBound: true,
              expiresAt: new Date(Date.now() + 3_600_000),
            });
        else
          await getDb()
            .insert(schema.apiTokens)
            .values({
              userId: owner.user.id,
              name: `pat ${rnd()}`,
              prefix: tokenPrefix(secret),
              tokenHash: hashSecret(secret),
              scope: TOKEN_SCOPES.join(' '),
              agentId: agent.id,
              agentBound: true,
              voiceGrants: ['persona', 'principal'],
              defaultVoice: 'persona',
            });

        const live = must(await resolveBearerToken(secret));
        expect(live.agent?.agentId).toBe(agent.id);
        expect(live.retiredAgent).toBeUndefined();

        await leave(owner);
        const left = must(await resolveBearerToken(secret));
        // Still authenticates, as the person, but with no persona to write as and read-only.
        expect(left.agent).toBeUndefined();
        expect(left.voice).toBeUndefined();
        expect(left.retiredAgent).toContain('no longer');
        expect(left.ceiling).toBe('viewer');

        await getDb()
          .update(schema.memberships)
          .set({ deactivatedAt: null })
          .where(
            and(eq(schema.memberships.orgId, team), eq(schema.memberships.userId, owner.user.id)),
          );
        expect(must(await resolveBearerToken(secret)).agent?.agentId).toBe(agent.id);
      });
    }

    it('email capture stops delivering into a radar once its owner has left the organization', async () => {
      const owner = await member('mailer', true);
      const radar = await createRadar(owner, { name: 'Inbound' });
      await claimEmailCaptureIdentity(owner, `mailer${rnd()}`);
      const recipient = must(
        (await updateRadarEmailCapture(owner, radar.id, { enabled: true, allowedSenders: [] }))
          .address,
      );
      const delivery = () =>
        authorizeEmailDelivery({
          id: randomUUID().replaceAll('-', '').repeat(2),
          recipient,
          sender: owner.user.email,
          body: 'EMAIL-CANARY',
          files: [],
          email: {
            subject: null,
            senderName: null,
            sentAt: null,
            preview: 'EMAIL-CANARY',
            hasHtml: false,
            attachmentCount: 0,
          },
        });
      expect(await refusal(delivery)).toBe('ok');
      await leave(owner);
      expect(await refusal(delivery)).toBe(400);
    });
  },
);
