/**
 * Briefs bound to a repository (docs/AGENT_REPO.md §V2.17, blip 2e15ad9d,
 * slice 2b): the stale flag a reader sees, and the worker step that measures
 * it and — when the server allows — opens the one-way mirror's merge request.
 *
 * On My Radar is the source of truth for a brief. The repository is read to
 * say how far the code has moved since the brief was last revised, and is
 * written only through a merge request a person merges; nothing read from it
 * is ever written back into a brief. An edit made to the mirrored file in the
 * repository is reported as drift and left there.
 *
 * Setting and removing a binding live in `repo-agents.ts` beside the other
 * brief acts; this module holds what reads and observes.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  BRIEF_MIRROR_HEADER,
  BRIEF_REPO,
  looksMirrored,
  mirrorBranch,
  readBriefMirror,
  renderBriefMirror,
  sameBriefBody,
  type BriefStaleDto,
} from '@onmyradar/contract';
import { getDb, schema } from '../db/client.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { GitLabError, gitlabClient, type GitLabClient, type GitLabCommit } from './gitlab.js';

type BindingRow = typeof schema.agentBriefBindings.$inferSelect;

/** Re-measure a binding at least this often, and soon after its brief changes. */
const RECHECK = sql`interval '1 hour'`;
const AFTER_CHANGE = sql`interval '2 minutes'`;

const NOT_ALLOWED =
  'Repository checks use this server’s GitLab tokens, which only its administrators’ agents may use.';

function repoUrl(
  base: string | undefined,
  row: Pick<BindingRow, 'project' | 'path' | 'ref'>,
): string | null {
  if (!base) return null;
  const kind = row.path.endsWith('/') ? 'tree' : 'blob';
  const path = row.path.replace(/\/+$/, '').split('/').map(encodeURIComponent).join('/');
  const project = row.project.split('/').map(encodeURIComponent).join('/');
  return `${base}/${project}/-/${kind}/${encodeURIComponent(row.ref)}/${path}`;
}

/**
 * What a reader is told about one binding, for the brief's current revision.
 * A count measured against an older revision is not shown as current: the
 * brief changed since, so it says "not checked" until the worker looks again.
 */
export function staleFromRow(row: BindingRow, revision: number): BriefStaleDto {
  const config = env();
  const measured = row.checkState !== null && row.checkedRevision === revision;
  let state: BriefStaleDto['state'] = 'not_checked';
  let reason: string | null = null;
  if (row.checkState === 'unconfigured') {
    reason = row.checkError ?? 'This server cannot check the repository.';
  } else if (!measured) {
    reason =
      row.checkState === null
        ? 'Not checked yet.'
        : 'The brief changed since the last check; it is checked again shortly.';
  } else if (row.checkState === 'failed') {
    state = 'failed';
    reason = row.checkError ?? 'The last check failed.';
  } else {
    state = (row.commitsBehind ?? 0) > 0 ? 'behind' : 'current';
  }
  let mirror: BriefStaleDto['mirror'] = null;
  if (row.mirror) {
    const forThis = row.mirrorRevision === revision;
    mirror = !config.BRIEF_MIRROR_ENABLED
      ? {
          state: 'disabled',
          revision: row.mirrorRevision,
          mergeRequestUrl: row.mirrorMrUrl,
          reason: 'Mirroring is turned off on this server.',
        }
      : {
          state:
            forThis && row.mirrorState === 'opened'
              ? 'opened'
              : forThis && row.mirrorState === 'failed'
                ? 'failed'
                : 'pending',
          revision: row.mirrorRevision,
          mergeRequestUrl: row.mirrorMrUrl,
          reason: forThis && row.mirrorState === 'failed' ? row.mirrorError : null,
        };
  }
  return {
    repo: {
      project: row.project,
      path: row.path,
      ref: row.ref,
      mirror: row.mirror,
      url: repoUrl(config.GITLAB_URL, row),
    },
    state,
    commitsBehind: state === 'behind' || state === 'current' ? (row.commitsBehind ?? 0) : null,
    capped: state === 'behind' && row.behindCapped,
    revision: row.checkedRevision,
    checkedAt: row.checkedAt && row.checkState !== null ? row.checkedAt.toISOString() : null,
    reason,
    drift:
      row.driftKind !== null
        ? {
            kind: row.driftKind,
            commit: row.driftSha,
            title: row.driftTitle,
            at: row.driftAt ? row.driftAt.toISOString() : null,
            url: row.driftUrl,
          }
        : null,
    mirror,
  };
}

