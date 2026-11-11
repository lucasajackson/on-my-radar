/**
 * The charter's link and version doors behind the agent radar fence (plan e715ea20 S5
 * and S6, with T4), over real HTTP and MCP on an isolated database.
 *
 * One person owns two Architecture radars, `granted` and `withheld`. An agent limited to `granted`
 * (at write), another limited to it at read, and an unlimited one are given tokens. Every new
 * door is called on both radars: the withheld one is not found and never leaks the canary that is
 * in its charter, its boundary and its versions; and a read grant cannot write.
 */
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOKEN_SCOPES } from '@onmyradar/contract';
import { createApp } from '../app.js';
import { hashSecret, randomToken } from '../auth/crypto.js';
import { createSession, SESSION_COOKIE } from '../auth/session.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import { must } from '../errors.js';
import type { Actor } from '../http.js';
import { readArchitecture, upsertBoundary, writeCharter } from '../services/architecture.js';
import { linkCharter } from '../services/charter-links.js';
import { createRadar, setVisibility } from '../services/radars.js';
import { createRepoAgent, setAgentRadars } from '../services/repo-agents.js';
import { createToken } from '../services/tokens.js';

type Content = Array<{ type: string; text?: string }>;

const CANARY = `CANARY-${randomToken(4)}`;
const CHARTER = `# Charter\n\n## Billing\n\nStripe is the source of truth. ${CANARY} lives here.\n\n## Hosting\n\nCommander owns hosting.\n`;

