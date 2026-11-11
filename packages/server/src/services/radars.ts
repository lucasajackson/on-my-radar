/** Radar lifecycle, membership and public links. */
import { randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
import {
  commentsAllowed,
  DEFAULT_RADAR_ACCENT,
  DEFAULT_RADAR_GLYPH,
  DEFAULT_RADAR_TEMPLATE,
  DEFAULT_DROP_BOX_TEMPLATE,
  dropBoxTemplateLabels,
  isDropBoxTemplate,
  isClientFacingTemplate,
  RADAR_TEMPLATES,
  CASCADE_GRANTS,
  isRadarAccent,
  isRadarGlyph,
  isRadarTemplate,
  isDefaultTheme,
  isThemePreset,
  THEME_PRESETS,
  themeFor,
  RADAR_ROLES,
  roleAtLeast,
  normalizeEmail,
  normalizeTags,
  statusesFor,
  validateLanes,
  type CreateRadarInput,
  type AccessSource,
  type CreateSmartRadarInput,
  type MemberDto,
  type RadarDto,
  type RadarKind,
  type RadarRole,
  type RadarTheme,
  type RadarThemeInput,
  type SmartFilter,
  type SmartFilterInput,
  type TemplateConfig,
  type TemplateConfigInput,
  type UpdateRadarInput,
} from '@onmyradar/contract';
import { getDb, schema, type Db } from '../db/client.js';
import { env } from '../env.js';
import {
  ApiError,
  badRequest,
  ceilingOf,
  conflict,
  forbidden,
  notFound,
  type Actor,
} from '../http.js';
import { logger } from '../logger.js';
import { withUniqueSlug } from './slugs.js';
import { enqueue, drainOne } from './outbox.js';
import {
  assertHumanDecision,
  clampRole,
  directRoleFor,
  fenceCaps,
  getRadarAccess,
  narrowByOrg,
  orgStanding,
  topicVisibleTo,
  radarReaders,
  neverPublic,
  requireRadar,
  requireScope,
  requireTopic,
  unfencedReadableRadarQuery,
  weakestRole,
  type RadarAccess,
  type RadarRow,
  type TopicRow,
} from './access.js';
import { archivedExpr, countScope, liveExpr, resolveRadarScope } from './blips.js';
import { isPublicOnly, narrowRadar } from './redaction.js';
import { recordAudit } from './audit.js';
import { radarSharedMessage } from './mail.js';
import { assertMayInvite, invitationBypassFor, inviteUrl, mayBypassWaitlist } from './invites.js';
import { activateUser } from '../auth/accounts.js';
import {
  assertRadarMayJoinTopic,
  detachRadarFromForeignTopic,
  setRadarTopic,
  toTopicSummary,
} from './topics.js';
import { dropRadarNotifications, enqueueNotificationEvent } from './notifications.js';
import { dropRadarMentions } from './mentions.js';
import { cachedForRadar } from './stats-cache.js';
import { asStored } from '../db/stored.js';
import { lockOwner } from './owner-lock.js';

/** Unguessable, URL-safe, and short enough to paste into a chat message. */
function newPublicSlug(): string {
  return randomBytes(9).toString('base64url');
}

interface RadarStats {
  /** Live blips — what you would see on opening the radar. */
  blipCount: number;
  /** Finished blips that have aged out. See `services/blips.ts` → `archivedExpr`. */
  archivedCount: number;
  memberCount: number;
  lastBlipAt: Date | null;
}

/**
 * Per-radar counts, reused for `STATS_CACHE_TTL_MS`: they scan every blip on every radar listed,
 * and are the same for everyone who can read the radar. Misses are loaded together in one
 * query and each radar's entry is stored on its own, so a sidebar of twenty radars where
 * nineteen are warm asks the database about one.
 */
async function statsFor(radarIds: string[]): Promise<Map<string, RadarStats>> {
  const out = new Map<string, RadarStats>();
  if (radarIds.length === 0) return out;
  const unique = [...new Set(radarIds)];
  const cold: string[] = [];
  const pending = new Map<string, Promise<RadarStats>>();
  let batch: Promise<Map<string, RadarStats>> | null = null;
  const loadBatch = () => (batch ??= computeStats(cold));
  for (const id of unique) {
    pending.set(
      id,
      cachedForRadar(id, 'stats', () => {
        cold.push(id);
        // Deferred a tick so every cold radar of this call is in `cold` before the one query runs.
        return Promise.resolve().then(async () => {
          const found = await loadBatch();
          return (
            found.get(id) ?? { blipCount: 0, archivedCount: 0, memberCount: 1, lastBlipAt: null }
          );
        });
      }),
    );
  }
  for (const [id, stats] of pending) out.set(id, { ...(await stats) });
  return out;
}

async function computeStats(radarIds: string[]): Promise<Map<string, RadarStats>> {
  const stats = new Map<string, RadarStats>();
  if (radarIds.length === 0) return stats;

  /*
    Live and archived apart, from one grouped scan.

    A sidebar that prints 46 beside a board showing 12 is the "still counted"
    half of the problem archiving exists to fix, so `blipCount` is the live
    number — and the archive is carried beside it rather than dropped, because
    hiding the fact that something was hidden is the failure mode this whole
    feature is written to avoid.
  */
  const blipRows = await getDb()
    .select({
      radarId: schema.blips.radarId,
      count: sql<number>`(count(*) FILTER (WHERE ${liveExpr}))::int`,
      archived: sql<number>`(count(*) FILTER (WHERE ${archivedExpr}))::int`,
      last: sql<string | null>`max(${schema.blips.createdAt})`,
    })
    .from(schema.blips)
    .where(inArray(schema.blips.radarId, radarIds))
    .groupBy(schema.blips.radarId);

  const memberRows = await getDb()
    .select({ radarId: schema.radarMembers.radarId, count: sql<number>`count(*)::int` })
    .from(schema.radarMembers)
    .where(inArray(schema.radarMembers.radarId, radarIds))
    .groupBy(schema.radarMembers.radarId);

  /*
   * People reaching these radars only through a cascading topic.
   *
   * `listMembers` deliberately has this leg — a cascaded member appears in the
   * share dialog, labelled with where the access came from, because access
   * nobody can enumerate is access nobody audits. This count did not, so the
   * two halves of "who can see this radar" disagreed: the dialog listed five
   * people and the count beside it said two. No screen renders a radar's
   * `memberCount` today, which is exactly why it was worth fixing rather than
   * deleting — it is on the DTO, an agent reading `read_radar` over MCP gets
   * it, and a contradiction waiting for its first consumer is still a
   * contradiction.
   *
   * Distinct users, excluding the owner and anyone already holding a direct
   * row, so the three legs sum without double counting. No `users.state`
   * filter, because `listMembers` has none either and these two must agree.
   */
  const cascadedRows = await getDb().execute<{ radar_id: string; count: number }>(sql`
    SELECT r.id AS radar_id, count(DISTINCT tm.user_id)::int AS count
    FROM radars r
    JOIN topics t ON t.id = r.topic_id AND t.cascade = true AND t.owner_id = r.owner_id
    JOIN topic_members tm ON tm.topic_id = t.id
    LEFT JOIN radar_members rm ON rm.radar_id = r.id AND rm.user_id = tm.user_id
    WHERE r.id = ANY(ARRAY[${sql.join(
      radarIds.map((id) => sql`${id}`),
      sql`, `,
    )}]::uuid[])
      AND rm.user_id IS NULL
      AND tm.user_id <> r.owner_id
    GROUP BY r.id
  `);

  for (const id of radarIds)
    stats.set(id, { blipCount: 0, archivedCount: 0, memberCount: 0, lastBlipAt: null });
  for (const row of blipRows) {
    const entry = stats.get(row.radarId);
    if (entry) {
      entry.blipCount = row.count;
      entry.archivedCount = row.archived;
      entry.lastBlipAt = row.last ? new Date(row.last) : null;
    }
  }
  // +1 for the owner, who has no radar_members row.
  for (const id of radarIds) {
    const entry = stats.get(id);
    if (entry) entry.memberCount = 1;
  }
  for (const row of memberRows) {
    const entry = stats.get(row.radarId);
    if (entry) entry.memberCount = row.count + 1;
  }
  for (const row of cascadedRows.rows) {
    const entry = stats.get(row.radar_id);
    if (entry) entry.memberCount += row.count;
  }
  return stats;
}

type OwnerSummary = { id: string; name: string | null; email: string } | null;

function toRadarDto(
  radar: RadarRow,
  access: Pick<
    RadarAccess,
    | 'role'
    | 'viaPublicLink'
    | 'canRead'
    | 'canWrite'
    | 'canManage'
    | 'via'
    | 'directRole'
    | 'topicRole'
  >,
  stats: RadarStats,
  owner: OwnerSummary,
  /** The topic to show: null when there is none *or the caller may not see it*. */
  topic: TopicRow | null = null,
): RadarDto {
  return {
    id: radar.id,
    slug: radar.slug,
    name: radar.name,
    tagline: radar.tagline,
    description: radar.description,
    topicId: topic ? radar.topicId : null,
    topic: topic ? toTopicSummary(topic) : null,
    accent: isRadarAccent(radar.accent) ? radar.accent : DEFAULT_RADAR_ACCENT,
    // Guarded like the accent: the column has no CHECK, so a glyph a later build
    // added reaches this one as a string it has never heard of.
    glyph: isRadarGlyph(radar.glyph) ? radar.glyph : DEFAULT_RADAR_GLYPH,
    kind: radar.kind,
    // An unrecognised template must render as the stream rather than as an
    // error: a radar created by a future build must still open in this one.
    template: isRadarTemplate(radar.template) ? radar.template : DEFAULT_RADAR_TEMPLATE,
    templateConfig: asStored(radar.templateConfig) ?? {},
    // Resolved here so the wire always carries nine real values. A row stored by
    // a future build with a surface this one has never heard of comes back with
    // its other eight axes intact and that one defaulted — the same degradation
    // as the template above, and for the same reason: a radar must still open.
    theme: themeFor(radar.theme),
    filter: radar.kind === 'smart' ? (radar.filter ?? null) : null,
    isDropBox: radar.isDropBox,
    neverPublic: neverPublic(radar),
    // The radar's switch AND the template's: a reader's stories take no comments.
    commentsEnabled: radar.commentsEnabled && commentsAllowed(radar.template),
    reactionsEnabled: radar.reactionsEnabled,
    visibility: radar.visibility,
    publicSlug: radar.publicSlug,
    allowIndex: radar.allowIndex,
    archived: radar.archived,
    ownerId: radar.ownerId,
    owner,
    blipCount: stats.blipCount,
    archivedCount: stats.archivedCount,
    archiveAfterDays: radar.archiveAfterDays,
    memberCount: stats.memberCount,
    lastBlipAt: stats.lastBlipAt ? stats.lastBlipAt.toISOString() : null,
    createdAt: radar.createdAt.toISOString(),
    updatedAt: radar.updatedAt.toISOString(),
    access: {
      role: access.role,
      canRead: access.canRead,
      canWrite: access.canWrite,
      canManage: access.canManage,
      viaPublicLink: access.viaPublicLink,
      via: access.via ?? null,
      directRole: access.directRole ?? null,
      topicRole: access.topicRole ?? null,
    },
  };
}

/**
 * Everything the user owns, is a member of, **or reaches through a cascading
 * topic** — newest activity first.
 *
 * The topic leg has to be here and not only in `readableRadarIds`, because this
 * is the query behind the sidebar and the `/radars` screen. A radar reachable
 * through a cascade that appeared in search but not in the list would be exactly
 * the kind of divergence the one-service-layer rule exists to stop, happening
 * inside a single service instead of between two transports.
 *
 * The role computed here is the **effective** one, by the same most-permissive
 * union `getRadarAccess` applies. It is deliberately worked out from the same
 * three inputs rather than re-derived differently: two code paths that both
 * decide "what may this person do" are two chances to disagree.
 */
export async function listRadars(
  actor: Actor,
  options: { includeArchived?: boolean; template?: string } = {},
): Promise<RadarDto[]> {
  const db = getDb();
  // An agent limited to selected radars: the sidebar lists those and no others, each at the
  // lower of the token's ceiling and its grant (the same `fenceCaps` the lookup asks).
  const fence = await fenceCaps(actor);
  const rows = await db
    .select({
      radar: schema.radars,
      memberRole: schema.radarMembers.role,
      topic: schema.topics,
      topicMemberRole: schema.topicMembers.role,
      owner: { id: schema.users.id, name: schema.users.name, email: schema.users.email },
      orgKind: schema.organizations.kind,
      orgRole: schema.memberships.role,
    })
    .from(schema.radars)
    .leftJoin(
      schema.radarMembers,
      and(
        eq(schema.radarMembers.radarId, schema.radars.id),
        eq(schema.radarMembers.userId, actor.user.id),
      ),
    )
    // Unconditional: the topic is wanted for *grouping* whether or not it
    // cascades, so the join cannot carry the flag the way `readableRadarIds`
    // does. Whether it grants anything is decided per row below. A topic of another
    // organization is not this radar's topic (see `loadAccessRow`).
    .leftJoin(
      schema.topics,
      and(
        eq(schema.topics.id, schema.radars.topicId),
        eq(schema.topics.organizationId, schema.radars.organizationId),
      ),
    )
    .leftJoin(
      schema.topicMembers,
      and(
        eq(schema.topicMembers.topicId, schema.topics.id),
        eq(schema.topicMembers.userId, actor.user.id),
      ),
    )
    .innerJoin(schema.users, eq(schema.users.id, schema.radars.ownerId))
    .leftJoin(schema.organizations, eq(schema.organizations.id, schema.radars.organizationId))
    .leftJoin(
      schema.memberships,
      and(
        eq(schema.memberships.orgId, schema.radars.organizationId),
        eq(schema.memberships.userId, actor.user.id),
        isNull(schema.memberships.deactivatedAt),
      ),
    )
    .where(
      and(
        /*
          Which radars: the one definition of "the radars this person reaches", with its
          one indexed leg per grant and the organization term inside each. Those legs are
          the same three the OR here used to repeat, so the list cannot disagree with search
          or the lookup about what is reachable. Everything below only works out the role.
        */
        inArray(schema.radars.id, unfencedReadableRadarQuery(actor.user.id)),
        fence
          ? fence.size
            ? inArray(schema.radars.id, [...fence.keys()])
            : sql`false`
          : undefined,
        options.includeArchived ? undefined : eq(schema.radars.archived, false),
        options.template ? eq(schema.radars.template, options.template) : undefined,
      ),
    )
    .orderBy(desc(schema.radars.updatedAt));

  const stats = await statsFor(rows.map((r) => r.radar.id));
  const empty: RadarStats = { blipCount: 0, archivedCount: 0, memberCount: 1, lastBlipAt: null };
  const ceiling = ceilingOf(actor);

  return rows.map((row) => {
    const org = orgStanding(row.orgKind ?? null, row.orgRole ?? null);
    // The grants as the lookup narrows them: the same function, so the same answer.
    const { ownerRole, directRole, topicRole } = narrowByOrg(org, {
      ownerRole: row.radar.ownerId === actor.user.id ? 'owner' : null,
      directRole: row.memberRole ?? null,
      topicRole:
        row.topic?.cascade && row.topic.ownerId === row.radar.ownerId && row.topicMemberRole
          ? CASCADE_GRANTS[row.topicMemberRole]
          : null,
    });

    const decided = strongestRole(strongestRole(ownerRole, directRole), topicRole);
    const via: AccessSource | null =
      ownerRole !== null && decided === ownerRole
        ? 'owner'
        : directRole !== null && decided === directRole
          ? 'member'
          : topicRole !== null
            ? 'topic'
            : null;

    // Union, then clamp — the same two steps as `getRadarAccess`, using its own
    // `clampRole` rather than a local copy. Without this the sidebar would
    // advertise `canWrite` on radars a read-only connection cannot write to,
    // which is the MCP-disagrees-with-REST divergence reappearing inside one
    // service. `via` is left uncapped for the same reason it is there: it says
    // why the *person* can reach the radar.
    const role = clampRole(decided, weakestRole(ceiling, fence?.get(row.radar.id)));

    return toRadarDto(
      row.radar,
      {
        role,
        directRole,
        topicRole,
        via,
        viaPublicLink: false,
        canRead: true,
        canWrite: role !== null && roleAtLeast(role, 'editor'),
        canManage: role !== null && roleAtLeast(role, 'owner'),
      },
      stats.get(row.radar.id) ?? empty,
      row.owner,
      // Attached whether or not it cascades — a member of a non-cascading topic
      // still groups the radars they *do* reach under it — but only for
      // somebody who can see the topic. A person the radar alone was shared
      // with is not told which topic it sits in.
      !fence && topicVisibleTo(row.topic, actor.user.id, row.topicMemberRole ?? null, org)
        ? row.topic
        : null,
    );
  });
}

/** Most permissive wins, mirroring `strongest` in `services/access.ts`. */
function strongestRole(a: RadarRole | null, b: RadarRole | null): RadarRole | null {
  if (a === null) return b;
  if (b === null) return a;
  return RADAR_ROLES.indexOf(a) >= RADAR_ROLES.indexOf(b) ? a : b;
}

async function ownerSummary(ownerId: string): Promise<OwnerSummary> {
  const rows = await getDb()
    .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, ownerId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * A smart radar owns no rows, so `statsFor` would honestly report zero blips.
 * When there is an actor to resolve against, report what the radar actually
 * shows instead — one extra count on the single-radar path only, never N of
 * them inside `listRadars`.
 */
export async function getRadarDto(
  access: RadarAccess,
  actor: Actor | null = null,
): Promise<RadarDto> {
  const stats = await statsFor([access.radar.id]);
  const fallback: RadarStats = { blipCount: 0, archivedCount: 0, memberCount: 1, lastBlipAt: null };
  const resolved = stats.get(access.radar.id) ?? fallback;

  if (access.radar.kind === 'smart' && actor) {
    const scope = await resolveRadarScope(access, actor);
    const { count, archived, lastAt } = await countScope(scope);
    resolved.blipCount = count;
    resolved.archivedCount = archived;
    resolved.lastBlipAt = lastAt;
  }

  const dto = toRadarDto(
    access.radar,
    access,
    resolved,
    await ownerSummary(access.radar.ownerId),
    access.topicVisible ? access.topic : null,
  );
  // Narrowed here rather than in `routes/public.ts`, because a public link is a
  // property of the *access*, not of which route was called: `/api/radars/<slug>`
  // and `read_radar` over MCP both reach this with `role === null` and used to
  // answer with the owner's address and the member count.
  return isPublicOnly(access) ? narrowRadar(dto) : dto;
}

/**
 * What to store in `radars.theme`, given what the caller sent and what is
 * already there.
 *
 * A **patch**, not a replacement: `{ surface: 'noir' }` changes the paper and
 * leaves the other eight axes alone, which is what both the picker and an agent
 * asked to "make it darker" mean. A `preset` resets the base to that preset's
 * nine values first, so `{ preset: 'geocities', bodyFont: 'serif' }` reads as
 * "Geocities, but with a serif" in one call — and the preset name itself is
 * discarded here and never stored. See the migration for why.
 *
 * The theme is written out in full rather than as the axes that differ, so what
 * somebody chose is what they keep even if a default changes underneath them —
 * **except** when the result is the default look, which is stored as `{}`. That
 * keeps "this radar is unthemed" a single representation rather than two that
 * happen to render alike.
 */
export function resolveThemeInput(
  input: RadarThemeInput,
  existing: unknown = {},
): Partial<RadarTheme> {
  const { preset, ...axes } = input;
  const base = isThemePreset(preset) ? THEME_PRESETS[preset].theme : themeFor(existing);
  // `themeFor` with `base` as the fallback, rather than a spread into `base`: it
  // is the one function that decides what a valid theme is, so a value that
  // somehow got past the zod enum still cannot land in the column — and because
  // the fallback is the base rather than the default, one bad axis leaves the
  // eight good ones alone instead of resetting the whole look.
  const resolved = themeFor(axes, base);
  return isDefaultTheme(resolved) ? {} : resolved;
}

/**
 * Fold a `templateConfig` patch into what is stored, refusing a lane set the
 * radar cannot carry.
 *
 * ## A patch, not a replacement
 *
 * This used to be `patch.templateConfig = input.templateConfig`, which was
 * harmless while the config held two display booleans and is not any more: the
 * settings page sends `{ grouping, collapseDone }` on every save, so a
 * wholesale write would erase a radar's lane vocabulary the next time somebody
 * toggled the diary rule. The theme has patched rather than replaced since it
 * shipped — "so setting one axis leaves the other eight" — and this is the same
 * rule applied one field over.
 *
 * `lanes: null` is the one value that removes rather than sets. There is no
 * other way for a client to say "give this radar its template's lanes back",
 * and `undefined` cannot mean it because `undefined` already means "I am not
 * talking about lanes".
 *
 * ## The refusal that needs the database
 *
 * `validateLanes` can say whether a proposal is coherent; only a query can say
 * whether it strands what the radar already holds. A blip whose `status` names
 * a lane that no longer exists does not error — `resolveStatus` degrades an
 * unknown lane to null, deliberately, so a radar switched between templates
 * stays readable — it simply stops being on the board, and on a template with
 * `laneFilter` it stops being reachable by any control on the page.
 *
 * That is a silent partial data loss, so it is refused rather than repaired.
 * Repairing would mean writing every stranded blip into some other lane, which
 * is a second write that can disagree with the first — the failure the lane and
 * state repair already exists to prevent — and it would do it to rows the person
 * asking has not looked at. The refusal names the lanes and the counts, so the
 * caller can move them and try again, or keep the id and change only the label.
 */
async function resolveTemplateConfigInput(
  radar: RadarRow,
  input: TemplateConfigInput,
  template: string,
  db: Pick<Db, 'select'>,
): Promise<TemplateConfig> {
  const stored: TemplateConfig = asStored(radar.templateConfig) ?? {};
  const merged: TemplateConfig = { ...stored };

  if (input.grouping !== undefined) merged.grouping = input.grouping;
  if (input.collapseDone !== undefined) merged.collapseDone = input.collapseDone;
  if (input.defaultStatus === null) delete merged.defaultStatus;

  if (input.lanes === null) {
    delete merged.lanes;
    delete merged.defaultStatus;
  } else if (input.lanes !== undefined) {
    // Same refusal as on create, and it has to be here too: a standard radar
    // cannot become smart, but a smart one can certainly be sent lanes.
    if (radar.kind === 'smart') {
      throw badRequest(
        'A smart radar has no lanes of its own: it gathers blips that live on other ' +
          'radars and are filed in theirs. Set lanes on the radar that holds them.',
      );
    }
    /*
     * A default the caller named wins; otherwise the stored one is carried over
     * only if the new vocabulary still has it, and forgotten if it does not.
     *
     * Carrying it blindly would be worse than useless: replacing a board's lanes
     * wholesale would then be *refused* for naming a default out of the set it
     * just replaced — a radar unable to change its own lanes because of a field
     * the caller never mentioned.
     */
    const keeps = (id: string | undefined) =>
      Boolean(id) && input.lanes?.some((lane) => lane.id === id);
    const wanted =
      input.defaultStatus ?? (keeps(merged.defaultStatus) ? (merged.defaultStatus ?? null) : null);

    const check = validateLanes(template, input.lanes, wanted);
    if (!check.ok) {
      throw badRequest(check.problems.map((problem) => problem.message).join(' '));
    }
    await assertNoStrandedBlips(radar.id, check.lanes, db);
    merged.lanes = check.lanes;
    merged.defaultStatus = check.defaultStatus;
  } else if (input.defaultStatus) {
    // A default moved on its own, against whatever lanes the radar has now.
    // Refused rather than stored and quietly ignored at read time — a capture
    // target that does not exist is exactly the kind of setting somebody sets
    // once and never checks.
    const lanes = statusesFor(template, merged);
    if (!lanes.some((lane) => lane.id === input.defaultStatus)) {
      throw badRequest(
        `"${input.defaultStatus}" is not a lane on this radar. It has: ` +
          `${lanes.map((lane) => lane.id).join(', ')}.`,
      );
    }
    merged.defaultStatus = input.defaultStatus;
  }

  return merged;
}

/**
 * What a radar must already be before it may sit on a client-facing template.
 *
 * Refused rather than repaired, for the reason custom lanes refuse a stranding
 * lane set (`docs/DESIGN.md` §4): a repair would be a second write the person
 * did not ask for.
 *
 * - **Public**: a helpdesk is never public (`docs/HELPDESK.md` §6.1), so a
 *   published radar is withdrawn first, deliberately, by whoever published it.
 *   This is the path `setVisibility`'s own refusal cannot see — switching the
 *   template of a radar that is already public.
 * - **Lanes without a `clientStatus`**: a stored custom lane set carries over a
 *   template switch, and on a client-facing template every lane must say what a
 *   client is shown. Sending `templateConfig.lanes: null` in the same call takes
 *   the template's own lanes instead, which is the one-call fix the message
 *   names.
 *
 * Members are deliberately not refused. Internal collaborators may work a
 * helpdesk and see its internal notes like on any radar; a client must never be
 * one, and that line is the sharer's (decision 5).
 */
function assertClientFacingFits(radar: RadarRow, template: string, config: TemplateConfig): void {
  if (!isClientFacingTemplate(template)) return;
  const label = RADAR_TEMPLATES[template as keyof typeof RADAR_TEMPLATES].label;
  if (radar.kind === 'smart') throw badRequest(smartIsNeverClientFacing(label));
  if (radar.visibility === 'public') {
    throw badRequest(
      `A ${label} radar is never public: its comments include internal notes about a client. ` +
        `Make this radar private first, then switch it.`,
    );
  }
  if (config.lanes?.length) {
    const check = validateLanes(template, config.lanes, config.defaultStatus ?? null);
    if (!check.ok) {
      throw badRequest(
        `${check.problems.map((problem) => problem.message).join(' ')} ` +
          `To use the ${label} template's own lanes, send templateConfig.lanes: null in the same call.`,
      );
    }
  }
}

/**
 * A smart radar is a view over other radars' blips, resolved per viewer. It has
 * no requests of its own to answer and no lanes of its own to map, and a client
 * side on a view would be a client side on whatever it happened to gather —
 * blips from radars that were never meant to face anybody (slice 1 QA minor).
 */
function smartIsNeverClientFacing(label: string): string {
  return (
    `A smart radar cannot be a ${label}: it only gathers blips that live on other radars. ` +
    `Create a ${label} radar instead.`
  );
}

/**
 * A lane set leaving a client-facing template drops its client statuses.
 *
 * A stored custom lane set carries over a template switch. Off a client-facing
 * template, `clientStatus` means nothing — and kept, it would ride silently back
 * onto the template if the radar were switched back, mapping lanes to client
 * statuses nobody had looked at since (slice 1 QA minor). Stripping it is not a
 * second write the person did not ask for: it is the part of the old template
 * that cannot exist on the new one, like its lanes on a template without a lane
 * axis. Coming back onto the template then meets `assertClientFacingFits`, which
 * asks for the mapping again or for the template's own lanes.
 */
function withoutClientStatuses(config: TemplateConfig): TemplateConfig | null {
  if (!config.lanes?.some((lane) => lane.clientStatus !== undefined)) return null;
  return {
    ...config,
    lanes: config.lanes.map(({ clientStatus: _dropped, ...rest }) => rest),
  };
}

/**
 * Refuse a lane set that would leave blips filed in a lane it does not declare.
 *
 * Counts rather than ids in the message, because the ids are the caller's own
 * words and the number is the thing it does not know. `status IS NOT NULL` on
 * purpose: an unlaned blip is not stranded, it is a blip on a radar that had no
 * lanes when it was captured, and it lands in the default lane the moment it is
 * next moved.
 */
async function assertNoStrandedBlips(
  radarId: string,
  lanes: readonly { id: string }[],
  db: Pick<Db, 'select'>,
): Promise<void> {
  const keeping = lanes.map((lane) => lane.id);
  const rows = await db
    .select({ status: schema.blips.status, count: sql<number>`count(*)::int` })
    .from(schema.blips)
    .where(
      and(
        eq(schema.blips.radarId, radarId),
        isNotNull(schema.blips.status),
        // Never empty: `validateLanes` has already required at least two lanes,
        // and `notInArray` over an empty list is not valid SQL.
        notInArray(schema.blips.status, keeping),
      ),
    )
    .groupBy(schema.blips.status);

  if (rows.length === 0) return;

  const stranded = rows
    .map((row) => `${row.count} in "${String(row.status)}"`)
    .join(', ')
    .replace(/, ([^,]*)$/, ' and $1');
  throw badRequest(
    `That lane set would strand blips this radar already holds: ${stranded}. ` +
      `Move them into a lane you are keeping first, or keep those lane ids and ` +
      `change only their labels.`,
  );
}

/**
 * The same check for a radar that does not exist yet.
 *
 * No stranded-blip query, because there are no blips: a new radar's lane set
 * only has to be coherent, not compatible with anything already filed.
 */
function newTemplateConfig(
  input: TemplateConfigInput | undefined,
  template: string,
  kind: RadarKind = 'standard',
): TemplateConfig {
  // Built key by key rather than spread, because `null` is a *value* on the way
  // in — "put the template's lanes back" — and is never a value in the column.
  const config: TemplateConfig = {};
  if (input?.grouping !== undefined) config.grouping = input.grouping;
  if (input?.collapseDone !== undefined) config.collapseDone = input.collapseDone;
  if (input?.lanes == null) return config;
  const lanes = input.lanes;
  const defaultStatus = input.defaultStatus ?? null;
  // A smart radar holds nothing of its own — it gathers blips that live on other
  // radars, each already filed in that radar's lanes, and it always reads in
  // capture order for exactly that reason. Lanes of its own would be a
  // vocabulary with nothing to say it about.
  if (kind === 'smart') {
    throw badRequest(
      'A smart radar has no lanes of its own: it gathers blips that live on other ' +
        'radars and are filed in theirs. Set lanes on the radar that holds them.',
    );
  }
  const check = validateLanes(template, lanes, defaultStatus);
  if (!check.ok) throw badRequest(check.problems.map((problem) => problem.message).join(' '));
  return { ...config, lanes: check.lanes, defaultStatus: check.defaultStatus };
}

export async function createRadar(actor: Actor, input: CreateRadarInput): Promise<RadarDto> {
  // No radar exists yet, so there is nothing for the clamp in `access.ts` to
  // narrow — the ceiling has to be asked about directly. `write` rather than
  // `manage`: a new radar is a container for your own capture and grants nobody
  // anything, and requiring `manage` would stop a `radars:write` agent from
  // capturing into the drop box, which is the cheapest capture path there is.
  await requireScope(actor, 'write', 'create a radar');
  // Creating straight into a topic is one call, but it is the same act as
  // `setRadarTopic` and gets the same check: you must be able to manage the
  // topic, or anyone could file a radar into somebody else's cascading group.
  const topic = input.topicId ? await requireTopic(input.topicId, actor, 'manage') : null;
  const [radar] = await withUniqueSlug(input.name, 'radars_owner_slug_key', (slug) =>
    getDb().transaction(async (tx) => {
      await lockOwner(tx, actor.user.id);
      return tx
        .insert(schema.radars)
        .values({
          ownerId: actor.user.id,
          slug,
          name: input.name,
          tagline: input.tagline ?? null,
          description: input.description ?? null,
          accent: input.accent ?? DEFAULT_RADAR_ACCENT,
          glyph: input.glyph ?? DEFAULT_RADAR_GLYPH,
          template: input.template ?? DEFAULT_RADAR_TEMPLATE,
          templateConfig: newTemplateConfig(
            input.templateConfig,
            input.template ?? DEFAULT_RADAR_TEMPLATE,
          ),
          ...(input.theme ? { theme: resolveThemeInput(input.theme) } : {}),
          ...(topic ? { topicId: topic.topic.id } : {}),
          ...(input.commentsEnabled !== undefined
            ? { commentsEnabled: input.commentsEnabled }
            : {}),
          ...(input.reactionsEnabled !== undefined
            ? { reactionsEnabled: input.reactionsEnabled }
            : {}),
          ...(input.archiveAfterDays !== undefined
            ? { archiveAfterDays: input.archiveAfterDays }
            : {}),
        })
        .returning();
    }),
  );
  if (!radar) throw new Error('radar insert returned no row');

  await recordAudit(actor, 'radar.create', 'radar', radar.id, {
    name: radar.name,
    template: radar.template,
    topicId: radar.topicId,
  });
  return toRadarDto(
    radar,
    OWNS_IT,
    { blipCount: 0, archivedCount: 0, memberCount: 1, lastBlipAt: null },
    await ownerSummary(radar.ownerId),
    topic?.topic ?? null,
  );
}

/**
 * The access block for a radar the caller just created. Spelled out once rather
 * than at three call sites, so a new field on `RadarAccessDto` cannot be added
 * to two of them and forgotten in the third.
 */
const OWNS_IT = {
  role: 'owner',
  directRole: 'owner',
  topicRole: null,
  via: 'owner',
  viaPublicLink: false,
  canRead: true,
  canWrite: true,
  canManage: true,
} as const satisfies Pick<
  RadarAccess,
  | 'role'
  | 'directRole'
  | 'topicRole'
  | 'via'
  | 'viaPublicLink'
  | 'canRead'
  | 'canWrite'
  | 'canManage'
>;

/* ----------------------------- smart radars ------------------------------ */

/**
 * Tags are stored canonically everywhere else, so a saved query has to be
 * canonical too — otherwise "#Side Projects" typed into a filter would never
 * match `side-projects` on a blip.
 */
function normalizeFilter(filter: SmartFilterInput): SmartFilter {
  const tags = normalizeTags(filter.tags);
  if (tags.length === 0) throw badRequest('A smart radar needs at least one usable tag');
  return {
    tags,
    match: filter.match ?? 'any',
    ...(filter.states?.length ? { states: filter.states } : {}),
    ...(filter.kinds?.length ? { kinds: filter.kinds } : {}),
    ...(filter.radarIds?.length ? { radarIds: filter.radarIds } : {}),
    ...(filter.q?.trim() ? { q: filter.q.trim() } : {}),
  };
}

/**
 * A radar that holds no blips of its own — it is a saved tag query, resolved at
 * read time. This is the "create smart radar" button on a tag page.
 */
export async function createSmartRadar(
  actor: Actor,
  input: CreateSmartRadarInput,
): Promise<RadarDto> {
  await requireScope(actor, 'write', 'create a smart radar');
  if (input.template && isClientFacingTemplate(input.template)) {
    throw badRequest(
      smartIsNeverClientFacing(
        RADAR_TEMPLATES[input.template as keyof typeof RADAR_TEMPLATES].label,
      ),
    );
  }
  const filter = normalizeFilter(input.filter);
  // A smart radar is never in a topic — see `assertRadarMayJoinTopic`. Refused
  // at creation as well as on assignment, so there is no route in at all.
  assertRadarMayJoinTopic(
    { isDropBox: false, kind: 'smart', name: input.name },
    input.topicId ?? null,
  );

  const [radar] = await withUniqueSlug(input.name, 'radars_owner_slug_key', (slug) =>
    getDb().transaction(async (tx) => {
      await lockOwner(tx, actor.user.id);
      return tx
        .insert(schema.radars)
        .values({
          ownerId: actor.user.id,
          slug,
          name: input.name,
          tagline:
            input.tagline ?? `Everything tagged ${filter.tags.map((t) => `#${t}`).join(' ')}`,
          description: input.description ?? null,
          accent: input.accent ?? DEFAULT_RADAR_ACCENT,
          glyph: input.glyph ?? 'target',
          kind: 'smart',
          filter,
          template: input.template ?? DEFAULT_RADAR_TEMPLATE,
          templateConfig: newTemplateConfig(
            input.templateConfig,
            input.template ?? DEFAULT_RADAR_TEMPLATE,
            'smart',
          ),
        })
        .returning();
    }),
  );
  if (!radar) throw new Error('smart radar insert returned no row');

  await recordAudit(actor, 'radar.create_smart', 'radar', radar.id, {
    name: radar.name,
    tags: filter.tags,
  });
  return toRadarDto(
    radar,
    { ...OWNS_IT, canWrite: false },
    { blipCount: 0, archivedCount: 0, memberCount: 1, lastBlipAt: null },
    await ownerSummary(radar.ownerId),
  );
}

/* -------------------------------- drop box ------------------------------- */

/**
 * The drop box: one radar per account for things that have no home yet —
 * appointments, reminders, "call the plumber". An agent's job is to sort it.
 *
 * It is a *real radar the user owns*, flagged rather than special-cased, so it
 * can be renamed, recoloured, shared and deleted like any other and nothing in
 * the app has to know about it. That also sidesteps the alternative — a
 * system-owned radar with no owner — which would need its own answer to every
 * question the ownership model already answers.
 *
 * Created on demand rather than at signup, because every account that already
 * exists needs one too and `ensureDefaultWorkspace` only ever runs once.
 */
const DROP_BOX = {
  name: 'Drop Box',
  tagline: 'Anything with no home yet — an agent can sort it later',
  description:
    'Freeform capture. Drop appointments, reminders and half-thoughts here, then ask an ' +
    'agent to file them: it can read this radar over MCP and move each blip where it belongs.',
} as const;

/**
 * The drop box has no public address, and it never gets one.
 *
 * It is the one radar in the application whose contents nobody chose to put
 * anywhere: appointments, reminders, a half-thought from the car. Every other
 * radar is a place you decided to keep a kind of thing, so publishing one is a
 * judgement about material you already grouped on purpose. Publishing the drop
 * box is publishing the pile you have not looked at yet — which is not an unwise
 * sharing decision so much as a category error, exactly like filing it under a
 * topic (`assertRadarMayJoinTopic`).
 *
 * Refused on **both** halves of "public", because they come apart. A minted
 * `publicSlug` survives going private — deliberately, so re-publishing restores
 * the same URL rather than silently issuing a new one — so a drop box that had
 * ever been published would keep a dormant public address afterwards. There is a
 * pair of CHECK constraints behind this in `0011_drop_box_is_private.sql`; this
 * is what turns them into a sentence.
 */
function assertDropBoxMayNotBePublished(radar: { isDropBox: boolean }, act: string): void {
  if (!radar.isDropBox) return;
  throw badRequest(
    `The drop box cannot be ${act}. It is your private inbox — the one radar holding things ` +
      'you have not decided anything about yet — so it has no public address at all. Move the ' +
      'blips you want to share into a radar of their own and publish that.',
  );
}

/**
 * An **agent** may not share the drop box onward. A person still may.
 *
 * A security review reported the drop box being shareable as an inconsistency
 * with the three refusals above, and it is not one. `DESIGN.md` §6.1 settles
 * this deliberately: a named, individually revocable grant is a different act
 * from having an address, and §6.2's entire recommendation for external drops —
 * "you never publish an address, you mint one per recipient" — is built on that
 * distinction holding. Refusing it outright would relitigate a recorded decision
 * on the strength of a demonstration that only showed sharing working.
 *
 * What the review did surface, by a route the document had not considered, is
 * the MCP boundary. §6.2 already makes this argument about webhooks — "it
 * matters most over MCP, where an agent holds manage on the drop box the moment
 * it connects" — and the same sentence is true of sharing. The drop box is the
 * one radar an agent is routinely *pointed at*, `read_drop_box` exists to hand
 * it the whole unsorted pile, and `share_radar` would let it pass that pile to
 * somebody else. That is the same shape as `assertMayInvite`: an agent may
 * share, because its human could, but there are acts whose consequence reaches
 * beyond this account and those need a person.
 *
 * So the grant stays available from the app, where the owner is looking at what
 * they are handing over, and is refused to a token. If the product owner decides the drop
 * box should be unshareable outright after all, this is the function to widen —
 * and `DESIGN.md` §6.1 is the paragraph that has to change with it.
 */
function assertDropBoxMayNotBeSharedByAnAgent(actor: Actor, radar: { isDropBox: boolean }): void {
  if (!radar.isDropBox) return;
  // `assertHumanDecision`, not a local `actor.kind` test: this is the same
  // question the `owner`-role refusal below asks — "is this the kind of act a
  // connection may perform at all" — and one mechanism means one answer.
  assertHumanDecision(
    actor,
    'That is your drop box — the private inbox holding the things you have not decided ' +
      'anything about yet — and handing it to somebody else is not something an agent may do. ' +
      'Share it from the app if you mean to, or move the blips somebody should see into a ' +
      'radar of their own and share that.',
  );
}

/**
 * A drop box may only be a template that declares itself an inbox.
 *
 * The reasoning belongs to the registry and is written there, on
 * `RadarTemplateDef.inbox`. What belongs here is the refusal, and that it is
 * spelled from the registry rather than against a pair of ids: the day a sixth
 * template is a good inbox, it declares so and this function starts allowing it
 * without being edited.
 *
 * Unlike the publishing rule there is no CHECK behind this one, and that is
 * deliberate rather than an omission — the template vocabulary lives in
 * TypeScript so that a new template needs no migration, and a constraint naming
 * template ids would take that away. `0011_drop_box_is_private.sql` says so at
 * length.
 */
function assertDropBoxTemplate(radar: { isDropBox: boolean }, template: string): void {
  if (!radar.isDropBox || isDropBoxTemplate(template)) return;
  throw badRequest(
    `The drop box can only be a ${dropBoxTemplateLabels()}. Every other template decides what ` +
      'its blips *are* — a link to read, a decision to record, a thread to answer — and the ' +
      'drop box is the one radar whose contents you have deliberately not decided anything ' +
      'about yet. Switch a radar of your own to that template instead.',
  );
}

export async function findDropBox(
  ownerId: string,
  dbc: Pick<Db, 'select'> = getDb(),
): Promise<RadarRow | null> {
  const rows = await dbc
    .select()
    .from(schema.radars)
    .where(and(eq(schema.radars.ownerId, ownerId), eq(schema.radars.isDropBox, true)))
    .limit(1);
  return rows[0] ?? null;
}

/** Idempotent and race-safe: the partial unique index decides, not this code. */
export async function ensureDropBox(
  actor: Actor,
  dbc: Pick<Db, 'select' | 'transaction'> = getDb(),
): Promise<RadarRow> {
  const existing = await findDropBox(actor.user.id, dbc);
  if (existing) return existing;
  // Creating the drop box creates a radar. A read-only connection reaching it
  // first — `read_drop_box`, or `GET /api/radars/drop-box` — must not be the
  // thing that does, any more than it may call `createRadar`.
  await requireScope(actor, 'write', 'create the drop box');

  try {
    const [created] = await withUniqueSlug(DROP_BOX.name, 'radars_owner_slug_key', (slug) =>
      dbc.transaction(async (tx) => {
        const rows = await tx
          .insert(schema.radars)
          .values({
            ownerId: actor.user.id,
            slug,
            name: DROP_BOX.name,
            tagline: DROP_BOX.tagline,
            description: DROP_BOX.description,
            // Deliberately neutral: the drop box is not a topic, it is a holding bay.
            accent: 'slate',
            glyph: 'compass',
            // Stated rather than left to the column default, because the set of
            // templates a drop box may take is now narrower than the set a radar may
            // take, and a default that drifted would be a silently invalid row.
            template: DEFAULT_DROP_BOX_TEMPLATE,
            isDropBox: true,
          })
          .returning();
        if (rows[0]) await recordAudit(actor, 'radar.create_drop_box', 'radar', rows[0].id, {}, tx);
        return rows;
      }),
    );
    if (!created) throw new Error('drop box insert returned no row');
    return created;
  } catch (err) {
    // Two concurrent first-captures both get here; the unique index picks one.
    const raced = await findDropBox(actor.user.id, dbc);
    if (raced) return raced;
    logger.error({ err, userId: actor.user.id }, 'drop box creation failed');
    throw err;
  }
}

export async function getDropBox(actor: Actor): Promise<RadarDto> {
  const radar = await ensureDropBox(actor);
  const access = await getRadarAccess(radar.id, actor);
  if (!access) throw notFound('Drop box not found');
  return getRadarDto(access, actor);
}

/**
 * An architecture radar's elements, seams and charter amendments only make sense
 * on that template: any other one hides them (a decisions template's
 * supersession files a boundary away, and switching back does not undo it). So
 * the template stays put while the radar holds any.
 */
async function assertTemplateUnlocked(
  db: Pick<Db, 'execute'>,
  radar: RadarRow,
  next: string | undefined,
): Promise<void> {
  if (radar.template !== 'architecture' || next === undefined || next === radar.template) return;
  const { rows } = await db.execute<{ locked: boolean }>(
    sql`SELECT EXISTS (SELECT 1 FROM blip_elements WHERE radar_id = ${radar.id})
        OR EXISTS (SELECT 1 FROM blip_relations WHERE radar_id = ${radar.id})
        OR EXISTS (SELECT 1 FROM charter_anchors WHERE radar_id = ${radar.id} AND state <> 'dismissed')
        OR (
          NOT EXISTS (SELECT 1 FROM charter_documents WHERE radar_id = ${radar.id})
          AND EXISTS (SELECT 1 FROM blips WHERE radar_id = ${radar.id} AND status = 'charter' AND position(':amend[' in body) > 0)
        )
        AS locked`,
  );
  if (rows[0]?.locked)
    throw new ApiError(
      409,
      'template_locked',
      'This radar has boundaries, contracts or amendments, which only the Architecture template can show. Delete them first, or keep the template.',
    );
}

export async function updateRadar(
  actor: Actor,
  radarId: string,
  input: UpdateRadarInput,
): Promise<RadarDto> {
  // Structural, sharing and reading-surface changes belong to the owner.
  // Editors may change ordinary presentation fields and display-only config.
  const needsOwner =
    input.name !== undefined ||
    input.archived !== undefined ||
    input.topicId !== undefined ||
    input.template !== undefined ||
    input.templateConfig?.lanes !== undefined ||
    input.filter !== undefined ||
    input.commentsEnabled !== undefined ||
    input.reactionsEnabled !== undefined ||
    input.archiveAfterDays !== undefined ||
    input.theme !== undefined;
  const need = needsOwner ? 'manage' : 'write';
  const first = await requireRadar(radarId, actor, need);
  if (input.template !== undefined) assertDropBoxTemplate(first.radar, input.template);

  /*
    One transaction, serialised per radar, and every merge made against the row
    as it stands once the lock is held.

    `templateConfig` and `theme` are patches folded into what is stored. Folded
    onto the copy `requireRadar` read before any lock, two saves at once each
    wrote their own fold of the same old value, and one erased the other: the
    settings page (which sends `grouping` and `collapseDone` on every save)
    racing `set_radar_lanes` put the old lanes back — past the stranded-blip
    check, which only runs when lanes are named. Every writer of those columns
    comes through here, so a transaction-scoped advisory lock per radar orders
    them; the array path writes through `setRadarTopic` on its own connections,
    which is why this is not simply a row lock.

    Without an array change the row is also locked FOR UPDATE, so the stranded
    check and the write are one step against captures, which key-share lock the row
    while they pick a lane (`createBlip`, `updateBlip`).
  */
  const updated = await getDb().transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`radar-settings:${first.radar.id}`}, 0))`,
    );
    if (input.topicId === undefined) {
      await tx
        .select({ id: schema.radars.id })
        .from(schema.radars)
        .where(eq(schema.radars.id, first.radar.id))
        .for('update');
    }
    const access = await requireRadar(first.radar.id, actor, need, tx);
    // Under the settings lock above, which element, seam and amendment writes on an
    // Architecture radar hold shared (`createBlip`): so this sees all of them, with or
    // without a topic change (whose own connection cannot wait on a row lock held here).
    await assertTemplateUnlocked(tx, access.radar, input.template);

    const patch: Partial<typeof schema.radars.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) {
      patch.name = input.name;
    }
    if (input.tagline !== undefined) patch.tagline = input.tagline;
    if (input.description !== undefined) patch.description = input.description;
    if (input.accent !== undefined) patch.accent = input.accent;
    if (input.glyph !== undefined) patch.glyph = input.glyph;
    if (input.archived !== undefined) patch.archived = input.archived;
    if (input.template !== undefined) patch.template = input.template;
    if (input.templateConfig !== undefined) {
      patch.templateConfig = await resolveTemplateConfigInput(
        access.radar,
        input.templateConfig,
        // The template it will be on when this lands, not the one it is on now: a
        // single call may move a radar to a board and give it lanes, and checking
        // the old template would refuse it for having no lane axis.
        input.template ?? access.radar.template,
        tx,
      );
    }
    // A client-facing radar (a helpdesk) is never public and shows its client
    // one fixed status per lane. Checked against the row as it stands under the
    // lock, and against the template it will be on when this lands.
    assertClientFacingFits(
      access.radar,
      input.template ?? access.radar.template,
      patch.templateConfig ?? asStored(access.radar.templateConfig) ?? {},
    );
    if (!isClientFacingTemplate(input.template ?? access.radar.template)) {
      const stripped = withoutClientStatuses(
        patch.templateConfig ?? asStored(access.radar.templateConfig) ?? {},
      );
      if (stripped) patch.templateConfig = stripped;
    }
    // A patch over what is stored, so setting one axis leaves the other eight.
    if (input.theme !== undefined) patch.theme = resolveThemeInput(input.theme, access.radar.theme);
    if (input.commentsEnabled !== undefined) patch.commentsEnabled = input.commentsEnabled;
    if (input.reactionsEnabled !== undefined) patch.reactionsEnabled = input.reactionsEnabled;
    // Stored on any template, applied only on one that archives. Refusing it on a
    // decision log would mean a radar switched to a board and back lost the
    // number, which is a worse surprise than an inert setting.
    if (input.archiveAfterDays !== undefined) patch.archiveAfterDays = input.archiveAfterDays;
    if (input.filter !== undefined) {
      if (access.radar.kind !== 'smart') {
        throw badRequest('Only a smart radar has a filter. Create one from a tag.');
      }
      patch.filter = normalizeFilter(input.filter);
    }

    if (input.topicId !== undefined) {
      // Assignment validates its complete sharing decision before applying this
      // metadata in the same UPDATE as topicId.
      await setRadarTopic(actor, access.radar.id, input.topicId, patch);
    } else {
      // Inside a savepoint per attempt, so a slug collision rolls back to it and
      // the next candidate can be tried in the same transaction.
      const write = (slug?: string) =>
        tx.transaction((attempt) =>
          attempt
            .update(schema.radars)
            .set({ ...patch, ...(slug ? { slug } : {}) })
            .where(eq(schema.radars.id, access.radar.id))
            .returning(),
        );
      const [row] =
        input.name === undefined
          ? await write()
          : await withUniqueSlug(input.name, 'radars_owner_slug_key', write);
      if (!row) throw notFound('Radar not found');
    }
    // Reminders follow the archive flag in the same commit, so an archived
    // radar's reminders never fire and a restored one's resume.
    if (input.archived !== undefined)
      await tx.execute(
        sql`UPDATE blip_reminders r SET reminder_at=CASE WHEN r.enabled AND NOT ${input.archived} AND b.state NOT IN ('done','dropped') AND b.due_at-make_interval(mins=>r.lead_minutes)>now() THEN b.due_at-make_interval(mins=>r.lead_minutes) ELSE NULL END, queued_at=NULL FROM blips b WHERE r.blip_id=b.id AND b.radar_id=${access.radar.id}::uuid AND r.triggered_at IS NULL`,
      );
    return access.radar;
  });
  await recordAudit(actor, 'radar.update', 'radar', updated.id, { fields: Object.keys(input) });
  return getRadarDto(await requireRadar(updated.id, actor, 'read'), actor);
}

/**
 * Deleting a radar takes its objects out of MinIO with it.
 *
 * The keys have to be read **before** the row goes: `attachments` is
 * `ON DELETE CASCADE` on `radars`, and those rows hold the only record of what
 * was ever uploaded. Deleting the radar first and looking afterwards finds
 * nothing, which is exactly what used to happen — every object a deleted radar
 * owned stayed in the bucket forever, unreachable and uncountable. Unbounded
 * growth is the cheap half of that; the expensive half is that files somebody
 * believes they deleted are still sitting there.
 *
 * The cleanup goes through the outbox rather than being fired and forgotten:
 * the radar is gone from the database either way, and a MinIO outage must not
 * turn a delete into a 500 that invites the caller to try again — but a lost
 * attempt used to mean an orphaned object forever, with no sweep to find it.
 * Now it means a retry.
 */
export async function deleteRadar(actor: Actor, radarId: string): Promise<void> {
  const access = await requireRadar(radarId, actor, 'manage');
  if (access.radar.isDropBox)
    throw badRequest('The Drop Box is your permanent inbox and cannot be deleted.');
  let cleanupJob: string | undefined;
  const objects = await getDb().transaction(async (db) => {
    // The cascade below is one statement over every blip, comment and attachment on the
    // radar, which is the one request that can legitimately outlast the pool's 5 s limit.
    await db.execute(sql`SELECT set_config('statement_timeout', '60000', true)`);
    // Lock the aggregate before reading its objects so concurrent captures
    // cannot add an attachment between this snapshot and the cascade.
    await db
      .select({ id: schema.radars.id })
      .from(schema.radars)
      .where(eq(schema.radars.id, access.radar.id))
      .for('update');
    const rows = await db
      .select({ objectKey: schema.attachments.objectKey })
      .from(schema.attachments)
      .where(eq(schema.attachments.radarId, access.radar.id));
    const pendingEmails = await db
      .select({
        files: schema.emailCaptureReceipts.files,
        email: schema.emailCaptureReceipts.email,
      })
      .from(schema.emailCaptureReceipts)
      .where(eq(schema.emailCaptureReceipts.radarId, access.radar.id));
    const capturedEmails = await db
      .select({
        payloadKey: schema.blipEmails.payloadKey,
        originalKey: schema.blipEmails.originalKey,
      })
      .from(schema.blipEmails)
      .innerJoin(schema.blips, eq(schema.blips.id, schema.blipEmails.blipId))
      .where(eq(schema.blips.radarId, access.radar.id));
    await db.delete(schema.radars).where(eq(schema.radars.id, access.radar.id));
    const keys = [
      ...rows.map((row) => row.objectKey),
      ...pendingEmails.flatMap((row) => [
        ...row.files.map((file) => file.key),
        ...(row.email ? [row.email.payloadKey, row.email.originalKey] : []),
      ]),
      ...capturedEmails.flatMap((row) =>
        [row.payloadKey, row.originalKey].filter((key): key is string => Boolean(key)),
      ),
    ];
    if (keys.length > 0) cleanupJob = await enqueue(db, 'object-cleanup', { keys });
    return rows;
  });
  if (cleanupJob) void drainOne(cleanupJob).catch(() => undefined);
  await recordAudit(actor, 'radar.delete', 'radar', access.radar.id, {
    name: access.radar.name,
    attachments: objects.length,
  });
}

export async function setVisibility(
  actor: Actor,
  radarId: string,
  visibility: 'private' | 'public',
  allowIndex = false,
): Promise<RadarDto> {
  const access = await requireRadar(radarId, actor, 'manage');

  if (visibility === 'public') assertDropBoxMayNotBePublished(access.radar, 'published');

  // A helpdesk's comments include internal notes about a client, and a public
  // link would serve them to anybody with the URL. A CHECK constraint stands
  // behind this (0042); this is the sentence. `docs/HELPDESK.md` §6.1.
  if (visibility === 'public' && isClientFacingTemplate(access.radar.template)) {
    throw badRequest(
      'A Helpdesk radar is never public: its comments include internal notes about a client, ' +
        'and the client portal is the only way a client sees anything here.',
    );
  }
  // …and a radar that ever was one, whatever its template now: switching off
  // the template does not take the internal notes and drafts off the radar
  // (qa-reviewer, slice 2). CHECK `radars_once_client_facing_never_public`
  // (0044) stands behind this.
  if (visibility === 'public' && neverPublic(access.radar)) {
    throw badRequest(
      'This radar has been a Helpdesk, so it can never be public: its comments include ' +
        'internal notes about a client. Capture what you want to publish on another radar.',
    );
  }

  // A smart radar resolves against the *caller's* readable radars. An anonymous
  // caller has none, so a public smart radar could only ever be resolved against
  // somebody's private material — which is exactly the disclosure the whole
  // resolution rule exists to prevent. There is a CHECK constraint behind this.
  if (access.radar.kind === 'smart' && visibility === 'public') {
    throw badRequest(
      'A smart radar cannot be published: it is a view of your own radars, so there ' +
        'would be nothing for a stranger to see. Publish the radars behind it instead.',
    );
  }

  const patch: Partial<typeof schema.radars.$inferInsert> = {
    visibility,
    allowIndex: visibility === 'public' ? allowIndex : false,
    updatedAt: new Date(),
  };
  // Going public mints a slug if there isn't one; going private keeps it, so
  // re-sharing later restores the same URL rather than silently minting a new
  // one. Use `rotatePublicSlug` to deliberately break existing links.
  if (visibility === 'public' && !access.radar.publicSlug) patch.publicSlug = newPublicSlug();

  const [updated] = await getDb()
    .update(schema.radars)
    .set(patch)
    .where(eq(schema.radars.id, access.radar.id))
    .returning();
  if (!updated) throw notFound('Radar not found');

  await recordAudit(actor, 'radar.visibility', 'radar', updated.id, { visibility, allowIndex });
  return getRadarDto({ ...access, radar: updated });
}

/** Invalidates the existing public URL and issues a new one. */
export async function rotatePublicSlug(actor: Actor, radarId: string): Promise<RadarDto> {
  const access = await requireRadar(radarId, actor, 'manage');
  // Not merely pointless on a drop box — it is the half of "public" that
  // survives being switched off, so minting one here would leave a working
  // public address on a private inbox behind a `visibility` flag. The CHECK in
  // 0011 refuses the write; this refuses the request.
  assertDropBoxMayNotBePublished(access.radar, 'given a public link');
  // The same reason, on a helpdesk (slice 1 QA minor): a public slug is the
  // half of "public" that survives being private, and a helpdesk is never
  // public (`docs/HELPDESK.md` §6.1). `getRadarAccess` would not honour one, so
  // this mints nothing anybody could use — which is exactly why minting it is
  // refused rather than allowed to look like it worked.
  if (neverPublic(access.radar)) {
    throw badRequest(
      'A Helpdesk radar, or one that has been, has no public link, so there is nothing to rotate. ' +
        'The client portal is the only way a client sees anything here.',
    );
  }
  const [updated] = await getDb()
    .update(schema.radars)
    .set({ publicSlug: newPublicSlug(), updatedAt: new Date() })
    .where(eq(schema.radars.id, access.radar.id))
    .returning();
  if (!updated) throw notFound('Radar not found');
  await recordAudit(actor, 'radar.rotate_link', 'radar', updated.id, {});
  return getRadarDto({ ...access, radar: updated });
}

/* ------------------------------ membership ------------------------------ */

/**
 * Who can reach this radar, including people who reach it only through a
 * cascading topic.
 *
 * **Cascaded members are listed.** They hold no `radar_members` row and would
 * otherwise be invisible here, which would make the member list a lie: an owner
 * looking at "who can see this" has to be shown everybody who can see it, not
 * only everybody who was added to it. Access nobody can enumerate is access
 * nobody audits. They are marked `via: 'topic'` and named with the topic that
 * put them there, and they disappear from this list the moment the cascade is
 * switched off — which is the honest rendering of what that switch does.
 *
 * **A caller with no grant is refused outright.** Publishing a radar is a
 * decision about its contents, never about who it is shared with, and this list
 * carries the address of every member *and every pending invitee* — people who
 * never accepted and may hold no account at all. `requireRadar` has to accept a
 * `public_slug` as an identifier (or the thread on a published blip is
 * unreachable), so what reaches here is a genuine `canRead`; the refusal is
 * against enumeration, not against the radar.
 *
 * 403 rather than the usual 404, and only here: the caller demonstrably holds a
 * working public link already, so the radar's existence is not news and a 404
 * would only be misleading. Anybody with a role, however narrow — including one
 * that arrives through a cascading topic — still sees the whole list.
 */
export async function listMembers(access: RadarAccess): Promise<MemberDto[]> {
  if (isPublicOnly(access)) {
    throw forbidden('Only people this radar is shared with can see who it is shared with');
  }
  const db = getDb();
  const owner = await ownerSummary(access.radar.ownerId);
  const members = await db
    .select({
      userId: schema.radarMembers.userId,
      role: schema.radarMembers.role,
      createdAt: schema.radarMembers.createdAt,
      email: schema.users.email,
      name: schema.users.name,
    })
    .from(schema.radarMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.radarMembers.userId))
    .where(eq(schema.radarMembers.radarId, access.radar.id));

  const invites = await db
    .select()
    .from(schema.radarInvites)
    .where(
      and(eq(schema.radarInvites.radarId, access.radar.id), isNull(schema.radarInvites.acceptedAt)),
    );

  // Only when the topic actually cascades: a grant on a non-cascading topic
  // conveys no access to this radar, so listing those people here would claim
  // an access they do not have.
  const cascaded =
    access.topic?.cascade === true && access.topic.ownerId === access.radar.ownerId
      ? await db
          .select({
            userId: schema.topicMembers.userId,
            role: schema.topicMembers.role,
            createdAt: schema.topicMembers.createdAt,
            email: schema.users.email,
            name: schema.users.name,
          })
          .from(schema.topicMembers)
          .innerJoin(schema.users, eq(schema.users.id, schema.topicMembers.userId))
          .where(eq(schema.topicMembers.topicId, access.topic.id))
      : [];

  const directIds = new Set([access.radar.ownerId, ...members.map((m) => m.userId)]);
  // A connection limited to selected radars reaches no topic, so it is not told the name or id
  // of the one this radar is filed in. The people it gives access are still listed.
  const topicRef =
    access.topic && access.agentCeiling === undefined
      ? { id: access.topic.id, name: access.topic.name }
      : null;

  return [
    ...(owner
      ? [
          {
            userId: owner.id,
            email: owner.email,
            name: owner.name,
            role: 'owner' as RadarRole,
            pending: false,
            via: 'owner' as const,
            viaTopic: null,
            createdAt: access.radar.createdAt.toISOString(),
          },
        ]
      : []),
    ...members.map((m) => ({
      userId: m.userId,
      email: m.email,
      name: m.name,
      role: m.role,
      pending: false,
      via: 'member' as const,
      viaTopic: null,
      createdAt: m.createdAt.toISOString(),
    })),
    // Anybody with a direct grant is already above at their effective role;
    // listing them twice would read as two grants where there is one.
    ...cascaded
      .filter((m) => !directIds.has(m.userId))
      .map((m) => ({
        userId: m.userId,
        email: m.email,
        name: m.name,
        role: CASCADE_GRANTS[m.role],
        pending: false,
        via: 'topic' as const,
        viaTopic: topicRef,
        createdAt: m.createdAt.toISOString(),
      })),
    ...invites.map((i) => ({
      userId: '',
      email: i.email,
      name: null,
      role: i.role,
      pending: true,
      via: 'member' as const,
      viaTopic: null,
      createdAt: i.createdAt.toISOString(),
    })),
  ];
}

export interface ShareResult {
  status: 'added' | 'invited' | 'updated';
  email: string;
  role: RadarRole;
  /**
   * True when this share also let a waitlisted account into the app. Only an
   * admin's share can do that, and the caller is told so it can say so — an
   * approval that happens invisibly is one nobody can audit at the moment it
   * matters.
   */
  approved: boolean;
  /**
   * The invitation link, on the `invited` branch only, and returned only to the
   * person who just made the invitation and holds `manage` on the radar.
   *
   * It exists because **the email is not guaranteed to arrive**. With no
   * `RESEND_API_KEY` — a self-hosted instance, or a cluster where that secret has
   * not been filled in — mail delivery logs and returns, which would leave
   * inviting somebody with no working path at all. Handing the link back makes
   * that recoverable by pasting it into whatever the person actually uses.
   *
   * Safe to return here in a way it would not be from the member list: the link
   * grants nothing on its own (see `services/invites.ts`), and this response goes
   * only to the caller who just created the invitation.
   */
  inviteUrl: string | null;
}

/**
 * Shares with an address whether or not it has an account yet. An unknown
 * address gets an invite row, claimed the first time that person signs in.
 *
 * **The email and the notification are raised here, not in the route.** They
 * used to be sent by `POST /api/radars/:id/members`, which meant the MCP
 * `share_radar` tool granted access in total silence — an agent could hand
 * somebody a radar and that person would never find out. Telling the recipient
 * is part of what sharing *means*, so it belongs on the one code path both
 * transports run, exactly like the authorization check above it.
 */
export async function shareRadar(
  actor: Actor,
  radarId: string,
  email: string,
  role: RadarRole,
): Promise<ShareResult> {
  const access = await requireRadar(radarId, actor, 'manage');

  assertDropBoxMayNotBeSharedByAnAgent(actor, access.radar);

  /*
    An agent may share; it may not hand the radar over.

    `owner` in `radar_members` is `canManage`, which is the right to publish the
    radar, share it onward, and delete it outright. Granting it is not "change
    who they are shared with" — the sentence the consent screen uses — it is
    giving somebody else the power to destroy the thing. The MCP tool declared
    `z.enum(RADAR_ROLES)` while its own description named only viewer and editor,
    so the third value was reachable and undocumented in the same breath.

    Viewer and editor stay an agent's job: both are recoverable with one click on
    the member list, and neither can remove the owner. This is the same line
    `assertMayInvite` draws — an agent does the reversible half.
  */
  if (role === 'owner') {
    assertHumanDecision(
      actor,
      `Granting "owner" on "${access.radar.name}" would let that person publish it, share ` +
        'it onward and delete it outright. That is handing the radar over rather than ' +
        'sharing it, and it is not something an agent may do — share it as a viewer or an ' +
        'editor, or ask the user to do it from the radar’s member list.',
    );
  }

  const normalized = normalizeEmail(email);
  const db = getDb();

  if (normalized === actor.user.email) {
    throw badRequest('You already own this radar');
  }

  const [existingUser] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, normalized))
    .limit(1);

  if (!existingUser) {
    // Also what keeps an agent from rewriting a pending invitation to co-own:
    // it may not touch invitations at all.
    assertMayInvite(actor);
    // `onConflictDoUpdate`, not `onConflictDoNothing`: re-sharing a pending
    // invitation at a higher role used to be swallowed, so the person arrived as
    // a viewer after being told they were an editor. The target is the partial
    // unique index — `(radar_id, email) WHERE accepted_at IS NULL` — so an
    // invitation already accepted is untouched and never resurrected.
    let mailJob: string | undefined;
    const invite = await db.transaction(async (tx) => {
      const [invite] = await tx
        .insert(schema.radarInvites)
        .values({ radarId: access.radar.id, email: normalized, role, invitedBy: actor.user.id })
        .onConflictDoUpdate({
          target: [schema.radarInvites.radarId, schema.radarInvites.email],
          targetWhere: isNull(schema.radarInvites.acceptedAt),
          set: { role, invitedBy: actor.user.id },
        })
        .returning();
      if (!invite) throw conflict('That invitation could not be written');

      mailJob = await enqueue(tx, 'email', {
        ...radarSharedMessage(normalized, access.radar.name, actor.user.name ?? actor.user.email, {
          hasAccount: false,
          link: inviteUrl('radar', invite.id, invite.createdAt),
          // Asked of the invitation that was just written, so it answers with this
          // actor's *current* admin bit rather than a copy taken earlier.
          skipsWaitlist: await invitationBypassFor(normalized, tx),
        }),
      });
      return invite;
    });
    if (mailJob) void drainOne(mailJob).catch(() => undefined);
    await recordAudit(actor, 'radar.invite', 'radar', access.radar.id, { email: normalized, role });
    return {
      status: 'invited',
      email: normalized,
      role,
      approved: false,
      inviteUrl: inviteUrl('radar', invite.id, invite.createdAt),
    };
  }

  if (existingUser.id === access.radar.ownerId) {
    throw badRequest('That person already owns this radar');
  }
  // Refused before anything below writes — the waitlist approval included.
  const existingRole = await directRoleFor(access.radar, existingUser.id);
  if (existingRole === 'owner' && role !== 'owner') assertMayChangeCoOwner(actor, access.radar);

  // They have an account but have never been let into the app. An admin sharing
  // with them is the same decision as an admin approving them, so it is the same
  // code path — and it is taken here rather than at their next sign-in, because
  // `findOrCreateUser` decides an initial state and nothing more.
  const approved =
    mayBypassWaitlist(actor) && (await activateUser(actor, existingUser, 'invitation'));

  let notificationJob: string | undefined;
  let mailJob: string | undefined;
  await db.transaction(async (tx) => {
    await tx
      .insert(schema.radarMembers)
      .values({
        radarId: access.radar.id,
        userId: existingUser.id,
        role,
        invitedBy: actor.user.id,
      })
      .onConflictDoUpdate({
        target: [schema.radarMembers.radarId, schema.radarMembers.userId],
        set: { role },
      });
    // A co-owner demoted below owner loses `manage` exactly as a removed one does;
    // in the same transaction as the demotion, so it cannot be left half done.
    if (existingRole === 'owner' && role !== 'owner') {
      await detachRadarFromForeignTopic(actor, access.radar.id, tx);
    }
    if (!existingRole) {
      notificationJob = await enqueueNotificationEvent(tx, {
        type: 'share',
        actor,
        radarId: access.radar.id,
        recipientId: existingUser.id,
      });
      mailJob = await enqueue(tx, 'email', {
        ...radarSharedMessage(normalized, access.radar.name, actor.user.name ?? actor.user.email, {
          hasAccount: true,
          link: `${env().APP_URL}/radar/${access.radar.id}`,
          skipsWaitlist: false,
        }),
      });
    }
  });
  if (notificationJob) await drainOne(notificationJob);
  if (mailJob) void drainOne(mailJob).catch(() => undefined);
  await recordAudit(actor, 'radar.share', 'radar', access.radar.id, { email: normalized, role });
  return {
    status: existingRole ? 'updated' : 'added',
    email: normalized,
    role,
    approved,
    inviteUrl: null,
  };
}

/**
 * Demoting or removing a co-owner is a person's decision, never an agent's.
 *
 * The mirror of refusing an agent the grant of `owner` in `shareRadar`: a
 * co-owner holds `canManage` — publish, share onward, delete — and taking that
 * away changes who controls the radar, not who can read it. An agent with
 * manage rights may still add, re-role and remove viewers and editors; the
 * co-owners are the user's to change. Checked on the service path, so a PAT
 * over REST is refused exactly as an MCP tool is.
 */
function assertMayChangeCoOwner(
  actor: Actor,
  radar: RadarRow,
  standing: 'co-owns' | 'is invited to co-own' = 'co-owns',
): void {
  assertHumanDecision(
    actor,
    `That person ${standing} "${radar.name}". Changing or removing a co-owner changes who ` +
      'controls the radar, which is the user’s decision rather than an agent’s — ask them ' +
      'to do it from the radar’s member list.',
  );
}

export async function removeMember(actor: Actor, radarId: string, userId: string): Promise<void> {
  const access = await requireRadar(radarId, actor, 'manage');
  if (userId === access.radar.ownerId) throw conflict('The owner cannot be removed');
  if ((await directRoleFor(access.radar, userId)) === 'owner') {
    assertMayChangeCoOwner(actor, access.radar);
  }
  // The removal and the detachment are one step: a removal interrupted between
  // two statements used to leave the radar in the former co-owner's topic, and the
  // retry, finding nothing left to delete, returned without ever detaching it.
  // Detachment is idempotent and runs whether or not a row was removed now.
  const removed = await getDb().transaction(async (tx) => {
    const rows = await tx
      .delete(schema.radarMembers)
      .where(
        and(
          eq(schema.radarMembers.radarId, access.radar.id),
          eq(schema.radarMembers.userId, userId),
        ),
      )
      .returning({ userId: schema.radarMembers.userId });
    await detachRadarFromForeignTopic(actor, access.radar.id, tx);
    return rows;
  });
  // Idempotent, as the MCP tool promises: a retry after a timeout removes
  // nothing, so it sweeps nothing and records nothing.
  if (removed.length === 0) return;
  // Somebody who also holds a cascading topic grant still reads the radar, so
  // their notifications and mentions here are still theirs. Sweeping anyway left
  // a person who could open the radar with its notifications gone and their
  // handle no longer resolving. The topic path sweeps only what was actually
  // lost (`radarsReachableOnlyViaTopic`); this now agrees with it.
  const stillReads = (await radarReaders(access.radar)).some((reader) => reader.id === userId);
  if (!stillReads) {
    // Their notifications for this radar go with their access. Re-deriving
    // recipients already stops new ones, but the ones already written carry
    // snapshot excerpts of the content — so leaving them would hand a removed
    // member a readable copy of a conversation they can no longer open.
    await dropRadarNotifications(userId, access.radar.id);
    // And the mentions that named them here. A mention is resolved against
    // `radarReaders`, so a handle naming somebody who has just been removed
    // would not resolve if it were typed today; leaving the row behind makes it
    // keep resolving, which is the member list saying one thing and the blip
    // saying another.
    await dropRadarMentions(userId, access.radar.id);
  }
  await recordAudit(actor, 'radar.unshare', 'radar', access.radar.id, { userId });
}

export async function revokeInvite(actor: Actor, radarId: string, email: string): Promise<void> {
  const access = await requireRadar(radarId, actor, 'manage');
  // An invitation to co-own was a person's decision to hand the radar over;
  // an agent may not quietly take it back any more than it may make one.
  const [pending] = await getDb()
    .select({ role: schema.radarInvites.role })
    .from(schema.radarInvites)
    .where(
      and(
        eq(schema.radarInvites.radarId, access.radar.id),
        eq(schema.radarInvites.email, normalizeEmail(email)),
        isNull(schema.radarInvites.acceptedAt),
      ),
    )
    .limit(1);
  if (pending?.role === 'owner')
    assertMayChangeCoOwner(actor, access.radar, 'is invited to co-own');
  await getDb()
    .delete(schema.radarInvites)
    .where(
      and(
        eq(schema.radarInvites.radarId, access.radar.id),
        eq(schema.radarInvites.email, normalizeEmail(email)),
        isNull(schema.radarInvites.acceptedAt),
      ),
    );
  await recordAudit(actor, 'radar.revoke_invite', 'radar', access.radar.id, { email });
}
