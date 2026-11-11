/**
 * A brief bound to a repository (docs/AGENT_REPO.md §V2.17, blip 2e15ad9d,
 * slice 2b). On My Radar is the source of truth for a brief; a repository is
 * only ever a one-way mirror of it. Binding a brief to a path in a GitLab
 * project lets the worker say how far the code has moved since the brief was
 * last revised ("3 commits behind lucas/on-my-radar"), and — when mirroring is
 * on — open a merge request that writes the brief to that path. An edit made
 * in the repository is reported as drift and never imported.
 *
 * Pure: the schema, the DTO, the mirror file's header and the words a person
 * and an agent read. The server and the SPA render from the same functions.
 */
import { z } from 'zod';

/** `group/project`, `group/sub/project`: GitLab's path segments, nothing that escapes a URL. */
export const GITLAB_PROJECT_PATTERN =
  /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9_.][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.][A-Za-z0-9_.-]*)+$/;
/** A path in the repository, relative: no leading slash, no `.` or `..` segment. A trailing slash means a folder. */
export const REPO_PATH_PATTERN =
  /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9_.@+\-/ ]+$/;
/** A branch or tag name, conservatively: git refs allow more, nothing here needs it. */
export const GIT_REF_PATTERN = /^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9_.\-/]+$/;

export const BRIEF_REPO = {
  /** Commits counted per check; past it the flag says "100+". */
  commitsCap: 100,
  projectLength: 255,
  pathLength: 1_024,
  refLength: 255,
  /** Every mirror commit and branch carries this, so the stale count can skip our own writes. */
  commitMarker: '[omr-mirror]',
  branchPrefix: 'omr-mirror/',
} as const;

/** The words the mirror file opens with. Searching a repository for them finds every mirror. */
export const BRIEF_MIRROR_HEADER = 'Mirrored from On My Radar — edit there';

export const briefBindingSchema = z
  .object({
    /** The GitLab project's path, e.g. `lucas/on-my-radar`. */
    project: z
      .string()
      .trim()
      .max(BRIEF_REPO.projectLength)
      .regex(GITLAB_PROJECT_PATTERN, 'A GitLab project path, like group/project'),
    /** A file (`docs/AGENT-BRIEF.md`) or a folder ending in `/` (`packages/server/`). */
    path: z
      .string()
      .trim()
      .min(1)
      .max(BRIEF_REPO.pathLength)
      .regex(REPO_PATH_PATTERN, 'A path inside the repository, without a leading slash or ..'),
    ref: z
      .string()
      .trim()
      .min(1)
      .max(BRIEF_REPO.refLength)
      .regex(GIT_REF_PATTERN, 'A branch name, like main')
      .default('main'),
    /** Open a merge request writing the brief to `path` whenever it changes. */
    mirror: z.boolean().default(false),
  })
  .refine((b) => !b.mirror || !b.path.endsWith('/'), {
    message: 'A mirror writes one file: bind a file path, not a folder',
    path: ['mirror'],
  });
export type BriefBindingInput = z.infer<typeof briefBindingSchema>;
export type BriefBindingRequest = z.input<typeof briefBindingSchema>;

/**
 * - `not_checked`: nothing measured for the current revision yet — never
 *   checked, the brief changed since, or this server cannot check (`reason`).
 * - `current`: the bound path has not moved since the brief's revision.
 * - `behind`: it has, by `commitsBehind` commits.
 * - `failed`: the last check could not reach the repository (`reason`).
 */
export type BriefStaleState = 'not_checked' | 'current' | 'behind' | 'failed';

/**
 * - `disabled`: mirroring was asked for but is off on this server.
 * - `pending`: the brief has a revision no merge request carries yet.
 * - `opened`: a merge request carries the current revision.
 * - `failed`: the last attempt to open one failed (`reason`).
 */
export type BriefMirrorState = 'disabled' | 'pending' | 'opened' | 'failed';

/** A commit that edited the mirrored file in the repository instead of in On My Radar. */
export interface BriefDriftDto {
  /** Edited by hand, or deleted, in the repository. */
  kind: 'edited' | 'deleted';
  /** The newest commit that did it, when one can be named. */
  commit: string | null;
  title: string | null;
  at: string | null;
  url: string | null;
}

