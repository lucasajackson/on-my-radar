/**
 * The GitLab client the brief-binding worker uses, against a fake `fetch`:
 * what it asks for, where, with which credential, and what it refuses to do —
 * follow a redirect with the token, read an unbounded body, or repeat the
 * token in an error a person will read.
 */
import { describe, expect, it } from 'vitest';
import { loadEnv, reportTokenErrors } from '../env.js';
import { GitLabError, gitlabClient, type FetchLike } from './gitlab.js';

interface Seen {
  url: string;
  init: RequestInit;
}

function fakeFetch(answer: (url: string, init: RequestInit) => Response | Promise<Response>): {
  fetch: FetchLike;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: async (url, init) => {
      seen.push({ url, init });
      return answer(url, init);
    },
  };
}

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });

const commit = (i: number) => ({
  id: `sha${i}`.padEnd(40, '0'),
  short_id: `sha${i}`,
  title: `commit ${i}`,
  message: `commit ${i}\n`,
  committed_date: '2026-10-01T12:00:00.000Z',
  web_url: `https://gitlab.test/c/${i}`,
});

describe('gitlabClient', () => {
  it('asks the operator’s host for one project, percent-encoded, with the token in a header', async () => {
    const { fetch, seen } = fakeFetch(() => json([commit(1)]));
    const client = gitlabClient('https://gitlab.test/', 'glpat-secret', fetch);
    const { commits, capped } = await client.commitsSince({
      project: 'lucas/on-my-radar',
      ref: 'main',
      path: 'packages/server/',
      since: '2026-10-01T00:00:00Z',
      cap: 100,
    });
    expect(commits).toEqual([
      {
        id: 'sha1'.padEnd(40, '0'),
        shortId: 'sha1',
        title: 'commit 1',
        message: 'commit 1\n',
        committedAt: '2026-10-01T12:00:00.000Z',
        webUrl: 'https://gitlab.test/c/1',
      },
    ]);
    expect(capped).toBe(false);
    const [call] = seen;
    const url = new URL(call?.url ?? '');
    expect(url.origin).toBe('https://gitlab.test');
    expect(url.pathname).toBe('/api/v4/projects/lucas%2Fon-my-radar/repository/commits');
    // A folder binding is a path prefix to GitLab, without its slash.
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      ref_name: 'main',
      path: 'packages/server',
      since: '2026-10-01T00:00:00Z',
      per_page: '100',
    });
    expect((call?.init.headers as Record<string, string>)['PRIVATE-TOKEN']).toBe('glpat-secret');
    expect(url.search).not.toContain('glpat');
    expect(call?.init.redirect).toBe('manual');
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('pages until the cap and says when there were more', async () => {
    const { fetch, seen } = fakeFetch((url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      return json(
        Array.from({ length: 3 }, (_, i) => commit(page * 10 + i)),
        page < 5 ? { 'x-next-page': String(page + 1) } : {},
      );
    });
    const client = gitlabClient('https://gitlab.test', 't', fetch);
    const result = await client.commitsSince({
      project: 'a/b',
      ref: 'main',
      path: 'x',
      since: '2026-10-01T00:00:00Z',
      cap: 3,
    });
    expect(result.commits).toHaveLength(3);
    expect(result.capped).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('reads a file, and a missing one is null rather than an error', async () => {
    const { fetch, seen } = fakeFetch((url) =>
      url.includes('missing')
        ? new Response('{"message":"404 File Not Found"}', { status: 404 })
        : new Response('# brief\n'),
    );
    const client = gitlabClient('https://gitlab.test', 't', fetch);
    expect(
      await client.readFile({ project: 'a/b', ref: 'main', path: 'docs/AGENT-BRIEF.md' }),
    ).toBe('# brief\n');
    expect(new URL(seen[0]?.url ?? '').pathname).toBe(
      '/api/v4/projects/a%2Fb/repository/files/docs%2FAGENT-BRIEF.md/raw',
    );
    expect(await client.readFile({ project: 'a/b', ref: 'main', path: 'missing.md' })).toBeNull();
  });

  it('turns a refusal into GitLab’s words without the token, and refuses a redirect', async () => {
    const client = gitlabClient(
      'https://gitlab.test',
      'glpat-secret',
      fakeFetch(() => new Response('{"message":"401 Unauthorized"}', { status: 401 })).fetch,
    );
    const err = await client
      .readFile({ project: 'a/b', ref: 'main', path: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitLabError);
    expect((err as GitLabError).message).toBe('GitLab answered 401: 401 Unauthorized');
    expect((err as GitLabError).message).not.toContain('glpat');

    const redirected = gitlabClient(
      'https://gitlab.test',
      'glpat-secret',
      fakeFetch(
        () => new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }),
      ).fetch,
    );
    const moved = await redirected
      .branchExists({ project: 'a/b', branch: 'x' })
      .catch((e: unknown) => e);
    expect(moved).toBeInstanceOf(GitLabError);
    expect((moved as GitLabError).status).toBe(302);
  });

  it('refuses an answer past its size cap', async () => {
    const client = gitlabClient(
      'https://gitlab.test',
      't',
      fakeFetch(() => new Response('x'.repeat(300_000))).fetch,
    );
    const err = await client
      .readFile({ project: 'a/b', ref: 'main', path: 'big' })
      .catch((e: unknown) => e);
    expect((err as GitLabError).message).toMatch(/over 262144 bytes/);
  });

  it('opens a merge request that removes its branch when merged', async () => {
    const { fetch, seen } = fakeFetch(() => json({ iid: 7, web_url: 'https://gitlab.test/mr/7' }));
    const client = gitlabClient('https://gitlab.test', 't', fetch);
    expect(
      await client.createMergeRequest({
        project: 'a/b',
        source: 'omr-mirror/x/y',
        target: 'main',
        title: 't',
        description: 'd',
      }),
    ).toEqual({ iid: 7, webUrl: 'https://gitlab.test/mr/7' });
    expect(seen[0]?.init.method).toBe('POST');
    expect(JSON.parse(seen[0]?.init.body as string)).toMatchObject({
      source_branch: 'omr-mirror/x/y',
      target_branch: 'main',
      remove_source_branch: true,
    });
  });
});

describe('GitLab configuration', () => {
  const base = { DATABASE_URL: 'postgres://x/y', SESSION_SECRET: 'x'.repeat(32) };

  it('reads project-scoped tokens as a JSON map, empty when unset, and the mirror off by default', () => {
    const config = loadEnv({
      ...base,
      GITLAB_READ_TOKENS: '{"lucas/on-my-radar":"glpat-r"}',
    });
    expect(config.GITLAB_READ_TOKENS).toEqual({ 'lucas/on-my-radar': 'glpat-r' });
    expect(config.GITLAB_MIRROR_TOKENS).toEqual({});
    expect(config.BRIEF_MIRROR_ENABLED).toBe(false);
    expect(config.GITLAB_URL).toBeUndefined();
    expect(loadEnv({ ...base, GITLAB_URL: 'https://git.example.com/' }).GITLAB_URL).toBe(
      'https://git.example.com',
    );
  });

  it('boots past a malformed map: that feature is off, and the log names it without the value', () => {
    for (const value of ['glpat-plain', '["glpat-x"]', '{"a/b":""}', '{"a/b":1}']) {
      const config = loadEnv({
        ...base,
        GITLAB_READ_TOKENS: value,
        GITLAB_MIRROR_TOKENS: value,
        BRIEF_MIRROR_ENABLED: 'true',
      });
      expect(config.GITLAB_READ_TOKENS, value).toEqual({});
      expect(config.GITLAB_MIRROR_TOKENS).toEqual({});
      expect(config.GITLAB_TOKEN_ERRORS).toEqual(['GITLAB_READ_TOKENS', 'GITLAB_MIRROR_TOKENS']);
      // A mirror whose tokens cannot be read is off.
      expect(config.BRIEF_MIRROR_ENABLED).toBe(false);

      const logged: Array<{ obj: object; msg: string }> = [];
      reportTokenErrors(config, { error: (obj, msg) => logged.push({ obj, msg }) });
      expect(logged.map((l) => l.obj)).toEqual([
        { setting: 'GITLAB_READ_TOKENS' },
        { setting: 'GITLAB_MIRROR_TOKENS' },
      ]);
      expect(logged[0]?.msg).toMatch(/repository checks are off/);
      expect(logged[1]?.msg).toMatch(/mirror is off/);
      expect(JSON.stringify(logged)).not.toContain('glpat');
    }
    // A good mirror map beside a bad read map keeps the mirror's own setting.
    const mixed = loadEnv({
      ...base,
      GITLAB_READ_TOKENS: 'nope',
      GITLAB_MIRROR_TOKENS: '{"a/b":"t"}',
      BRIEF_MIRROR_ENABLED: 'true',
    });
    expect(mixed.GITLAB_TOKEN_ERRORS).toEqual(['GITLAB_READ_TOKENS']);
    expect(mixed.BRIEF_MIRROR_ENABLED).toBe(true);
    expect(loadEnv(base).GITLAB_TOKEN_ERRORS).toEqual([]);
  });
});