/** The stale flag for several briefs at once, keyed by brief id; unbound briefs are absent. */
export async function staleForBriefs(
  briefs: ReadonlyArray<{ id: string; revision: number }>,
): Promise<Map<string, BriefStaleDto>> {
  const out = new Map<string, BriefStaleDto>();
  if (briefs.length === 0) return out;
  const rows = await getDb()
    .select()
    .from(schema.agentBriefBindings)
    .where(
      inArray(
        schema.agentBriefBindings.briefId,
        briefs.map((b) => b.id),
      ),
    );
  const current = new Map(briefs.map((b) => [b.id, b.revision]));
  for (const row of rows) {
    const revision = current.get(row.briefId);
    if (revision !== undefined) out.set(row.briefId, staleFromRow(row, revision));
  }
  return out;
}

/* ------------------------------- the checker ------------------------------ */

interface Claimed {
  binding: BindingRow;
  agentId: string;
  agentSlug: string;
  ownerIsAdmin: boolean;
  name: string;
  revision: number;
  body: string;
  /** The current revision's time, to the second, in UTC: what GitLab's `since` takes. */
  since: string;
}

/** Claim the next due binding, or null. The claim is the `checked_at` stamp. */
async function claimDue(): Promise<Claimed | null> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const due = await tx.execute<{ brief_id: string }>(sql`
      SELECT bb.brief_id
        FROM agent_brief_bindings bb
        JOIN agent_briefs b ON b.id = bb.brief_id
        JOIN agents a ON a.id = b.agent_id
       WHERE a.archived_at IS NULL
         AND (bb.checked_at IS NULL
              OR bb.checked_at < now() - ${RECHECK}
              OR (bb.checked_revision IS DISTINCT FROM b.revision
                  AND bb.checked_at < now() - ${AFTER_CHANGE}))
       ORDER BY bb.checked_at NULLS FIRST
       LIMIT 1
       FOR UPDATE OF bb SKIP LOCKED`);
    const id = due.rows[0]?.brief_id;
    if (!id) return null;
    const [binding] = await tx
      .update(schema.agentBriefBindings)
      .set({ checkedAt: sql`now()` })
      .where(eq(schema.agentBriefBindings.briefId, id))
      .returning();
    const context = await tx.execute<{
      agent_id: string;
      slug: string;
      is_admin: boolean;
      name: string;
      revision: number;
      body: string;
      since: string;
    }>(sql`
      SELECT a.id AS agent_id, a.slug, u.is_admin, b.name, b.revision, b.body,
             to_char(b.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS since
        FROM agent_briefs b
        JOIN agents a ON a.id = b.agent_id
        JOIN users u ON u.id = a.owner_id
       WHERE b.id = ${id}::uuid`);
    const c = context.rows[0];
    if (!binding || !c) return null;
    return {
      binding,
      agentId: c.agent_id,
      agentSlug: c.slug,
      ownerIsAdmin: c.is_admin,
      name: c.name,
      revision: c.revision,
      body: c.body,
      since: c.since,
    };
  });
}

/** Writes land only on the binding as it was claimed: a binding changed meanwhile is not overwritten. */
function sameBinding(b: BindingRow) {
  return and(
    eq(schema.agentBriefBindings.briefId, b.briefId),
    eq(schema.agentBriefBindings.project, b.project),
    eq(schema.agentBriefBindings.path, b.path),
    eq(schema.agentBriefBindings.ref, b.ref),
  );
}

const clip = (s: string) => (s.length > 500 ? `${s.slice(0, 497)}…` : s);
const reasonOf = (err: unknown) =>
  clip(err instanceof GitLabError ? err.message : 'The check failed unexpectedly.');

/** Our own writes — the mirror's commits and the merges of its branches — are not the code moving. */
export function isMirrorCommit(c: Pick<GitLabCommit, 'title' | 'message'>): boolean {
  return (
    c.title.includes(BRIEF_REPO.commitMarker) ||
    c.message.includes(BRIEF_REPO.commitMarker) ||
    c.message.includes(BRIEF_REPO.branchPrefix)
  );
}

async function revisionBody(briefId: string, revision: number): Promise<string | null> {
  const [row] = await getDb()
    .select({ body: schema.agentBriefRevisions.body })
    .from(schema.agentBriefRevisions)
    .where(
      and(
        eq(schema.agentBriefRevisions.briefId, briefId),
        eq(schema.agentBriefRevisions.revision, revision),
      ),
    )
    .limit(1);
  return row?.body ?? null;
}

