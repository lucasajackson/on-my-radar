/**
 * The Agent Repo's upkeep, against a real Postgres: what keeps the tables and
 * the review queue from filling with noise once the repo is in daily use.
 *
 * - load sessions that wrote nothing are purged, the ones that are provenance
 *   are not, and each agent keeps its latest;
 * - a checkout is audited when a connection asks, not when a person previews;
 * - "who wrote this" is filtered by the server, so a filtered page is complete;
 * - an agent shared with you has a name — `owner-email/slug` — and a bare slug
 *   still means only your own, so a share cannot take one over;
 * - the races the database decides answer 409, never 500, and an agent editing
 *   its own prompt is bounded per day. v1's review queue and prompt proposals
 *   were removed in v2 (docs/AGENT_REPO.md §V2.3), and their tests with them.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import {
  AGENT_REPO,
  TOKEN_SCOPES,
  loadAgentSchema,
  recallSchema,
  rememberSchema,
} from '@onmyradar/contract';
import { hashSecret, newApiToken, tokenPrefix } from '../auth/crypto.js';
import { resolveBearerToken } from '../auth/bearer.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Actor } from '../http.js';
import {
  forget,
  loadAgent,
  memoryRevisions,
  purgeIdleSessions,
  recall,
  recallPage,
  remember,
  restoreMemory,
} from './agent-memory.js';
import { listGrants } from './tokens.js';
import {
  acceptShare,
  checkoutAgent,
  createRepoAgent,
  getRepoAgent,
  importAgent,
  listPromptVersions,
  listRepoAgents,
  setAgentEditsLive,
  shareAgent,
  updateBrief,
  updatePrompt,
  updateRepoAgent,
} from './repo-agents.js';
import { must } from '../errors.js';
import { blockedBehind } from './lock-graph.js';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
process.env['SESSION_SECRET'] ??= 'test-only-session-secret-not-used-anywhere-else';

const rnd = () => Math.random().toString(36).slice(2, 8);

async function makeUser(label: string): Promise<Actor> {
  const [user] = await getDb()
    .insert(schema.users)
    .values({ email: `${label}-${Date.now()}-${rnd()}@example.test`, state: 'active', name: label })
    .returning();
  if (!user) throw new Error('user insert returned no row');
  return { user, kind: 'user', sessionId: `web-${rnd()}`, viaCookie: true };
}

async function patActor(human: Actor): Promise<Actor> {
  const secret = newApiToken();
  await getDb()
    .insert(schema.apiTokens)
    .values({
      userId: human.user.id,
      name: `pat ${rnd()}`,
      prefix: tokenPrefix(secret),
      tokenHash: hashSecret(secret),
      scope: TOKEN_SCOPES.join(' '),
    });
  const bearer = await resolveBearerToken(secret);
  if (!bearer) throw new Error('minted PAT does not resolve');
  return {
    user: bearer.user,
    kind: 'agent',
    tokenId: bearer.tokenId,
    scopes: bearer.scopes,
    ceiling: bearer.ceiling,
    connection: bearer.connection,
  };
}

async function refusal(fn: () => Promise<unknown>): Promise<Error & { status?: number }> {
  try {
    await fn();
  } catch (err) {
    return err as Error & { status?: number };
  }
  throw new Error('expected a refusal, but the call succeeded');
}

const load = (actor: Actor, agent: string) =>
  loadAgent(actor, agent, loadAgentSchema.parse({ harness: 'test' }));
const rem = (actor: Actor, agent: string, input: Record<string, unknown>) =>
  remember(actor, agent, rememberSchema.parse(input));

describe.skipIf(!hasDatabase)('Agent Repo upkeep (real postgres)', () => {
  let owner: Actor;
  let ownerAgent: Actor;

  beforeAll(async () => {
    await runMigrations();
    owner = await makeUser('upkeep-owner');
    ownerAgent = await patActor(owner);
  }, 30_000);

  afterAll(async () => {
    await closeDb();
  });

  it('purges load sessions that wrote nothing, and keeps provenance and each agent’s latest', async () => {
    const agent = await createRepoAgent(owner, { name: `Sessions ${rnd()}`, prompt: 'p' });
    const idle = await load(ownerAgent, agent.id);
    const wroteMemory = await load(ownerAgent, agent.id);
    await rem(ownerAgent, agent.id, {
      session: wroteMemory.session.id,
      name: 'kept',
      type: 'project',
      description: 'kept',
      body: 'kept',
    });
    const wrotePrompt = await load(ownerAgent, agent.id);
    await updatePrompt(ownerAgent, agent.id, {
      body: 'p2',
      basedOn: 1,
      session: wrotePrompt.session.id,
    });
    const wroteBrief = await load(ownerAgent, agent.id);
    await updateBrief(ownerAgent, agent.id, 'kept-brief', {
      description: 'kept',
      body: 'kept',
      session: wroteBrief.session.id,
    });
    const recent = await load(ownerAgent, agent.id);
    const latest = await load(ownerAgent, agent.id);

    const ids = [idle, wroteMemory, wrotePrompt, wroteBrief, recent, latest].map(
      (l) => l.session.id,
    );
    const old = new Date(Date.now() - (AGENT_REPO.sessionRetentionDays + 1) * 86_400_000);
    await getDb()
      .update(schema.repoAgentSessions)
      .set({ lastSeenAt: old })
      .where(
        inArray(
          schema.repoAgentSessions.id,
          ids.filter((id) => id !== recent.session.id),
        ),
      );

    expect(await purgeIdleSessions()).toBeGreaterThanOrEqual(1);
    const left = await getDb()
      .select({ id: schema.repoAgentSessions.id })
      .from(schema.repoAgentSessions)
      .where(eq(schema.repoAgentSessions.agentId, agent.id));
    expect(new Set(left.map((r) => r.id))).toEqual(
      new Set([
        wroteMemory.session.id,
        wrotePrompt.session.id,
        wroteBrief.session.id,
        recent.session.id,
        latest.session.id,
      ]),
    );
    // The list still says when the agent was last loaded.
    expect((await getRepoAgent(owner, agent.id)).lastSession).not.toBeNull();
  });

  it('audits a checkout a connection asks for, and not a person’s preview', async () => {
    const agent = await createRepoAgent(owner, { name: `Checkout ${rnd()}` });
    const input = {
      harness: 'other',
      mode: 'primary',
      snapshot: false,
      applyProjectSettings: false,
    } as const;
    for (const harness of ['other', 'claude-code', 'cursor'] as const) {
      await checkoutAgent(owner, agent.id, { ...input, harness });
    }
    await checkoutAgent(ownerAgent, agent.id, input);
    const rows = await getDb()
      .select({ actorKind: schema.auditLog.actorKind })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, 'repo_agent.checkout'),
          eq(schema.auditLog.subjectId, agent.id),
        ),
      );
    expect(rows).toEqual([{ actorKind: 'agent' }]);
  });

  it('filters by who wrote the latest revision in the query, so a filtered page is complete', async () => {
    const imported = await importAgent(ownerAgent, {
      name: `Written by ${rnd()}`,
      prompt: 'p',
      memories: ['one', 'two'].map((name) => ({
        name,
        type: 'reference' as const,
        description: name,
        body: `${name} body`,
      })),
      briefs: [],
    });
    const s = await load(ownerAgent, imported.id);
    await rem(ownerAgent, imported.id, {
      session: s.session.id,
      name: 'agent-wrote',
      type: 'feedback',
      description: 'by the agent',
      body: 'x',
    });
    // An import the agent later changed is the agent's now.
    await rem(ownerAgent, imported.id, {
      session: s.session.id,
      name: 'two',
      mode: 'append',
      body: 'changed after the import',
    });
    for (const name of ['person-a', 'person-b']) {
      await rem(owner, imported.id, { name, type: 'user', description: 'by a person', body: 'y' });
    }
    const by = async (writtenBy: string) =>
      (await recall(owner, imported.id, recallSchema.parse({ writtenBy, limit: 50 })))
        .map((m) => m.name)
        .sort();
    expect(await by('agent')).toEqual(['agent-wrote', 'two']);
    expect(await by('people')).toEqual(['person-a', 'person-b']);
    expect(await by('import')).toEqual(['one']);
    // Filtered in the query: the oldest agent-written memory is the first of a
    // one-row page, not hidden behind two newer ones by people.
    const first = await recallPage(
      owner,
      imported.id,
      recallSchema.parse({ writtenBy: 'agent', limit: 1 }),
    );
    expect(first.total).toBe(2);
    expect(first.nextCursor).not.toBeNull();
  });

  it('pages every memory, in both orders, without a repeat or a gap', async () => {
    const agent = await createRepoAgent(owner, { name: `Pages ${rnd()}` });
    // One timestamp for all of them, so the order is decided by the tiebreak —
    // the case a cursor built from a JS Date or without the id gets wrong.
    const at = new Date('2026-09-26T12:00:00.123456Z');
    await getDb()
      .insert(schema.repoAgentMemories)
      .values(
        Array.from({ length: 23 }, (_, i) => ({
          agentId: agent.id,
          name: `note-${String(i).padStart(2, '0')}`,
          type: 'reference' as const,
          description: `paging note ${i}`,
          body: i % 2 ? 'lighthouse keeper' : 'lighthouse keeper lighthouse keeper lighthouse',
          updatedAt: at,
        })),
      );
    for (const query of [undefined, 'lighthouse']) {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 20; guard += 1) {
        const page = await recallPage(
          owner,
          agent.id,
          recallSchema.parse({
            limit: 5,
            ...(query ? { query } : {}),
            ...(cursor ? { cursor } : {}),
          }),
        );
        seen.push(...page.memories.map((m) => m.name));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(seen, query ?? 'list').toHaveLength(23);
      expect(new Set(seen).size, query ?? 'list').toBe(23);
    }
    // A cursor from a search is not a cursor for the list, nor the reverse.
    const searched = await recallPage(
      owner,
      agent.id,
      recallSchema.parse({ limit: 5, query: 'lighthouse' }),
    );
    const listed = await recallPage(owner, agent.id, recallSchema.parse({ limit: 5 }));
    for (const [cursor, query] of [
      [searched.nextCursor, undefined],
      [listed.nextCursor, 'lighthouse'],
    ] as const) {
      const crossed = await refusal(() =>
        recallPage(
          owner,
          agent.id,
          recallSchema.parse({ limit: 5, cursor, ...(query ? { query } : {}) }),
        ),
      );
      expect(crossed.status).toBe(400);
    }
  });

  it('reads a busy memory’s history a page at a time, newest first', async () => {
    const agent = await createRepoAgent(owner, { name: `History ${rnd()}` });
    const { memory } = await rem(owner, agent.id, {
      name: 'busy',
      type: 'project',
      description: 'appended to all day',
      body: 'start',
    });
    await getDb()
      .insert(schema.repoAgentMemoryRevisions)
      .values(
        Array.from({ length: AGENT_REPO.historyRevisions + 5 }, (_, i) => ({
          memoryId: memory.id,
          revision: i + 2,
          op: 'append' as const,
          type: 'project' as const,
          description: 'appended to all day',
          body: `start ${'x'.repeat(i)}`,
          source: 'agent' as const,
        })),
      );
    const history = await memoryRevisions(owner, agent.id, memory.id);
    expect(history).toHaveLength(AGENT_REPO.historyRevisions);
    expect(history[0]?.revision).toBe(AGENT_REPO.historyRevisions + 6);
  });

  describe('a shared agent by name', () => {
    it('resolves owner-email/slug through the share, and a bare slug stays your own', async () => {
      const slug = `shared-${rnd()}`;
      const theirs = await createRepoAgent(owner, { name: 'Theirs', slug, prompt: 'theirs' });
      const friend = await makeUser('upkeep-friend');
      await shareAgent(owner, theirs.id, { email: friend.user.email, preset: 'use' });
      await acceptShare(friend, theirs.id);
      const ref = `${owner.user.email}/${slug}`;

      expect((await getRepoAgent(owner, theirs.id)).ref).toBe(slug);
      const listed = (await listRepoAgents(friend, { view: 'shared' })).find(
        (a) => a.id === theirs.id,
      );
      expect(listed?.ref).toBe(ref);
      expect((await getRepoAgent(friend, ref)).id).toBe(theirs.id);
      const shouted = `${owner.user.email.toUpperCase()}/${slug}`;
      expect((await getRepoAgent(friend, shouted)).id).toBe(theirs.id);
      const conn = await patActor(friend);
      const loaded = await loadAgent(conn, ref, loadAgentSchema.parse({ harness: 'test' }));
      expect(loaded.agent.id).toBe(theirs.id);

      // A bare slug that is only shared is a miss that names the reference.
      const miss = await refusal(() => getRepoAgent(friend, slug));
      expect(miss.status).toBe(404);
      expect(miss.message).toContain(ref);

      // Your own agent keeps its name, whatever is shared with you under it.
      const mine = await createRepoAgent(friend, { name: 'Mine', slug, prompt: 'mine' });
      expect((await getRepoAgent(friend, slug)).id).toBe(mine.id);
      expect((await getRepoAgent(friend, ref)).id).toBe(theirs.id);
    });

    it('does not find an unshared agent, or tell a stranger it exists', async () => {
      const slug = `private-${rnd()}`;
      const agent = await createRepoAgent(owner, { name: 'Private', slug });
      // Shared with somebody — just not with the stranger.
      const other = await makeUser('upkeep-other');
      await shareAgent(owner, agent.id, { email: other.user.email, preset: 'use' });
      const stranger = await makeUser('upkeep-stranger');
      for (const ref of [
        `${owner.user.email}/${slug}`,
        `nobody-${rnd()}@example.test/${slug}`,
        `${owner.user.email}/not-${slug}`,
        slug,
      ]) {
        const err = await refusal(() => getRepoAgent(stranger, ref));
        expect(err.status, ref).toBe(404);
        expect(err.message, ref).toBe('Agent not found');
      }
    });
  });

  /** Every outcome of a race is a decision the caller can read, never a 500. */
  describe('races the unique indexes decide', () => {
    const statuses = async (calls: Array<Promise<unknown>>) =>
      (await Promise.allSettled(calls)).map((r) =>
        r.status === 'fulfilled' ? 200 : ((r.reason as { status?: number }).status ?? 500),
      );

    it('answers two renames to the same slug with one success and one 409', async () => {
      for (let round = 0; round < 3; round += 1) {
        const a = await createRepoAgent(owner, { name: `Rename A ${rnd()}` });
        const b = await createRepoAgent(owner, { name: `Rename B ${rnd()}` });
        const slug = `taken-${rnd()}`;
        const result = await statuses([
          updateRepoAgent(owner, a.id, { slug }),
          updateRepoAgent(owner, b.id, { slug }),
        ]);
        expect(result.sort()).toEqual([200, 409]);
      }
    });

    it('holds the per-owner agent limit against two creates at once', async () => {
      const busy = await makeUser('upkeep-limit');
      for (let i = 0; i < AGENT_REPO.agentsPerOwner - 1; i += 1) {
        await getDb()
          .insert(schema.repoAgents)
          .values({ ownerId: busy.user.id, slug: `a-${i}`, name: `A ${i}` });
      }
      const result = await statuses([
        createRepoAgent(busy, { name: 'Last one' }),
        createRepoAgent(busy, { name: 'One too many' }),
      ]);
      expect(result.sort()).toEqual([200, 409]);
    });

    it('holds the per-session hourly write bound against writes fired at once', async () => {
      const agent = await createRepoAgent(owner, { name: `Budget ${rnd()}` });
      const s = await load(ownerAgent, agent.id);
      const { memory } = await rem(ownerAgent, agent.id, {
        session: s.session.id,
        name: 'busy',
        type: 'project',
        description: 'written to in a loop',
        body: 'start',
      });
      // One short of the bound: the create above is the first of them.
      await getDb()
        .insert(schema.repoAgentMemoryRevisions)
        .values(
          Array.from({ length: AGENT_REPO.writesPerSessionPerHour - 2 }, (_, i) => ({
            memoryId: memory.id,
            revision: i + 2,
            op: 'append' as const,
            type: 'project' as const,
            description: 'written to in a loop',
            body: 'start',
            source: 'agent' as const,
            sessionId: s.session.id,
          })),
        );
      const result = await statuses(
        Array.from({ length: 5 }, (_, i) =>
          rem(ownerAgent, agent.id, {
            session: s.session.id,
            name: 'busy',
            mode: 'append',
            body: `burst ${i}`,
          }),
        ),
      );
      expect(result.sort()).toEqual([200, 429, 429, 429, 429]);
    });

    it('holds the live-memory limit against two creates at once, and against a restore', async () => {
      const agent = await createRepoAgent(owner, { name: `Full ${rnd()}` });
      const fill = (count: number, prefix: string) =>
        getDb()
          .insert(schema.repoAgentMemories)
          .values(
            Array.from({ length: count }, (_, i) => ({
              agentId: agent.id,
              name: `${prefix}-${i}`,
              type: 'reference' as const,
              description: 'filler',
              body: 'filler',
            })),
          );
      await fill(AGENT_REPO.memoriesPerAgent - 1, 'm');
      const result = await statuses(
        ['last-one', 'one-too-many'].map((name) =>
          rem(owner, agent.id, { name, type: 'user', description: name, body: name }),
        ),
      );
      expect(result.sort()).toEqual([200, 409]);

      // Full now. A forgotten memory coming back would be one past the limit.
      const [gone] = await getDb()
        .insert(schema.repoAgentMemories)
        .values({
          agentId: agent.id,
          name: 'forgotten-one',
          type: 'user',
          description: 'gone',
          body: 'gone',
          forgottenAt: new Date(),
        })
        .returning();
      expect((await refusal(() => restoreMemory(owner, agent.id, must(gone).id))).status).toBe(409);
    });

    it('answers two edits of the same live prompt with one new version and one 409', async () => {
      // Device A is another agent of the owner's.
      const other = await createRepoAgent(owner, { name: `Racer ${rnd()}`, prompt: 'r' });
      const { session } = await load(ownerAgent, other.id);
      for (let round = 0; round < 3; round += 1) {
        const agent = await createRepoAgent(owner, { name: `Edit race ${rnd()}`, prompt: 'v1' });
        // Opted in, so device A's edit goes live whichever of the two takes the row lock first.
        // Otherwise A is held as a proposal (a 200) whenever it wins the lock, and the race flakes.
        await setAgentEditsLive(owner, agent.id, true);
        const result = await statuses([
          updatePrompt(ownerAgent, agent.id, {
            body: 'from device A',
            basedOn: 1,
            session: session.id,
          }),
          updatePrompt(owner, agent.id, { body: 'from device B', basedOn: 1 }),
        ]);
        expect(result.sort()).toEqual([200, 409]);
        const history = await listPromptVersions(owner, agent.id);
        expect(history.versions.map((v) => [v.version, v.status])).toEqual([
          [2, 'live'],
          [1, 'superseded'],
        ]);
      }
    });

    it('refuses a restore whose name a concurrent write takes, with a 409', async () => {
      const agent = await createRepoAgent(owner, { name: `Restore race ${rnd()}` });
      const { memory } = await rem(owner, agent.id, {
        name: 'contested',
        type: 'user',
        description: 'old',
        body: 'old',
      });
      await forget(owner, agent.id, { name: 'contested', reason: 'test' });
      const writer = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
      await writer.connect();
      try {
        // A new live memory under the same name, inserted but not committed:
        // the restore's check cannot see it, and its write waits on it.
        await writer.query('BEGIN');
        await writer.query(
          `INSERT INTO agent_memories (agent_id, name, type, description, body)
           VALUES ($1, 'contested', 'user', 'new', 'new')`,
          [agent.id],
        );
        const restore = restoreMemory(owner, agent.id, memory.id);
        restore.catch(() => undefined);
        await expect
          .poll(async () => blockedBehind(writer), { timeout: 3_000 })
          .toBeGreaterThanOrEqual(1);
        await writer.query('COMMIT');
        await expect(restore).rejects.toMatchObject({ status: 409 });
      } finally {
        await writer.end();
      }
    });
  });

  it('tells two connected apps with one name apart', async () => {
    const human = await makeUser('upkeep-apps');
    for (const [clientId, port, registered] of [
      [`lmstudio-a-${rnd()}`, 53682, '2026-09-01T10:00:00Z'],
      [`lmstudio-b-${rnd()}`, 61234, '2026-09-20T10:00:00Z'],
    ] as const) {
      await getDb()
        .insert(schema.oauthClients)
        .values({
          clientId,
          clientName: 'LM Studio',
          redirectUris: [`http://127.0.0.1:${port}/callback`, `http://127.0.0.1:${port}/other`],
          createdAt: new Date(registered),
        });
      await getDb()
        .insert(schema.oauthTokens)
        .values({
          accessTokenHash: `hash-${rnd()}-${clientId}`,
          clientId,
          userId: human.user.id,
          scope: TOKEN_SCOPES.join(' '),
          scopeConsented: true,
          expiresAt: new Date(Date.now() + 3_600_000),
        });
    }
    const grants = await listGrants(human);
    expect(grants.map((g) => [g.clientName, g.redirectHosts, g.registeredAt]).sort()).toEqual([
      ['LM Studio', ['127.0.0.1:53682'], '2026-09-01T10:00:00.000Z'],
      ['LM Studio', ['127.0.0.1:61234'], '2026-09-20T10:00:00.000Z'],
    ]);
  });

  it('pages prompt history without bodies, and bounds how often an agent rewrites its prompt', async () => {
    const agent = await createRepoAgent(owner, { name: `History ${rnd()}`, prompt: 'v1' });
    let live = 1;
    // Another agent of the owner's rewriting it, once the owner opted this one in: live, and bounded.
    await setAgentEditsLive({ ...owner, viaCookie: true }, agent.id, true);
    const other = await createRepoAgent(owner, { name: `Editor ${rnd()}`, prompt: 'e' });
    const { session } = await loadAgent(ownerAgent, other.id, loadAgentSchema.parse({}));
    for (let i = 0; i < AGENT_REPO.agentPromptVersionsPerDay; i += 1) {
      const edit = await updatePrompt(ownerAgent, agent.id, {
        body: `agent edit ${i}`,
        basedOn: live,
        session: session.id,
      });
      if (!('version' in edit)) throw new Error('expected a live version');
      live = edit.version;
    }
    const over = await refusal(() =>
      updatePrompt(ownerAgent, agent.id, {
        body: 'one too many',
        basedOn: live,
        session: session.id,
      }),
    );
    expect(over.status).toBe(429);
    expect(over.message).toMatch(/bound on a loop/);
    // Nothing was written by the refused edit, and a person is never bounded.
    expect((await getRepoAgent(owner, agent.id)).promptVersion).toBe(live);
    const person = await updatePrompt(owner, agent.id, { body: 'a person’s edit', basedOn: live });
    if (!('version' in person)) throw new Error('expected a live version');
    live = person.version;

    const seen: number[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await listPromptVersions(owner, agent.id, {
        limit: 4,
        ...(cursor ? { cursor } : {}),
      });
      for (const version of page.versions) expect(version.body).toBeUndefined();
      seen.push(...page.versions.map((v) => v.version));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(Array.from({ length: live }, (_, i) => live - i));
  });
});