/** Where a brief is bound and what the last look at it found. Null on a brief with no binding. */
export interface BriefStaleDto {
  repo: { project: string; path: string; ref: string; mirror: boolean; url: string | null };
  state: BriefStaleState;
  /** Commits that touched the path since the brief's revision; null when not measured. */
  commitsBehind: number | null;
  /** True when the count stopped at `BRIEF_REPO.commitsCap`. */
  capped: boolean;
  /** The revision the measurement is for. */
  revision: number | null;
  checkedAt: string | null;
  /** Why it is not checked or why the check failed, in words. */
  reason: string | null;
  /** Set when the mirrored file was edited in the repository: never imported. */
  drift: BriefDriftDto | null;
  /** Null unless the binding asks for a mirror. */
  mirror: {
    state: BriefMirrorState;
    revision: number | null;
    mergeRequestUrl: string | null;
    reason: string | null;
  } | null;
}

/** "3 commits behind lucas/on-my-radar", "100+ commits behind …", "current with …", "not checked". */
export function staleLabel(stale: BriefStaleDto): string {
  const where = stale.repo.project;
  switch (stale.state) {
    case 'behind': {
      const n = stale.commitsBehind ?? 0;
      return `${n}${stale.capped ? '+' : ''} ${n === 1 && !stale.capped ? 'commit' : 'commits'} behind ${where}`;
    }
    case 'current':
      return `current with ${where}`;
    case 'failed':
      return `check failed for ${where}`;
    default:
      return `not checked against ${where}`;
  }
}

/** One line for `load_agent`'s brief index, or null when there is nothing to say. */
export function staleIndexNote(stale: BriefStaleDto | null): string | null {
  if (!stale) return null;
  const parts = [staleLabel(stale)];
  if (stale.drift) parts.push(`drift: ${stale.drift.kind} in repo`);
  return parts.join(', ');
}

/** The branch a brief's mirror merge requests come from: one per brief, reused while open. */
export function mirrorBranch(agentSlug: string, briefName: string): string {
  return `${BRIEF_REPO.branchPrefix}${agentSlug}/${briefName}`;
}

/** The first line of a mirrored file. Machine-readable enough to name the revision it holds. */
function headerLine(input: { agentSlug: string; name: string; revision: number; url: string }) {
  return `<!-- ${BRIEF_MIRROR_HEADER}. Agent ${input.agentSlug}, brief ${input.name}, r${input.revision}: ${input.url} — an edit made here is reported as drift and never imported. -->`;
}

/** The file a mirror writes: the header, a blank line, the brief's body, one trailing newline. */
export function renderBriefMirror(input: {
  agentSlug: string;
  name: string;
  revision: number;
  body: string;
  url: string;
}): string {
  return `${headerLine(input)}\n\n${input.body.replace(/\s+$/, '')}\n`;
}

const HEADER_RE = new RegExp(
  `^<!-- ${BRIEF_MIRROR_HEADER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\. Agent ([a-z0-9-]+), brief ([a-z0-9-]+), r(\\d+)[^\\n]*-->\\r?\\n`,
);

/**
 * Read a file the mirror may have written: which revision its header names and
 * the body after it. Null when it does not open with the mirror's header — a
 * file written by hand, or one whose header was edited away.
 */
export function readBriefMirror(
  content: string,
): { agentSlug: string; name: string; revision: number; body: string } | null {
  const match = HEADER_RE.exec(content);
  if (!match) return null;
  // A revision no brief can have (0, or past Postgres's integer) is not a
  // header this server wrote: unrecognised, never a number to look up.
  const revision = Number(match[3]);
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 2_147_483_647) return null;
  const rest = content.slice(match[0].length).replace(/^\r?\n/, '');
  return {
    agentSlug: match[1] ?? '',
    name: match[2] ?? '',
    revision,
    body: rest,
  };
}

/** True when a file carries the mirror's words at all, whether or not its header still parses. */
export function looksMirrored(content: string): boolean {
  return content.includes(BRIEF_MIRROR_HEADER);
}

/** Same words, ignoring line endings and trailing whitespace: what "edited in the repo" compares. */
export function sameBriefBody(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  return norm(a) === norm(b);
}