/**
 * Look at the mirrored file at the bound ref. Drift is a file that carries the
 * mirror's header but says something other than the revision it names, or a
 * file whose mirror once landed and is now gone or rewritten. A file that never
 * carried the header — the hand-written one a mirror's first merge request
 * replaces — is not drift.
 */
async function observeMirroredFile(
  client: GitLabClient,
  c: Claimed,
): Promise<{
  landed: number | null;
  drift: {
    kind: 'edited' | 'deleted';
    sha: string | null;
    title: string | null;
    at: string | null;
    url: string | null;
  } | null;
}> {
  const { project, path, ref } = c.binding;
  const content = await client.readFile({ project, ref, path });
  const parsed = content === null ? null : readBriefMirror(content);
  const previouslyLanded = c.binding.landedRevision;
  let landed = previouslyLanded;
  let drifted = false;
  let kind: 'edited' | 'deleted' = 'edited';
  if (content === null) {
    drifted = previouslyLanded !== null;
    kind = 'deleted';
  } else if (!parsed) {
    // Headerless after a mirror landed, or carrying the mirror's words in a
    // header that no longer parses (an edited revision, a number no brief has):
    // either way, edited in the repository.
    drifted = previouslyLanded !== null || looksMirrored(content);
  } else {
    landed = parsed.revision;
    const expected = await revisionBody(c.binding.briefId, parsed.revision);
    drifted = expected === null || !sameBriefBody(parsed.body, expected);
  }
  if (!drifted) return { landed, drift: null };
  const [commit] = (await client.latestCommits({ project, ref, path, n: 10 })).filter(
    (x) => !isMirrorCommit(x),
  );
  return {
    landed,
    drift: {
      sha: commit?.shortId ?? null,
      kind,
      title: commit ? clip(commit.title) : null,
      at: commit?.committedAt || null,
      url: commit?.webUrl ?? null,
    },
  };
}

async function openMirror(client: GitLabClient, c: Claimed): Promise<string> {
  const { project, path, ref } = c.binding;
  const branch = mirrorBranch(c.agentSlug, c.name);
  const url = `${env().APP_URL}/repo/${c.agentId}/briefs?b=${encodeURIComponent(c.name)}`;
  const content = renderBriefMirror({
    agentSlug: c.agentSlug,
    name: c.name,
    revision: c.revision,
    body: c.body,
    url,
  });
  let mr = await client.openMergeRequest({ project, source: branch, target: ref });
  if (!mr) {
    // A branch left from a merged request is behind `ref`: start it again.
    if (await client.branchExists({ project, branch }))
      await client.deleteBranch({ project, branch });
    await client.createBranch({ project, branch, ref });
  }
  const onBranch = await client.readFile({ project, ref: branch, path });
  if (onBranch !== content) {
    await client.commitFile({
      project,
      branch,
      path,
      content,
      create: onBranch === null,
      message: `${BRIEF_REPO.commitMarker} ${c.agentSlug}/${c.name} r${c.revision}`,
    });
  }
  const title = `${BRIEF_REPO.commitMarker} Mirror brief ${c.agentSlug}/${c.name} r${c.revision}`;
  const description = [
    `**${BRIEF_MIRROR_HEADER}.**`,
    '',
    `This merge request writes revision ${c.revision} of the brief \`${c.name}\` of the agent \`${c.agentSlug}\` to \`${path}\`.`,
    `On My Radar is the source of truth for it: edit the brief there (${url}), and a new revision updates this merge request.`,
    'An edit made to this file in the repository is reported on the brief as drift and is never imported.',
  ].join('\n');
  if (mr) await client.updateMergeRequest({ project, iid: mr.iid, title, description });
  else
    mr = await client.createMergeRequest({
      project,
      source: branch,
      target: ref,
      title,
      description,
    });
  return mr.webUrl;
}

export interface CheckDeps {
  /** Builds the client for one token. Tests pass a fake GitLab; production uses `gitlabClient`. */
  client?: (token: string) => GitLabClient;
}

/**
 * The worker's step: claim one due binding, measure it, and mirror it when
 * this server mirrors. Returns how many it handled (0 or 1), so the lane
 * sleeps when there is nothing to do.
 */
