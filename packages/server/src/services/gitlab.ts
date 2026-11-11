/**
 * The little of GitLab's REST API (v4) a brief binding needs: commits touching
 * a path, one file's bytes, and — for the one-way mirror — a branch, a commit
 * and a merge request. Nothing else, so a token handed to this module can do
 * nothing the binding feature does not.
 *
 * The host is `GITLAB_URL`, the operator's, never a user's: a binding names a
 * project and a path on that host, both validated by `briefBindingSchema` and
 * percent-encoded into the URL here. Redirects are refused rather than
 * followed, so a token is never replayed to another origin. Every request has
 * a deadline and every body a size cap. Error messages carry the status and
 * GitLab's own words, never the token.
 */

export interface GitLabCommit {
  id: string;
  shortId: string;
  title: string;
  message: string;
  committedAt: string;
  webUrl: string | null;
}

export class GitLabError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GitLabError';
  }
}

export interface GitLabClient {
  /**
   * Commits on `ref` touching `path`, newest first, committed after `since`,
   * up to `cap`. `capped` says there were more.
   */
  commitsSince(input: {
    project: string;
    ref: string;
    path: string;
    since: string;
    cap: number;
  }): Promise<{ commits: GitLabCommit[]; capped: boolean }>;
  /** The newest `n` commits on `ref` touching `path`. */
  latestCommits(input: {
    project: string;
    ref: string;
    path: string;
    n: number;
  }): Promise<GitLabCommit[]>;
  /** A file's text at `ref`, or null when there is no such file. */
  readFile(input: { project: string; ref: string; path: string }): Promise<string | null>;
  branchExists(input: { project: string; branch: string }): Promise<boolean>;
  createBranch(input: { project: string; branch: string; ref: string }): Promise<void>;
  deleteBranch(input: { project: string; branch: string }): Promise<void>;
  /** One commit writing one file on `branch`. */
  commitFile(input: {
    project: string;
    branch: string;
    path: string;
    content: string;
    create: boolean;
    message: string;
  }): Promise<void>;
  /** The open merge request from `source` into `target`, if there is one. */
  openMergeRequest(input: {
    project: string;
    source: string;
    target: string;
  }): Promise<{ iid: number; webUrl: string } | null>;
  createMergeRequest(input: {
    project: string;
    source: string;
    target: string;
    title: string;
    description: string;
  }): Promise<{ iid: number; webUrl: string }>;
  updateMergeRequest(input: {
    project: string;
    iid: number;
    title: string;
    description: string;
  }): Promise<void>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 10_000;
const BODY_CAP = 1_048_576;
const FILE_CAP = 262_144;

const enc = encodeURIComponent;

/** The most GitLab may say back about a failure, in a stored error. */
function shortReason(status: number, text: string): string {
  let detail = text;
  try {
    const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
    const m = parsed.message ?? parsed.error;
    if (m !== undefined) detail = typeof m === 'string' ? m : JSON.stringify(m);
  } catch {
    // not JSON: keep the text
  }
  detail = detail.replace(/\s+/g, ' ').trim().slice(0, 200);
  return `GitLab answered ${status}${detail ? `: ${detail}` : ''}`;
}

function commitFrom(raw: Record<string, unknown>): GitLabCommit {
  const s = (k: string) => {
    const v = raw[k];
    return typeof v === 'string' ? v : '';
  };
  return {
    id: s('id'),
    shortId: s('short_id') || s('id').slice(0, 8),
    title: s('title'),
    message: s('message'),
    committedAt: s('committed_date') || s('created_at'),
    webUrl: s('web_url') || null,
  };
}

export function gitlabClient(
  baseUrl: string,
  token: string,
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): GitLabClient {
  const api = `${baseUrl.replace(/\/+$/, '')}/api/v4`;

  async function call(
    method: string,
    path: string,
    options: { body?: unknown; allow404?: boolean; cap?: number } = {},
  ): Promise<{ status: number; text: string; headers: Headers } | null> {
    let res: Response;
    try {
      res = await fetchImpl(`${api}${path}`, {
        method,
        headers: {
          'PRIVATE-TOKEN': token,
          accept: 'application/json',
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const why = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'unreachable';
      throw new GitLabError(0, `GitLab ${why}`);
    }
    const cap = options.cap ?? BODY_CAP;
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > cap) throw new GitLabError(res.status, `GitLab's answer is over ${cap} bytes`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > cap)
      throw new GitLabError(res.status, `GitLab's answer is over ${cap} bytes`);
    const text = new TextDecoder().decode(buf);
    if (res.status === 404 && options.allow404) return null;
    if (res.status < 200 || res.status >= 300)
      throw new GitLabError(res.status, shortReason(res.status, text));
    return { status: res.status, text, headers: res.headers };
  }

  const json = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      throw new GitLabError(200, 'GitLab answered with something that is not JSON');
    }
  };

  const project = (p: string) => `/projects/${enc(p)}`;

  async function listCommits(input: {
    project: string;
    ref: string;
    path: string;
    since?: string;
    want: number;
  }): Promise<{ commits: GitLabCommit[]; more: boolean }> {
    const perPage = Math.min(100, Math.max(1, input.want));
    const commits: GitLabCommit[] = [];
    let page = 1;
    // Folder bindings end in '/'; GitLab matches a path prefix without it.
    const path = input.path.replace(/\/+$/, '');
    for (;;) {
      const query = new URLSearchParams({
        ref_name: input.ref,
        path,
        per_page: String(perPage),
        page: String(page),
        ...(input.since ? { since: input.since } : {}),
      });
      const res = await call(
        'GET',
        `${project(input.project)}/repository/commits?${query.toString()}`,
      );
      const rows = json(must(res).text);
      if (!Array.isArray(rows))
        throw new GitLabError(200, 'GitLab listed commits as something else');
      for (const row of rows)
        if (row && typeof row === 'object')
          commits.push(commitFrom(row as Record<string, unknown>));
      const next = must(res).headers.get('x-next-page');
      if (commits.length >= input.want)
        return {
          commits: commits.slice(0, input.want),
          more: commits.length > input.want || Boolean(next),
        };
      if (!next || rows.length === 0) return { commits, more: false };
      page += 1;
    }
  }

  return {
    async commitsSince({ project: p, ref, path, since, cap }) {
      const { commits, more } = await listCommits({ project: p, ref, path, since, want: cap });
      return { commits, capped: more };
    },
    async latestCommits({ project: p, ref, path, n }) {
      return (await listCommits({ project: p, ref, path, want: n })).commits;
    },
    async readFile({ project: p, ref, path }) {
      const res = await call(
        'GET',
        `${project(p)}/repository/files/${enc(path)}/raw?${new URLSearchParams({ ref }).toString()}`,
        { allow404: true, cap: FILE_CAP },
      );
      return res ? res.text : null;
    },
    async branchExists({ project: p, branch }) {
      return (
        (await call('GET', `${project(p)}/repository/branches/${enc(branch)}`, {
          allow404: true,
        })) !== null
      );
    },
    async createBranch({ project: p, branch, ref }) {
      await call(
        'POST',
        `${project(p)}/repository/branches?${new URLSearchParams({ branch, ref }).toString()}`,
      );
    },
    async deleteBranch({ project: p, branch }) {
      await call('DELETE', `${project(p)}/repository/branches/${enc(branch)}`, { allow404: true });
    },
    async commitFile({ project: p, branch, path, content, create, message }) {
      await call('POST', `${project(p)}/repository/commits`, {
        body: {
          branch,
          commit_message: message,
          actions: [{ action: create ? 'create' : 'update', file_path: path, content }],
        },
      });
    },
    async openMergeRequest({ project: p, source, target }) {
      const query = new URLSearchParams({
        state: 'opened',
        source_branch: source,
        target_branch: target,
      });
      const res = await call('GET', `${project(p)}/merge_requests?${query.toString()}`);
      const rows = json(must(res).text);
      const first = (Array.isArray(rows) ? rows[0] : undefined) as
        { iid?: unknown; web_url?: unknown } | undefined;
      if (!first || typeof first.iid !== 'number') return null;
      return { iid: first.iid, webUrl: typeof first.web_url === 'string' ? first.web_url : '' };
    },
    async createMergeRequest({ project: p, source, target, title, description }) {
      const res = await call('POST', `${project(p)}/merge_requests`, {
        body: {
          source_branch: source,
          target_branch: target,
          title,
          description,
          remove_source_branch: true,
        },
      });
      const row = (json(must(res).text) ?? {}) as { iid?: unknown; web_url?: unknown };
      if (typeof row.iid !== 'number')
        throw new GitLabError(200, 'GitLab opened a merge request without a number');
      return { iid: row.iid, webUrl: typeof row.web_url === 'string' ? row.web_url : '' };
    },
    async updateMergeRequest({ project: p, iid, title, description }) {
      await call('PUT', `${project(p)}/merge_requests/${iid}`, { body: { title, description } });
    },
  };
}

function must<T>(value: T | null): T {
  if (value === null) throw new GitLabError(404, 'GitLab answered 404');
  return value;
}
