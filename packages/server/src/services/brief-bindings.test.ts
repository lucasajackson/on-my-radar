/**
 * Briefs bound to a repository (docs/AGENT_REPO.md §V2.17), against a real
 * Postgres of its own — the worker's claim scans the whole bindings table, so
 * a shared database would let another suite's bindings answer for this one.
 *
 * GitLab is a fake held in memory and handed to the worker step, so nothing
 * here touches the network, and nothing depends on the wall clock: "due" is
 * decided in Postgres against `checked_at`, and a test that needs a binding
 * due again moves `checked_at` back in SQL rather than waiting.
 *
 * The properties, each written so it fails if the enforcement goes:
 *
 * - binding is a person's act, the owner's alone, and only an administrator's
 *   agent may be bound (the tokens are the operator's);
 * - with no token the brief says "not checked", with a reason, never failed;
 * - the count is commits since the brief's revision, the mirror's own commits
 *   excluded, and a count for an older revision is never shown as current;
 * - the `stale` field reaches list_agent_briefs, get_agent_brief and the
 *   load_agent index;
 * - the mirror is off by default, writes only through a merge request from a
 *   branch of its own, never to the bound ref, and reuses its open request;
 * - an edit in the repository is drift, and is never imported;
 * - the offline snapshot carries the briefs, pinned for a pinned recipient.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  BRIEF_MIRROR_HEADER,
  BRIEF_REPO,
  TOKEN_SCOPES,
  briefBindingSchema,
  checkoutSchema,
  loadAgentSchema,
  readBriefMirror,
  renderBriefMirror,
  staleIndexNote,
  staleLabel,
  updateBriefSchema,
  type BriefStaleDto,
} from '@onmyradar/contract';
import { hashSecret, newApiToken, tokenPrefix } from '../auth/crypto.js';
import { resolveBearerToken } from '../auth/bearer.js';
import { closeDb, getDb, schema } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, setEnvForTesting } from '../env.js';
import { must } from '../errors.js';
import type { Actor } from '../http.js';
import { loadAgent, loadBlocks } from './agent-memory.js';
import { checkDueBriefBinding, isMirrorCommit } from './brief-bindings.js';
import { GitLabError, type GitLabClient, type GitLabCommit } from './gitlab.js';
import {
  acceptShare,
  checkoutAgent,
  createRepoAgent,
  deleteBrief,
  getBrief,
  listBriefs,
  removeBriefBinding,
  renameBrief,
  setBriefBinding,
  shareAgent,
  updateBrief,
} from './repo-agents.js';

/* --------------------------------- a fake GitLab --------------------------------- */

interface FakeCall {
  op: string;
  args: Record<string, unknown>;
}

class FakeGitLab {
  calls: FakeCall[] = [];
  tokens: string[] = [];
  commits: GitLabCommit[] = [];
  capped = false;
  files = new Map<string, string>();
  branches = new Set<string>();
  mrs: Array<{ iid: number; source: string; target: string; title: string; open: boolean }> = [];
  failWith: GitLabError | null = null;
  /** Fail only this operation, when set. */
  failOn: string | null = null;

  client = (token: string): GitLabClient => {
    this.tokens.push(token);
    const record = (op: string, args: Record<string, unknown>) => {
      this.calls.push({ op, args });
      if (this.failWith && (this.failOn === null || this.failOn === op)) throw this.failWith;
    };
    return {
      commitsSince: async (args) => {
        record('commitsSince', args);
        return { commits: this.commits.slice(0, args.cap), capped: this.capped };
      },
      latestCommits: async (args) => {
        record('latestCommits', args);
        return this.commits.slice(0, args.n);
      },
      readFile: async (args) => {
        record('readFile', args);
        return this.files.get(`${args.ref}:${args.path}`) ?? null;
      },
      branchExists: async (args) => {
        record('branchExists', args);
        return this.branches.has(args.branch);
      },
      createBranch: async (args) => {
        record('createBranch', args);
        this.branches.add(args.branch);
      },
      deleteBranch: async (args) => {
        record('deleteBranch', args);
        this.branches.delete(args.branch);
      },
      commitFile: async (args) => {
        record('commitFile', args);
        this.files.set(`${args.branch}:${args.path}`, args.content);
      },
      openMergeRequest: async (args) => {
        record('openMergeRequest', args);
        const mr = this.mrs.find(
          (m) => m.open && m.source === args.source && m.target === args.target,
        );
        return mr ? { iid: mr.iid, webUrl: `https://gitlab.test/mr/${mr.iid}` } : null;
      },
      createMergeRequest: async (args) => {
        record('createMergeRequest', args);
        const iid = this.mrs.length + 1;
        this.mrs.push({
          iid,
          source: args.source,
          target: args.target,
          title: args.title,
          open: true,
        });
        return { iid, webUrl: `https://gitlab.test/mr/${iid}` };
      },
      updateMergeRequest: async (args) => {
        record('updateMergeRequest', args);
        const mr = must(this.mrs.find((m) => m.iid === args.iid) ?? null);
        mr.title = args.title;
      },
    };
  };