export async function checkDueBriefBinding(
  signal?: AbortSignal,
  deps: CheckDeps = {},
): Promise<number> {
  if (signal?.aborted) return 0;
  const c = await claimDue();
  if (!c) return 0;
  const config = env();
  const gitlabUrl = config.GITLAB_URL;
  const makeClient =
    deps.client ??
    ((token: string) => {
      if (!gitlabUrl) throw new GitLabError(0, 'GITLAB_URL is not set on this server.');
      return gitlabClient(gitlabUrl, token);
    });
  const db = getDb();
  const { project, path, ref } = c.binding;

  const readToken = config.GITLAB_READ_TOKENS[project];
  if (!c.ownerIsAdmin || !readToken || !gitlabUrl) {
    await db
      .update(schema.agentBriefBindings)
      .set({
        checkState: 'unconfigured',
        checkError: !c.ownerIsAdmin
          ? NOT_ALLOWED
          : !gitlabUrl
            ? 'This server has no GitLab configured (GITLAB_URL).'
            : config.GITLAB_TOKEN_ERRORS.includes('GITLAB_READ_TOKENS')
              ? 'This server’s GitLab read tokens are misconfigured; its operator has been told in the log.'
              : `This server has no read token for ${project}.`,
        checkedRevision: c.revision,
        commitsBehind: null,
        behindCapped: false,
      })
      .where(sameBinding(c.binding));
  } else {
    const client = makeClient(readToken);
    try {
      const { commits, capped } = await client.commitsSince({
        project,
        ref,
        path,
        since: c.since,
        cap: BRIEF_REPO.commitsCap,
      });
      const moved = commits.filter((x) => !isMirrorCommit(x)).length;
      // The count is the point of a check: a file that cannot be read for drift
      // must not cost it. Drift is then left as it was last seen.
      let seen: Awaited<ReturnType<typeof observeMirroredFile>> | null = null;
      let driftUnread = false;
      if (c.binding.mirror) {
        try {
          seen = await observeMirroredFile(client, c);
        } catch (err) {
          driftUnread = true;
          if (!(err instanceof GitLabError))
            logger.error({ err, project }, 'brief drift check failed');
        }
      }
      await db
        .update(schema.agentBriefBindings)
        .set({
          checkState: 'ok',
          checkError: null,
          checkedRevision: c.revision,
          commitsBehind: moved,
          behindCapped: capped,
          landedRevision: seen ? seen.landed : c.binding.landedRevision,
          ...(driftUnread
            ? {}
            : {
                driftKind: seen?.drift?.kind ?? null,
                driftSha: seen?.drift?.sha ?? null,
                driftTitle: seen?.drift?.title ?? null,
                driftAt: seen?.drift?.at ? sql`${seen.drift.at}::timestamptz` : null,
                driftUrl: seen?.drift?.url ?? null,
              }),
        })
        .where(sameBinding(c.binding));
    } catch (err) {
      if (!(err instanceof GitLabError))
        logger.error({ err, project }, 'brief binding check failed');
      await db
        .update(schema.agentBriefBindings)
        .set({ checkState: 'failed', checkError: reasonOf(err), checkedRevision: c.revision })
        .where(sameBinding(c.binding));
    }
  }

  const wantsMirror =
    config.BRIEF_MIRROR_ENABLED &&
    c.binding.mirror &&
    c.ownerIsAdmin &&
    (c.binding.mirrorRevision !== c.revision || c.binding.mirrorState === 'failed');
  if (wantsMirror && !signal?.aborted) {
    const writeToken = config.GITLAB_MIRROR_TOKENS[project];
    try {
      if (!writeToken) throw new GitLabError(0, `This server has no mirror token for ${project}.`);
      const url = await openMirror(makeClient(writeToken), c);
      await db
        .update(schema.agentBriefBindings)
        .set({
          mirrorRevision: c.revision,
          mirrorState: 'opened',
          mirrorError: null,
          mirrorMrUrl: url || null,
        })
        .where(and(sameBinding(c.binding), eq(schema.agentBriefBindings.mirror, true)));
    } catch (err) {
      if (!(err instanceof GitLabError)) logger.error({ err, project }, 'brief mirror failed');
      await db
        .update(schema.agentBriefBindings)
        .set({ mirrorRevision: c.revision, mirrorState: 'failed', mirrorError: reasonOf(err) })
        .where(and(sameBinding(c.binding), eq(schema.agentBriefBindings.mirror, true)));
    }
  }
  return 1;
}
