/**
 * Runtime checks on the response fields the SPA writes back.
 *
 * ## The level of trust, and why this one
 *
 * Most of what the API returns is displayed. If it arrives in the wrong shape,
 * a card renders wrong and a reload fixes it, and the TypeScript types (shared
 * with the server through `@onmyradar/contract`) are the contract. Parsing every
 * response in production would put zod back into the first paint (about 75 KB,
 * taken out on purpose) and spend CPU on every list, for a failure that
 * corrupts nothing.
 *
 * A few fields are different: the SPA sends them back. `revision` becomes
 * `expectedRevision` on an agent or dashboard save, a memory's `revision`
 * becomes a review's `?revision=` or an edit's expected revision, a prompt's
 * `version` becomes `basedOn`, and `nextCursor` becomes the next page's cursor.
 * The server treats a *missing* expected revision as "no concurrency check", so
 * a response missing `revision` would turn the next save into a silent
 * overwrite of somebody else's change. That is a wrong shape corrupting data,
 * and those fields are checked here, on every response that carries them,
 * in production.
 *
 * Checked fields are verified; the rest of the object is trusted as the type
 * says, exactly as for any unchecked response. A failure is an `ApiError` with
 * code `unexpected_response`: the save is never attempted on a shape nobody
 * has verified.
 */
import type {
  BriefDto,
  BriefIndexEntryDto,
  BriefRevisionPageDto,
  BriefStaleDto,
  DashboardDto,
  MemoryDto,
  MemoryPageDto,
  PromptVersionDto,
  ProfileDto,
  RepoAgentDto,
  PromptHistoryPageDto,
  PromptProposalDto,
} from '@onmyradar/contract';

type Fields = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isId = (value: unknown): value is string => typeof value === 'string' && value !== '';

const isAgent = (agent: unknown): agent is RepoAgentDto =>
  isRecord(agent) &&
  isId(agent['id']) &&
  isCount(agent['revision']) &&
  isCount(agent['promptVersion']);
const isProfile = (profile: unknown): profile is ProfileDto =>
  isRecord(profile) && typeof profile['harness'] === 'string' && isCount(profile['revision']);
const isMemory = (memory: unknown): memory is MemoryDto =>
  isRecord(memory) && isId(memory['id']) && isCount(memory['revision']);
const isPrompt = (prompt: unknown): prompt is PromptVersionDto =>
  isRecord(prompt) &&
  isCount(prompt['version']) &&
  (prompt['basedOn'] === null || isCount(prompt['basedOn']));
/** What the SPA reads to draw a bound brief's state; the rest stands as the type says. */
const isStale = (stale: unknown): stale is BriefStaleDto =>
  isRecord(stale) &&
  isRecord(stale['repo']) &&
  typeof stale['repo']['project'] === 'string' &&
  typeof stale['state'] === 'string';
/** A brief's `revision` becomes the next save's `expectedRevision`. */
const isBriefEntry = (brief: unknown): brief is BriefIndexEntryDto =>
  isRecord(brief) &&
  isId(brief['name']) &&
  isCount(brief['revision']) &&
  (brief['newerRevision'] === null || isCount(brief['newerRevision'])) &&
  (brief['stale'] === undefined || brief['stale'] === null || isStale(brief['stale']));
const isDashboard = (dashboard: unknown): dashboard is DashboardDto =>
  isRecord(dashboard) && isId(dashboard['id']) && isCount(dashboard['revision']);

/**
 * One guard per response shape. Each is a type predicate: it verifies the
 * fields the SPA writes back and, having done so, lets the rest of the object
 * stand as the type says — the same trust every unchecked response gets, and no
 * more. That trade is the whole of this module, so it is stated once, here.
 */
export const guards = {
  profile: (body: unknown): body is { profile: ProfileDto } =>
    isRecord(body) && isProfile(body['profile']),
  profiles: (body: unknown): body is { profiles: ProfileDto[] } =>
    isRecord(body) && Array.isArray(body['profiles']) && body['profiles'].every(isProfile),
  agent: (body: unknown): body is { agent: RepoAgentDto } =>
    isRecord(body) && isAgent(body['agent']),
  agents: (body: unknown): body is { agents: RepoAgentDto[] } =>
    isRecord(body) && Array.isArray(body['agents']) && body['agents'].every(isAgent),
  memory: (body: unknown): body is { memory: MemoryDto } =>
    isRecord(body) && isMemory(body['memory']),
  remembered: (body: unknown): body is { memory: MemoryDto; created: boolean } =>
    isRecord(body) && isMemory(body['memory']) && typeof body['created'] === 'boolean',
  memoryPage: (body: unknown): body is MemoryPageDto =>
    isRecord(body) &&
    Array.isArray(body['memories']) &&
    body['memories'].every(isMemory) &&
    (body['nextCursor'] === null || isId(body['nextCursor'])),
  prompt: (body: unknown): body is { prompt: PromptVersionDto } =>
    isRecord(body) && isPrompt(body['prompt']),
  prompts: (body: unknown): body is PromptHistoryPageDto =>
    isRecord(body) &&
    Array.isArray(body['versions']) &&
    body['versions'].every(isPrompt) &&
    (body['nextCursor'] === null || typeof body['nextCursor'] === 'string'),
  proposals: (body: unknown): body is { proposals: PromptProposalDto[] } =>
    isRecord(body) &&
    Array.isArray(body['proposals']) &&
    body['proposals'].every(
      (p) => isRecord(p) && isId(p['id']) && isCount(p['basedOn']) && typeof p['body'] === 'string',
    ),
  briefs: (body: unknown): body is { briefs: BriefIndexEntryDto[] } =>
    isRecord(body) && Array.isArray(body['briefs']) && body['briefs'].every(isBriefEntry),
  brief: (body: unknown): body is { brief: BriefDto } =>
    isRecord(body) && isBriefEntry(body['brief']),
  briefSaved: (body: unknown): body is { brief: BriefDto; created: boolean } =>
    isRecord(body) && isBriefEntry(body['brief']) && typeof body['created'] === 'boolean',
  briefBinding: (body: unknown): body is { stale: BriefStaleDto } =>
    isRecord(body) && isStale(body['stale']),
  briefRevisions: (body: unknown): body is BriefRevisionPageDto =>
    isRecord(body) &&
    Array.isArray(body['revisions']) &&
    body['revisions'].every((r) => isRecord(r) && isCount(r['revision'])) &&
    (body['nextCursor'] === null || typeof body['nextCursor'] === 'string'),
  dashboard: (body: unknown): body is { dashboard: DashboardDto } =>
    isRecord(body) && isDashboard(body['dashboard']),
  dashboards: (body: unknown): body is { dashboards: DashboardDto[] } =>
    isRecord(body) && Array.isArray(body['dashboards']) && body['dashboards'].every(isDashboard),
};