  ops(): string[] {
    return this.calls.map((c) => c.op);
  }
}

const commit = (title: string, message = title): GitLabCommit => ({
  id: randomUUID().replaceAll('-', ''),
  shortId: randomUUID().slice(0, 8),
  title,
  message,
  committedAt: '2026-10-01T12:00:00Z',
  webUrl: `https://gitlab.test/commit/${title.replace(/\W+/g, '-')}`,
});

/* ----------------------------------- harness ----------------------------------- */

const rnd = () => Math.random().toString(36).slice(2, 8);

async function refusal(fn: () => Promise<unknown>): Promise<Error & { status?: number }> {
  try {
    await fn();
  } catch (err) {
    return err as Error & { status?: number };
  }
  throw new Error('expected a refusal, but the call succeeded');
}

describe.skipIf(!process.env['DATABASE_URL'])('brief bindings (isolated postgres)', () => {
  const database = `omr_bindings_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool;
  let base: NodeJS.ProcessEnv;
  let owner: Actor;
  let plain: Actor;
  let recipient: Actor;

  const configure = (extra: Record<string, string> = {}) =>
    setEnvForTesting(loadEnv({ ...base, ...extra }));
  const withToken = (extra: Record<string, string> = {}) =>
    configure({
      GITLAB_READ_TOKENS: JSON.stringify({ 'lucas/on-my-radar': 'read-token' }),
      ...extra,
    });

  async function makeUser(label: string, isAdmin: boolean): Promise<Actor> {
    const [user] = await getDb()
      .insert(schema.users)
      .values({ email: `${label}-${rnd()}@example.test`, state: 'active', name: label, isAdmin })
      .returning();
    return { user: must(user ?? null), kind: 'user', sessionId: `web-${rnd()}` };
  }

  async function agentOf(human: Actor): Promise<Actor> {
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
    const bearer = must(await resolveBearerToken(secret));
    return {
      user: bearer.user,
      kind: 'agent',
      tokenId: bearer.tokenId,
      scopes: bearer.scopes,
      ceiling: bearer.ceiling,
      connection: bearer.connection,
    };
  }

  const brief = (actor: Actor, agent: string, name: string, input: Record<string, unknown>) =>
    updateBrief(actor, agent, name, updateBriefSchema.parse(input));
  const bind = (actor: Actor, agent: string, name: string, input: Record<string, unknown>) =>
    setBriefBinding(actor, agent, name, briefBindingSchema.parse(input));

  /** An agent of the owner's with one brief, bound to a file in lucas/on-my-radar. */
  async function bound(input: Record<string, unknown> = {}) {
    const agent = await createRepoAgent(owner, { name: `Bound ${rnd()}`, prompt: 'p' });
    await brief(owner, agent.id, 'platform', { description: 'How it runs', body: 'v1 body' });
    await bind(owner, agent.id, 'platform', {
      project: 'lucas/on-my-radar',
      path: 'docs/AGENT-BRIEF.md',
      ...input,
    });
    return agent;
  }

  /** Make every binding due again, as an hour passing would — in SQL, never by waiting. */
  const age = () =>
    getDb().execute(
      sql`UPDATE agent_brief_bindings SET checked_at = checked_at - interval '2 hours'`,
    );

  /** Run the worker until nothing is due. */
  async function drain(fake: FakeGitLab): Promise<number> {
    let n = 0;
    while ((await checkDueBriefBinding(undefined, { client: fake.client })) > 0) n += 1;
    return n;
  }

  const staleOf = async (agentId: string, name = 'platform'): Promise<BriefStaleDto> =>
    must((await getBrief(owner, agentId, name)).stale);

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
    await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(must(process.env['DATABASE_URL'] ?? null));
    url.pathname = `/${database}`;
    base = {
      ...process.env,
      DATABASE_URL: url.toString(),
      SESSION_SECRET: 'bindings-only-test-secret-not-for-real-use',
      GITLAB_URL: 'https://gitlab.test',
      APP_URL: 'https://omr.test',
      GITLAB_READ_TOKENS: '',
      GITLAB_MIRROR_TOKENS: '',
      BRIEF_MIRROR_ENABLED: '',
    };
    configure();
    await runMigrations();
    owner = await makeUser('bind-owner', true);
    plain = await makeUser('bind-plain', false);
    recipient = await makeUser('bind-recipient', false);
  }, 30_000);

  beforeEach(async () => {
    configure();
    // Each test sees only its own bindings.
    await getDb().execute(sql`DELETE FROM agent_brief_bindings`);
  });

  afterAll(async () => {
    setEnvForTesting(null);
    await closeDb();
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end();
  });

  /* ---------------------------------- pure ---------------------------------- */

  describe('the contract', () => {
    it('refuses paths that escape the repository and a mirror onto a folder', () => {
      const ok = { project: 'lucas/on-my-radar', path: 'docs/AGENT-BRIEF.md' };
      expect(briefBindingSchema.parse(ok)).toMatchObject({ ref: 'main', mirror: false });
      for (const path of ['/etc/passwd', '../x', 'docs/../../x', 'docs/./x', 'a//b', '..']) {
        expect(briefBindingSchema.safeParse({ ...ok, path }).success, path).toBe(false);
      }
      for (const project of ['on-my-radar', 'https://evil.test/a/b', 'a/../b', '../a']) {
        expect(briefBindingSchema.safeParse({ ...ok, project }).success, project).toBe(false);
      }
      for (const ref of ['main..x', '/main', 'main/']) {
        expect(briefBindingSchema.safeParse({ ...ok, ref }).success, ref).toBe(false);
      }
      expect(briefBindingSchema.safeParse({ ...ok, path: 'packages/server/' }).success).toBe(true);
      expect(
        briefBindingSchema.safeParse({ ...ok, path: 'packages/server/', mirror: true }).success,
      ).toBe(false);
    });

    it('renders a mirror file that reads back to the revision and body it was written from', () => {
      const file = renderBriefMirror({
        agentSlug: 'onmyradar-architect',
        name: 'omr-platform',
        revision: 7,
        body: '# Platform\n\nfacts\n\n\n',
        url: 'https://omr.test/repo/x/briefs?b=omr-platform',
      });
      expect(file.split('\n')[0]).toContain(BRIEF_MIRROR_HEADER);
      expect(file.endsWith('facts\n')).toBe(true);
      expect(readBriefMirror(file)).toEqual({
        agentSlug: 'onmyradar-architect',
        name: 'omr-platform',
        revision: 7,
        body: '# Platform\n\nfacts\n',
      });
      expect(readBriefMirror('# Hand written\n')).toBeNull();
      expect(readBriefMirror(file.replace('r7', 'rX'))).toBeNull();
      // A revision no brief can have is not a header this server wrote.
      expect(readBriefMirror(file.replace('r7:', 'r99999999999:'))).toBeNull();
      expect(readBriefMirror(file.replace('r7:', 'r0:'))).toBeNull();
    });

    it('labels a count as a person and an agent read it', () => {
      const stale = (over: Partial<BriefStaleDto>): BriefStaleDto => ({
        repo: {
          project: 'lucas/on-my-radar',
          path: 'docs/',
          ref: 'main',
          mirror: false,
          url: null,
        },
        state: 'behind',
        commitsBehind: 3,
        capped: false,
        revision: 1,
        checkedAt: null,
        reason: null,
        drift: null,
        mirror: null,
        ...over,
      });
      expect(staleLabel(stale({}))).toBe('3 commits behind lucas/on-my-radar');
      expect(staleLabel(stale({ commitsBehind: 1 }))).toBe('1 commit behind lucas/on-my-radar');
      expect(staleLabel(stale({ commitsBehind: 100, capped: true }))).toBe(
        '100+ commits behind lucas/on-my-radar',
      );
      expect(staleLabel(stale({ state: 'not_checked', commitsBehind: null }))).toBe(
        'not checked against lucas/on-my-radar',
      );
      expect(
        staleIndexNote(
          stale({ drift: { kind: 'edited', commit: 'abc', title: 't', at: null, url: null } }),
        ),
      ).toBe('3 commits behind lucas/on-my-radar, drift: edited in repo');
      expect(staleIndexNote(null)).toBeNull();
    });

    it('knows the mirror’s own commits from the code moving', () => {
      expect(isMirrorCommit(commit(`${BRIEF_REPO.commitMarker} a/b r2`))).toBe(true);
      expect(
        isMirrorCommit(
          commit(
            "Merge branch 'omr-mirror/a/b' into 'main'",
            "Merge branch 'omr-mirror/a/b' into 'main'",
          ),
        ),
      ).toBe(true);
      expect(isMirrorCommit(commit('Fix the deploy'))).toBe(false);
    });
  });

  /* --------------------------------- binding -------------------------------- */

  describe('binding', () => {
    it('is the owner’s act on a real screen, and only for an administrator’s agent', async () => {
      const agent = await createRepoAgent(owner, { name: `Owned ${rnd()}`, prompt: 'p' });
      await brief(owner, agent.id, 'platform', { description: 'd', body: 'b' });
      const input = { project: 'lucas/on-my-radar', path: 'docs/AGENT-BRIEF.md' };

      const byAgent = await refusal(async () =>
        bind(await agentOf(owner), agent.id, 'platform', input),
      );
      expect(byAgent.status).toBe(403);
      // The service's own refusal, ahead of the token's ceiling: no transport can reach it.
      expect(byAgent.message).toMatch(/Ask the person to bind it/);

      await shareAgent(owner, agent.id, { email: recipient.user.email, preset: 'edit' });
      await acceptShare(recipient, agent.id);
      const byEditor = await refusal(() => bind(recipient, agent.id, 'platform', input));
      expect(byEditor.status).toBe(403);

      const theirs = await createRepoAgent(plain, { name: `Plain ${rnd()}`, prompt: 'p' });
      await brief(plain, theirs.id, 'platform', { description: 'd', body: 'b' });
      const notAdmin = await refusal(() => bind(plain, theirs.id, 'platform', input));
      expect(notAdmin.status).toBe(403);
      expect(notAdmin.message).toMatch(/administrators/);

      // None of those wrote anything.
      const rows = await getDb().select().from(schema.agentBriefBindings);
      expect(rows).toHaveLength(0);

      const stale = await bind(owner, agent.id, 'platform', input);
      expect(stale).toMatchObject({
        state: 'not_checked',
        reason: 'Not checked yet.',
        repo: {
          project: 'lucas/on-my-radar',
          path: 'docs/AGENT-BRIEF.md',
          ref: 'main',
          mirror: false,
        },
        mirror: null,
      });
      expect(stale.repo.url).toBe(
        'https://gitlab.test/lucas/on-my-radar/-/blob/main/docs/AGENT-BRIEF.md',
      );

      const unbindByAgent = await refusal(async () =>
        removeBriefBinding(await agentOf(owner), agent.id, 'platform'),
      );
      expect(unbindByAgent.status).toBe(403);
      expect(unbindByAgent.message).toMatch(/Ask them to do it/);
      await removeBriefBinding(owner, agent.id, 'platform');
      expect((await getBrief(owner, agent.id, 'platform')).stale).toBeNull();
      expect((await refusal(() => removeBriefBinding(owner, agent.id, 'platform'))).status).toBe(
        404,
      );
    });

    it('follows a rename and goes with a delete', async () => {
      const agent = await bound();
      await renameBrief(owner, agent.id, 'platform', { newName: 'omr-platform' });
      expect((await getBrief(owner, agent.id, 'omr-platform')).stale?.repo.project).toBe(
        'lucas/on-my-radar',
      );
      await deleteBrief(owner, agent.id, 'omr-platform');
      expect(await getDb().select().from(schema.agentBriefBindings)).toHaveLength(0);
    });
  });

  /* --------------------------------- checking -------------------------------- */

  describe('the stale check', () => {
    it('says "not checked" with a reason when the server has no token — never failed, never a call', async () => {
      const agent = await bound();
      const fake = new FakeGitLab();
      expect(await drain(fake)).toBe(1);
      expect(fake.calls).toHaveLength(0);
      const stale = await staleOf(agent.id);
      expect(stale).toMatchObject({
        state: 'not_checked',
        commitsBehind: null,
        reason: 'This server has no read token for lucas/on-my-radar.',
      });
      expect(staleLabel(stale)).toBe('not checked against lucas/on-my-radar');
    });

    it('with no GITLAB_URL a binding has no link and reads "not checked", token or not', async () => {
      withToken({ GITLAB_URL: undefined as unknown as string });
      const agent = await bound();
      const fake = new FakeGitLab();
      expect(await drain(fake)).toBe(1);
      expect(fake.calls).toHaveLength(0);
      const stale = await staleOf(agent.id);
      expect(stale.state).toBe('not_checked');
      expect(stale.reason).toContain('GITLAB_URL');
      expect(stale.repo.url).toBeNull();
    });

    it('counts commits since the brief’s revision, without the mirror’s own, through every transport', async () => {
      withToken();
      const agent = await bound({ path: 'packages/server/' });
      const fake = new FakeGitLab();
      fake.commits = [
        commit('Move the worker lane'),
        commit(`${BRIEF_REPO.commitMarker} x/platform r1`),
        commit('Add the binding table'),
      ];
      expect(await drain(fake)).toBe(1);
      expect(fake.tokens).toEqual(['read-token']);
      const [call] = fake.calls;
      expect(call?.op).toBe('commitsSince');
      // `since` is the brief revision's own time, from Postgres, to the second.
      const [row] = await getDb()
        .execute<{ since: string }>(
          sql`SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS since
              FROM agent_briefs WHERE agent_id = ${agent.id}::uuid`,
        )
        .then((r) => r.rows);
      expect(call?.args).toMatchObject({
        project: 'lucas/on-my-radar',
        ref: 'main',
        path: 'packages/server/',
        since: row?.since,
        cap: BRIEF_REPO.commitsCap,
      });

      const stale = await staleOf(agent.id);
      expect(stale).toMatchObject({
        state: 'behind',
        commitsBehind: 2,
        capped: false,
        revision: 1,
      });
      expect(stale.checkedAt).not.toBeNull();
      expect(stale.repo.url).toBe(
        'https://gitlab.test/lucas/on-my-radar/-/tree/main/packages/server',
      );

      // list_agent_briefs and load_agent carry the same field.
      const [listed] = await listBriefs(owner, agent.id);
      expect(listed?.stale).toEqual(stale);
      const loaded = await loadAgent(owner, agent.id, loadAgentSchema.parse({ harness: 'test' }));
      const text = loadBlocks(loaded).join('\n');
      expect(text).toContain('· stale: 2 commits behind lucas/on-my-radar');
      const summary = JSON.parse(must(loadBlocks(loaded).at(-1) ?? null)) as { stale?: unknown };
      expect(summary.stale).toEqual({ platform: '2 commits behind lucas/on-my-radar' });

      // Not due again straight away: the lane sleeps.
      expect(await drain(fake)).toBe(0);
    });

    it('never shows a count measured for an older revision as current', async () => {
      withToken();
      const agent = await bound();
      const fake = new FakeGitLab();
      fake.commits = [commit('One'), commit('Two')];
      await drain(fake);
      expect((await staleOf(agent.id)).state).toBe('behind');

      await brief(owner, agent.id, 'platform', { body: 'v2 body', expectedRevision: 1 });
      expect(await staleOf(agent.id)).toMatchObject({
        state: 'not_checked',
        commitsBehind: null,
        reason: 'The brief changed since the last check; it is checked again shortly.',
      });

      // Due a couple of minutes after the change — moved back in SQL, not waited for.
      await getDb().execute(
        sql`UPDATE agent_brief_bindings SET checked_at = checked_at - interval '5 minutes'`,
      );
      fake.commits = [];
      expect(await drain(fake)).toBe(1);
      expect(await staleOf(agent.id)).toMatchObject({
        state: 'current',
        commitsBehind: 0,
        revision: 2,
      });
    });

    it('reports a GitLab failure in words, and a count that hit the cap as "100+"', async () => {
      withToken();
      const agent = await bound();
      const fake = new FakeGitLab();
      fake.failWith = new GitLabError(401, 'GitLab answered 401: 401 Unauthorized');
      await drain(fake);
      expect(await staleOf(agent.id)).toMatchObject({
        state: 'failed',
        reason: 'GitLab answered 401: 401 Unauthorized',
      });

      fake.failWith = null;
      fake.commits = Array.from({ length: BRIEF_REPO.commitsCap }, (_, i) => commit(`c${i}`));
      fake.capped = true;
      await age();
      await drain(fake);
      const stale = await staleOf(agent.id);
      expect(stale).toMatchObject({ state: 'behind', capped: true });
      expect(staleLabel(stale)).toBe('100+ commits behind lucas/on-my-radar');
    });

    it('stops using the server’s token when the owner is no longer an administrator', async () => {
      withToken();
      const agent = await bound();
      await getDb()
        .update(schema.users)
        .set({ isAdmin: false })
        .where(eq(schema.users.id, owner.user.id));
      try {
        const fake = new FakeGitLab();
        await drain(fake);
        expect(fake.calls).toHaveLength(0);
        expect(await staleOf(agent.id)).toMatchObject({
          state: 'not_checked',
          reason: expect.stringMatching(/administrators/) as unknown,
        });
      } finally {
        await getDb()
          .update(schema.users)
          .set({ isAdmin: true })
          .where(eq(schema.users.id, owner.user.id));
      }
    });

    it('starts again from nothing when the binding points somewhere new', async () => {
      withToken();
      const agent = await bound();
      const fake = new FakeGitLab();
      fake.commits = [commit('One')];
      await drain(fake);
      expect((await staleOf(agent.id)).state).toBe('behind');
      const moved = await bind(owner, agent.id, 'platform', {
        project: 'lucas/on-my-radar',
        path: 'docs/',
      });
      expect(moved).toMatchObject({ state: 'not_checked', reason: 'Not checked yet.' });
    });
  });

  /* ------------------------------ mirror and drift ----------------------------- */

  describe('the one-way mirror', () => {
    const mirrorOn = () =>
      withToken({
        BRIEF_MIRROR_ENABLED: 'true',
        GITLAB_MIRROR_TOKENS: JSON.stringify({ 'lucas/on-my-radar': 'write-token' }),
      });

    it('is off unless the server turns it on, and then writes nothing', async () => {
      withToken({ GITLAB_MIRROR_TOKENS: JSON.stringify({ 'lucas/on-my-radar': 'write-token' }) });
      const agent = await bound({ mirror: true });
      const fake = new FakeGitLab();
      await drain(fake);
      expect(fake.tokens).not.toContain('write-token');
      expect(fake.ops()).not.toContain('commitFile');
      expect((await staleOf(agent.id)).mirror).toMatchObject({
        state: 'disabled',
        reason: 'Mirroring is turned off on this server.',
      });
    });

    it('opens a merge request from its own branch — never a push to the bound ref — and reuses it', async () => {
      mirrorOn();
      const agent = await bound({ mirror: true });
      const fake = new FakeGitLab();
      await drain(fake);

      const writes = fake.calls.filter((c) => c.op === 'commitFile');
      expect(writes).toHaveLength(1);
      const write = must(writes[0] ?? null).args;
      expect(write['branch']).toBe(`omr-mirror/${agent.slug}/platform`);
      expect(write['branch']).not.toBe('main');
      expect(write['path']).toBe('docs/AGENT-BRIEF.md');
      expect(write['create']).toBe(true);
      expect(String(write['message'])).toContain(BRIEF_REPO.commitMarker);
      const content = String(write['content']);
      expect(content.split('\n')[0]).toContain(BRIEF_MIRROR_HEADER);
      expect(readBriefMirror(content)).toMatchObject({ revision: 1, body: 'v1 body\n' });
      expect(fake.files.has('main:docs/AGENT-BRIEF.md')).toBe(false);
      expect(fake.mrs).toEqual([
        expect.objectContaining({
          source: `omr-mirror/${agent.slug}/platform`,
          target: 'main',
          open: true,
        }),
      ]);
      expect((await staleOf(agent.id)).mirror).toEqual({
        state: 'opened',
        revision: 1,
        mergeRequestUrl: 'https://gitlab.test/mr/1',
        reason: null,
      });

      // A new revision updates the same open request.
      await brief(owner, agent.id, 'platform', { body: 'v2 body', expectedRevision: 1 });
      expect((await staleOf(agent.id)).mirror?.state).toBe('pending');
      await getDb().execute(
        sql`UPDATE agent_brief_bindings SET checked_at = checked_at - interval '5 minutes'`,
      );
      await drain(fake);
      expect(fake.mrs).toHaveLength(1);
      expect(fake.ops()).toContain('updateMergeRequest');
      expect(fake.mrs[0]?.title).toContain('r2');
      expect(
        readBriefMirror(
          must(fake.files.get(`omr-mirror/${agent.slug}/platform:docs/AGENT-BRIEF.md`) ?? null),
        ),
      ).toMatchObject({ revision: 2, body: 'v2 body\n' });
      expect(
        fake.calls.filter((c) => c.op === 'commitFile').every((c) => c.args['branch'] !== 'main'),
      ).toBe(true);
    });

    it('says why when it cannot write, and the binding still counts commits', async () => {
      withToken({ BRIEF_MIRROR_ENABLED: 'true' });
      const agent = await bound({ mirror: true });
      const fake = new FakeGitLab();
      fake.commits = [commit('One')];
      await drain(fake);
      const stale = await staleOf(agent.id);
      expect(stale.state).toBe('behind');
      expect(stale.mirror).toMatchObject({
        state: 'failed',
        reason: 'This server has no mirror token for lucas/on-my-radar.',
      });
    });
  });

  describe('a server with malformed token settings', () => {
    it('reads "not checked" and a mirror that is off, and calls nothing', async () => {
      configure({
        GITLAB_READ_TOKENS: 'glpat-not-json',
        GITLAB_MIRROR_TOKENS: '["glpat-x"]',
        BRIEF_MIRROR_ENABLED: 'true',
      });
      const agent = await bound({ mirror: true });
      const fake = new FakeGitLab();
      await drain(fake);
      expect(fake.calls).toHaveLength(0);
      const stale = await staleOf(agent.id);
      expect(stale).toMatchObject({
        state: 'not_checked',
        reason:
          'This server’s GitLab read tokens are misconfigured; its operator has been told in the log.',
      });
      expect(stale.mirror?.state).toBe('disabled');
    });
  });

  describe('drift', () => {
    const header = (agentSlug: string, revision: number, body: string) =>
      renderBriefMirror({ agentSlug, name: 'platform', revision, body, url: 'https://omr.test/x' });

    it('is a mirrored file edited in the repository — reported, never imported', async () => {
      withToken();
      const agent = await bound({ mirror: true });
      const fake = new FakeGitLab();
      fake.files.set(
        'main:docs/AGENT-BRIEF.md',
        header(agent.slug, 1, 'v1 body — and a hand edit'),
      );
      fake.commits = [
        commit('Tweak the brief by hand'),
        commit(`${BRIEF_REPO.commitMarker} ${agent.slug}/platform r1`),
      ];
      await drain(fake);
      const stale = await staleOf(agent.id);
      expect(stale.drift).toMatchObject({
        kind: 'edited',
        title: 'Tweak the brief by hand',
        url: 'https://gitlab.test/commit/Tweak-the-brief-by-hand',
      });
      expect(staleIndexNote(stale)).toContain('drift: edited in repo');

      // Nothing came back into On My Radar.
      const read = await getBrief(owner, agent.id, 'platform');
      expect(read).toMatchObject({ revision: 1, body: 'v1 body' });
    });

    it('is a header naming a revision no brief can have — unrecognised, and the count still recorded', async () => {
      withToken();
      const agent = await bound({ mirror: true });
      const fake = new FakeGitLab();
      fake.files.set(
        'main:docs/AGENT-BRIEF.md',
        header(agent.slug, 1, 'v1 body').replace('r1:', 'r99999999999:'),
      );
      fake.commits = [commit('Bump the revision by hand')];
      expect(await drain(fake)).toBe(1);
      const stale = await staleOf(agent.id);
      expect(stale).toMatchObject({ state: 'behind', commitsBehind: 1 });
      expect(stale.drift).toMatchObject({ kind: 'edited', title: 'Bump the revision by hand' });
    });

    it('keeps the count when the file cannot be read for drift', async () => {
      withToken();
      const agent = await bound({ mirror: true });
      const fake = new FakeGitLab();
      fake.commits = [commit('One'), commit('Two')];
      fake.failOn = 'readFile';
      fake.failWith = new GitLabError(500, 'GitLab answered 500');
      await drain(fake);
      expect(await staleOf(agent.id)).toMatchObject({
        state: 'behind',
        commitsBehind: 2,
        drift: null,
      });
    });

    it('is not a mirror that landed as written, nor the hand-written file a first mirror replaces', async () => {
      withToken();
      const agent = await bound({ mirror: true });
      const fake = new FakeGitLab();
      fake.files.set('main:docs/AGENT-BRIEF.md', '# The old hand-written brief\n');
      await drain(fake);
      expect((await staleOf(agent.id)).drift).toBeNull();

      fake.files.set('main:docs/AGENT-BRIEF.md', header(agent.slug, 1, 'v1 body'));
      await age();
      await drain(fake);
      expect((await staleOf(agent.id)).drift).toBeNull();

      // Once a mirror has landed, losing its header is drift.
      fake.files.set('main:docs/AGENT-BRIEF.md', '# Rewritten by hand\n');
      fake.commits = [commit('Rewrite the brief')];
      await age();
      await drain(fake);
      expect((await staleOf(agent.id)).drift).toMatchObject({
        kind: 'edited',
        title: 'Rewrite the brief',
      });

      // And so is the file going.
      fake.files.delete('main:docs/AGENT-BRIEF.md');
      fake.commits = [commit('Remove the brief')];
      await age();
      await drain(fake);
      const gone = await staleOf(agent.id);
      expect(gone.drift).toMatchObject({ kind: 'deleted', title: 'Remove the brief' });
      expect(staleIndexNote(gone)).toContain('drift: deleted in repo');
    });
  });

  /* ---------------------------------- snapshot --------------------------------- */

  describe('the offline snapshot', () => {
    it('carries the briefs, each as the caller runs it', async () => {
      const agent = await createRepoAgent(owner, { name: `Snap ${rnd()}`, prompt: 'p' });
      await brief(owner, agent.id, 'platform', { description: 'How it "runs"', body: 'r1 facts' });
      await shareAgent(owner, agent.id, { email: plain.user.email, preset: 'use' });
      await acceptShare(plain, agent.id);
      await brief(owner, agent.id, 'platform', { body: 'r2 facts', expectedRevision: 1 });

      const files = async (actor: Actor) =>
        Object.fromEntries(
          (
            await checkoutAgent(
              actor,
              agent.id,
              checkoutSchema.parse({ harness: 'claude-code', snapshot: true }),
            )
          ).operations.flatMap((op) => ('content' in op ? [[op.path, op.content]] : [])),
        );
      const mine = await files(owner);
      const path = `.omr/snapshot/${agent.slug}/briefs/platform.md`;
      expect(mine[path]).toBe(
        '---\nname: platform\nrevision: 2\ndescription: "How it \\"runs\\""\n---\n\nr2 facts\n',
      );
      // A pinned recipient's snapshot holds the revision they accepted.
      expect((await files(plain))[path]).toContain('revision: 1\n');
      expect((await files(plain))[path]).toContain('r1 facts');

      // Without snapshot, no brief files.
      const plainCheckout = await checkoutAgent(
        owner,
        agent.id,
        checkoutSchema.parse({ harness: 'claude-code' }),
      );
      expect(plainCheckout.operations.some((op) => op.path.includes('/briefs/'))).toBe(false);
    });
  });
});