describe.skipIf(!process.env['DATABASE_URL'])(
  'charter doors behind the agent radar fence',
  { timeout: 30_000 },
  () => {
    const database = `omr_charter_fence_${Date.now()}`;
    let admin: pg.Pool | undefined;
    let listener: ReturnType<typeof serve> | undefined;
    let base: URL;
    const clients: Client[] = [];
    let owner: Actor;
    let granted = '';
    let withheld = '';
    let grantedBoundary = '';
    let withheldBoundary = '';
    let scopedPat = '';
    let readPat = '';
    let widePat = '';
    let scoped: Client;
    let readOnly: Client;
    let control: Client;
    let publicSlug = '';
    let strangerCookie = '';

    const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
    const rest = (token: string, path: string, init: { method?: string; body?: unknown } = {}) =>
      fetch(new URL(path, base), {
        method: init.method ?? 'GET',
        headers: { ...bearer(token), 'content-type': 'application/json' },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    const asStranger = (path: string) =>
      fetch(new URL(path, base), { headers: { cookie: strangerCookie } });

    async function oauthFor(agentId: string | null, clientId: string) {
      const access = randomToken(32);
      await getDb()
        .insert(schema.oauthTokens)
        .values({
          accessTokenHash: hashSecret(access),
          refreshTokenHash: hashSecret(randomToken(32)),
          clientId,
          userId: owner.user.id,
          scope: TOKEN_SCOPES.join(' '),
          scopeConsented: true,
          agentId,
          agentBound: agentId !== null,
          expiresAt: new Date(Date.now() + 3_600_000),
        });
      return access;
    }
    async function connect(access: string) {
      const client = new Client({ name: 'charter-fence-test', version: '1' });
      clients.push(client);
      const { httpTransport } = await import('./test-client.js');
      await client.connect(
        httpTransport(new URL('/mcp', base), { requestInit: { headers: bearer(access) } }),
      );
      return client;
    }
    async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as Content).map((block) => block.text ?? '').join('\n');
      return { error: result.isError === true, text };
    }

    beforeAll(async () => {
      const connection = must(process.env['DATABASE_URL']);
      admin = new pg.Pool({ connectionString: connection });
      await admin.query(`CREATE DATABASE ${database}`);
      const url = new URL(connection);
      url.pathname = `/${database}`;
      setEnvForTesting(
        loadEnv({
          ...process.env,
          DATABASE_URL: url.toString(),
          SESSION_SECRET: 'charter-fence-test-secret-not-used-anywhere',
          PUBLIC_URL: 'http://localhost:3500',
        }),
      );
      await runMigrations();
      const [row] = await getDb()
        .insert(schema.users)
        .values({ email: 'owner@charter-fence.test', state: 'active', name: 'owner' })
        .returning();
      owner = { user: must(row), kind: 'user', sessionId: randomUUID() };
      const [outsider] = await getDb()
        .insert(schema.users)
        .values({ email: 'stranger@charter-fence.test', state: 'active', name: 'stranger' })
        .returning();
      strangerCookie = `${SESSION_COOKIE}=${(await createSession(must(outsider))).token}`;

      const radar = async (name: string, title: string) => {
        const id = (await createRadar(owner, { name, template: 'architecture' })).id;
        await writeCharter(owner, id, { markdown: CHARTER, baseRevision: 0 });
        const boundary = (await upsertBoundary(owner, id, { title })).boundary.id;
        return { id, boundary };
      };
      const published = await radar('Published architecture', 'Public');
      publicSlug = must((await setVisibility(owner, published.id, 'public')).publicSlug);
      const g = await radar('Granted architecture', 'Billing');
      granted = g.id;
      grantedBoundary = g.boundary;
      const w = await radar('Withheld architecture', `Boundary ${CANARY}`);
      withheld = w.id;
      withheldBoundary = w.boundary;
      await linkCharter(owner, withheld, {
        quote: 'Commander owns hosting.',
        element: withheldBoundary,
      });

      const scopedId = (
        await createRepoAgent(owner, { name: 'Scoped', slug: 'scoped', prompt: 'p' })
      ).id;
      await setAgentRadars(owner, scopedId, {
        scope: 'selected',
        grants: [{ radarId: granted, ceiling: 'write' }],
      });
      const readId = (await createRepoAgent(owner, { name: 'Reader', slug: 'reader', prompt: 'p' }))
        .id;
      await setAgentRadars(owner, readId, {
        scope: 'selected',
        grants: [{ radarId: granted, ceiling: 'read' }],
      });
      const wideId = (await createRepoAgent(owner, { name: 'Wide', slug: 'wide', prompt: 'p' })).id;
      scopedPat = must((await createToken(owner, { name: 'scoped', agentId: scopedId })).token);
      readPat = must((await createToken(owner, { name: 'reader', agentId: readId })).token);
      widePat = must((await createToken(owner, { name: 'wide', agentId: wideId })).token);

      listener = serve({ fetch: createApp().fetch, port: 0 });
      const address = listener.address();
      if (!address || typeof address === 'string') throw new Error('Missing test listener');
      base = new URL(`http://127.0.0.1:${address.port}`);
      scoped = await connect(await oauthFor(scopedId, 'omr_scoped_charter'));
      readOnly = await connect(await oauthFor(readId, 'omr_reader_charter'));
      control = await connect(await oauthFor(null, 'omr_control_charter'));
    }, 60_000);

    afterAll(async () => {
      await Promise.all(clients.map((client) => client.close()));
      const open = listener;
      if (open) await new Promise<void>((resolve) => open.close(() => resolve()));
      await closeDb();
      if (admin) {
        await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
        await admin.end();
      }
    });

    /** Every door, aimed at one radar, as the REST path and the MCP call that reach it. */
    const doors = (radarId: string, element: string) =>
      [
        {
          name: 'link_charter',
          write: true,
          rest: [
            'POST',
            `/api/radars/${radarId}/charter/links`,
            { quote: 'Commander owns hosting.', element },
          ],
          mcp: ['link_charter', { radarId, quote: 'Commander owns hosting.', element }],
        },
        {
          name: 'list_charter_versions',
          write: false,
          rest: ['GET', `/api/radars/${radarId}/charter/versions`],
          mcp: ['list_charter_versions', { radarId }],
        },
        {
          name: 'diff_charter',
          write: false,
          rest: ['GET', `/api/radars/${radarId}/charter/diff?from=1&to=head`],
          mcp: ['diff_charter', { radarId, from: 1, to: 'head' }],
        },
        {
          name: 'write_charter{restoreVersion}',
          write: true,
          rest: ['POST', `/api/radars/${radarId}/charter/versions/1/restore`, { baseRevision: 99 }],
          mcp: ['write_charter', { radarId, restoreVersion: 1, baseRevision: 99 }],
        },
        {
          name: 'read_architecture{version,anchor}',
          write: false,
          rest: ['GET', `/api/radars/${radarId}/architecture?version=1&view=written`],
          mcp: ['read_architecture', { radarId, version: 1, view: 'written' }],
        },
      ] as const;

    it('REST: on the withheld radar every door is not found, and nothing of it leaks', async () => {
      for (const door of doors(withheld, withheldBoundary)) {
        const [method, path, body] = door.rest as readonly [string, string, unknown?];
        for (const pat of [scopedPat, readPat]) {
          const res = await rest(pat, path, { method, body });
          const text = await res.text();
          expect(res.status, `${door.name} ${path}`).toBe(404);
          for (const secret of [CANARY, withheld, 'Withheld architecture', withheldBoundary])
            expect(text, `${door.name} leaked ${secret}`).not.toContain(secret);
        }
      }
      // The control sees the canary, so the above did not pass on an empty fixture.
      const seen = await rest(widePat, `/api/radars/${withheld}/architecture?view=written`);
      expect(await seen.text()).toContain(CANARY);
    });

    it('MCP: the same, through every tool', async () => {
      for (const door of doors(withheld, withheldBoundary)) {
        const [tool, args] = door.mcp as readonly [string, Record<string, unknown>];
        for (const client of [scoped, readOnly]) {
          const out = await call(client, tool, args);
          expect(out.error, `${door.name} on the withheld radar`).toBe(true);
          expect(out.text).toMatch(/not found/i);
          for (const secret of [CANARY, withheld, withheldBoundary])
            expect(out.text, `${door.name} leaked ${secret}`).not.toContain(secret);
        }
      }
      expect((await call(control, 'list_charter_versions', { radarId: withheld })).error).toBe(
        false,
      );
      expect(
        (
          await call(control, 'read_architecture', {
            radarId: withheld,
            version: 1,
            view: 'written',
          })
        ).text,
      ).toContain(CANARY);
      // A link is not a way to read the withheld radar's elements, by id or by naming a new one.
      const grantedLink = await call(scoped, 'link_charter', {
        radarId: granted,
        quote: 'Commander owns hosting.',
        element: withheldBoundary,
      });
      expect(grantedLink.error).toBe(true);
      expect(grantedLink.text).not.toContain(CANARY);
    });

    it('on the granted radar the write grant links, lists, diffs, reads a version and restores', async () => {
      const linked = await rest(scopedPat, `/api/radars/${granted}/charter/links`, {
        method: 'POST',
        body: { quote: 'Stripe is the source of truth.', element: grantedBoundary },
      });
      expect(linked.status).toBe(200); // an existing element
      const body = (await linked.json()) as { link: { id: string }; element: { created: boolean } };
      expect(body.element.created).toBe(false);
      const created = await call(scoped, 'link_charter', {
        radarId: granted,
        quote: 'Commander owns hosting.',
        element: { kind: 'boundary', title: 'Hosting' },
      });
      expect(created.error).toBe(false);
      const versions = await call(scoped, 'list_charter_versions', { radarId: granted });
      expect(JSON.parse(versions.text)).toMatchObject({
        versions: [{ cause: 'anchor' }, { cause: 'anchor' }, {}],
      });
      const diff = await call(scoped, 'diff_charter', { radarId: granted, from: 1, to: 'head' });
      expect(JSON.parse(diff.text)).toMatchObject({ identical: true });
      const past = await call(scoped, 'read_architecture', {
        radarId: granted,
        version: 1,
        view: 'written',
        anchor: body.link.id,
      });
      expect(JSON.parse(past.text)).toMatchObject({ readOnly: true, asOf: { version: 1 } });
      const head = must((await readArchitecture(owner, granted, { view: 'written' })).revision);
      const restored = await call(scoped, 'write_charter', {
        radarId: granted,
        restoreVersion: 1,
        baseRevision: head,
      });
      expect(restored.error).toBe(false);
      expect(JSON.parse(restored.text)).toMatchObject({ restoredFrom: 1, changed: false });
    });

    it('a read grant reads history and cannot link or restore', async () => {
      const listed = await call(readOnly, 'list_charter_versions', { radarId: granted });
      expect(listed.error).toBe(false);
      expect((await call(readOnly, 'diff_charter', { radarId: granted, from: 1 })).error).toBe(
        false,
      );
      expect(
        (await call(readOnly, 'read_architecture', { radarId: granted, version: 1 })).error,
      ).toBe(false);
      const before = (
        await getDb()
          .select()
          .from(schema.charterAnchors)
          .where(eq(schema.charterAnchors.radarId, granted))
      ).length;
      for (const [tool, args] of [
        [
          'link_charter',
          { radarId: granted, quote: 'Commander owns hosting.', element: grantedBoundary },
        ],
        ['write_charter', { radarId: granted, restoreVersion: 1, baseRevision: 0 }],
      ] as const) {
        const out = await call(readOnly, tool, args);
        expect(out.error, tool).toBe(true);
        expect(out.text, tool).toMatch(/read-only|read access|ceiling|granted/i);
      }
      expect(
        (
          await rest(readPat, `/api/radars/${granted}/charter/links`, {
            method: 'POST',
            body: { quote: 'Commander owns hosting.', element: grantedBoundary },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await getDb()
            .select()
            .from(schema.charterAnchors)
            .where(eq(schema.charterAnchors.radarId, granted))
        ).length,
      ).toBe(before);
    });

    it('a signed-in visitor of a public radar reads its charter and none of its history', async () => {
      const base = `/api/radars/${publicSlug}`;
      const head = await asStranger(`${base}/architecture?view=written`);
      expect(head.status).toBe(200);
      for (const path of [
        `${base}/charter/versions`,
        `${base}/charter/diff?from=1&to=head`,
        `${base}/architecture?version=1&view=written`,
      ]) {
        const res = await asStranger(path);
        expect(res.status, path).toBe(404);
        expect(await res.text(), path).not.toContain('Stripe');
      }
    });
  },
);
