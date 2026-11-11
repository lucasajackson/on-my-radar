/**
 * Integration credentials: minting, rotation, revocation and enrolment
 * (`docs/HELPDESK.md` §3.1, §3.2, §3.4).
 *
 * ## Who may do what
 *
 * Every act that **widens** what an outside system can reach — minting a
 * credential, rotating it (a new secret), enrolling a radar — is a person's
 * decision on a real screen (`assertHumanDecision`), in the same class as
 * minting a PAT or turning a topic's cascade on. So is every act that destroys
 * a credential (revoking it, ending a rotation's overlap), which §22 already
 * lists as human-only. An agent may **list** integrations and **unenrol** a
 * radar: the safe direction, like `delete_subscription`.
 *
 * ## Revoked, never deleted
 *
 * There is no delete here, and a trigger refuses one from anywhere else
 * (`drizzle/0045`). Revocation is terminal and takes every live enrolment with
 * it in the same transaction, so the requests, client replies and audit rows
 * that name the integration keep a valid reference forever.
 *
 * ## Expiry and overlap (decision 6)
 *
 * 90 days from mint or rotation; a rotation keeps the old token working for at
 * most 24 hours (2 by default, 0 for a leak). The times are written with the
 * database's `now()` in one statement, which is what the CHECKs that bound
 * them read, so the service and the constraint cannot disagree by a clock skew.
 * Both are in hours, never days: a day-interval is calendar arithmetic in the
 * session's time zone, and "90 days" across a daylight-saving change is 2159
 * or 2161 hours (drizzle/0046).
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  INTEGRATION_LIMITS,
  isClientFacingTemplate,
  rotateIntegrationSchema,
  type CreateIntegrationInput,
  type EnrolRadarInput,
  type IntegrationDto,
  type IntegrationEnrolmentDto,
  type RotateIntegrationInput,
} from '@onmyradar/contract';
import { hashSecret, newIntegrationToken, tokenPrefix } from '../auth/crypto.js';
import { getDb, schema } from '../db/client.js';
import { badRequest, conflict, notFound, type Actor } from '../http.js';
import { assertHumanDecision, requireRadar, requireScope, type IntegrationRow } from './access.js';
import { recordAudit } from './audit.js';
import { deliveryOf, pendingDeliveries } from './integration-events.js';
import { isUniqueViolation } from './slugs.js';

const MINT_REFUSAL =
  'Connecting an outside system is a decision for the account owner in a signed-in ' +
  'browser: open Settings → Connections.';
const DESTROY_REFUSAL =
  'Revoking or rotating an integration credential is done by the account owner in a ' +
  'signed-in browser: open Settings → Connections. An agent may unenrol a radar instead.';
const ENROL_REFUSAL =
  'Connecting a helpdesk to a client portal discloses its client side to an outside ' +
  'system, so the account owner does it in a signed-in browser (radar settings → Client portal).';

const NOT_FOUND = 'Integration not found';

/** Decision 6 in absolute hours, as the CHECK reads it (`drizzle/0046`). */
const EXPIRY_HOURS = INTEGRATION_LIMITS.expiryDays * 24;

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

async function enrolmentsFor(ids: string[]): Promise<Map<string, IntegrationEnrolmentDto[]>> {
  const out = new Map<string, IntegrationEnrolmentDto[]>();
  if (ids.length === 0) return out;
  const rows = await getDb()
    .select({ enrolment: schema.integrationRadars, radarName: schema.radars.name })
    .from(schema.integrationRadars)
    .innerJoin(schema.radars, eq(schema.radars.id, schema.integrationRadars.radarId))
    .where(
      and(
        inArray(schema.integrationRadars.integrationId, ids),
        isNull(schema.integrationRadars.revokedAt),
      ),
    )
    .orderBy(asc(schema.integrationRadars.enrolledAt));
  for (const row of rows) {
    const list = out.get(row.enrolment.integrationId) ?? [];
    list.push({
      id: row.enrolment.id,
      radarId: row.enrolment.radarId,
      radarName: row.radarName,
      externalRef: row.enrolment.externalRef,
      enrolledAt: row.enrolment.enrolledAt.toISOString(),
    });
    out.set(row.enrolment.integrationId, list);
  }
  return out;
}

function toDto(
  row: IntegrationRow,
  enrolments: IntegrationEnrolmentDto[],
  pending: number,
  token?: string,
): IntegrationDto {
  const previousLive =
    row.previousHash !== null &&
    row.previousExpiresAt !== null &&
    row.previousExpiresAt.getTime() > Date.now();
  return {
    id: row.id,
    purpose: row.purpose,
    name: row.name,
    staffDisplayName: row.staffDisplayName,
    agentReplyPolicy: row.agentReplyPolicy,
    tokenPrefix: row.tokenPrefix,
    tokenLastUsedAt: iso(row.tokenLastUsedAt),
    previous:
      previousLive && row.previousExpiresAt
        ? {
            expiresAt: row.previousExpiresAt.toISOString(),
            lastUsedAt: iso(row.previousLastUsedAt),
          }
        : null,
    expiresAt: row.expiresAt.toISOString(),
    rotatedAt: iso(row.rotatedAt),
    createdAt: row.createdAt.toISOString(),
    revokedAt: iso(row.revokedAt),
    // A revoked integration reaches nothing, whatever rows say.
    enrolments: row.revokedAt ? [] : enrolments,
    delivery: deliveryOf(row, pending),
    ...(token ? { token } : {}),
  };
}

/** The caller's own integration, or a 404 that does not say whether it exists. */
async function ownIntegration(actor: Actor, integrationId: string): Promise<IntegrationRow> {
  const [row] = await getDb()
    .select()
    .from(schema.integrations)
    .where(
      and(
        eq(schema.integrations.id, integrationId),
        eq(schema.integrations.ownerId, actor.user.id),
      ),
    )
    .limit(1);
  if (!row) throw notFound(NOT_FOUND);
  return row;
}

async function dtoFor(row: IntegrationRow, token?: string): Promise<IntegrationDto> {
  const [enrolments, pending] = await Promise.all([
    enrolmentsFor([row.id]),
    pendingDeliveries([row.id]),
  ]);
  return toDto(row, enrolments.get(row.id) ?? [], pending.get(row.id) ?? 0, token);
}

/** One of the caller's integrations, as it is now. Agents may read it. */
export async function getIntegration(actor: Actor, integrationId: string): Promise<IntegrationDto> {
  await requireScope(actor, 'read', 'read an integration');
  return dtoFor(await ownIntegration(actor, integrationId));
}

/** Every integration the caller owns, newest first, revoked ones included. Agents may read it. */
export async function listIntegrations(actor: Actor): Promise<IntegrationDto[]> {
  await requireScope(actor, 'read', 'list integrations');
  const rows = await getDb()
    .select()
    .from(schema.integrations)
    .where(eq(schema.integrations.ownerId, actor.user.id))
    .orderBy(desc(schema.integrations.createdAt));
  const ids = rows.map((row) => row.id);
  const [enrolments, pending] = await Promise.all([enrolmentsFor(ids), pendingDeliveries(ids)]);
  return rows.map((row) => toDto(row, enrolments.get(row.id) ?? [], pending.get(row.id) ?? 0));
}

export async function createIntegration(
  actor: Actor,
  input: CreateIntegrationInput,
): Promise<IntegrationDto> {
  assertHumanDecision(actor, MINT_REFUSAL);
  const token = newIntegrationToken();
  const [row] = await getDb()
    .insert(schema.integrations)
    .values({
      ownerId: actor.user.id,
      name: input.name,
      ...(input.staffDisplayName ? { staffDisplayName: input.staffDisplayName } : {}),
      tokenHash: hashSecret(token),
      tokenPrefix: tokenPrefix(token),
      // Against the row's own created_at, which defaults to the same now().
      expiresAt: sql`now() + make_interval(hours => ${EXPIRY_HOURS})`,
    })
    .returning();
  if (!row) throw new Error('integration insert returned no row');
  await recordAudit(actor, 'integration.create', 'integration', row.id, { name: row.name });
  return dtoFor(row, token);
}

/**
 * A new secret, and the old one kept alive for `overlapHours` (0–24) so the
 * portal can pick the new value up from its secret store without an outage. 0 is the
 * leak response: the old token dies in this statement.
 */
export async function rotateIntegration(
  actor: Actor,
  integrationId: string,
  input: RotateIntegrationInput = {},
): Promise<IntegrationDto> {
  assertHumanDecision(actor, DESTROY_REFUSAL);
  // Parsed here as well as at the route, so a direct caller cannot ask for a
  // longer overlap than decision 6 allows. The CHECK stands behind both.
  const parsed = rotateIntegrationSchema.safeParse(input);
  if (!parsed.success) {
    throw badRequest(
      `An old token keeps working for 0 to ${INTEGRATION_LIMITS.maxOverlapHours} hours after a rotation, whole hours only.`,
    );
  }
  const { overlapHours } = parsed.data;
  const existing = await ownIntegration(actor, integrationId);
  if (existing.revokedAt) throw conflict('This integration is revoked. Connect a new one instead.');
  const token = newIntegrationToken();
  const [row] = await getDb()
    .update(schema.integrations)
    .set({
      tokenHash: hashSecret(token),
      tokenPrefix: tokenPrefix(token),
      tokenLastUsedAt: null,
      previousHash: overlapHours > 0 ? existing.tokenHash : null,
      previousExpiresAt:
        overlapHours > 0 ? sql`now() + make_interval(hours => ${overlapHours})` : null,
      previousLastUsedAt: overlapHours > 0 ? existing.tokenLastUsedAt : null,
      rotatedAt: sql`now()`,
      expiresAt: sql`now() + make_interval(hours => ${EXPIRY_HOURS})`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(schema.integrations.id, existing.id), isNull(schema.integrations.revokedAt)))
    .returning();
  if (!row) throw conflict('This integration is revoked. Connect a new one instead.');
  await recordAudit(actor, 'integration.rotate', 'integration', row.id, { overlapHours });
  return dtoFor(row, token);
}

/** End a rotation's overlap now: the previous token stops resolving on the next call. */
export async function revokePreviousToken(
  actor: Actor,
  integrationId: string,
): Promise<IntegrationDto> {
  assertHumanDecision(actor, DESTROY_REFUSAL);
  const existing = await ownIntegration(actor, integrationId);
  const [row] = await getDb()
    .update(schema.integrations)
    .set({
      previousHash: null,
      previousExpiresAt: null,
      previousLastUsedAt: null,
      updatedAt: sql`now()`,
    })
    .where(eq(schema.integrations.id, existing.id))
    .returning();
  if (!row) throw notFound(NOT_FOUND);
  await recordAudit(actor, 'integration.revoke_previous', 'integration', row.id, {});
  return dtoFor(row);
}

/**
 * Revoke for good. Terminal (a trigger refuses clearing it), and every live
 * enrolment goes in the same transaction with `integration_revoked`, so the
 * credential reaches nothing even through a row a later bug left behind.
 */
export async function revokeIntegration(
  actor: Actor,
  integrationId: string,
): Promise<IntegrationDto> {
  assertHumanDecision(actor, DESTROY_REFUSAL);
  const existing = await ownIntegration(actor, integrationId);
  if (existing.revokedAt) return dtoFor(existing);
  const row = await getDb().transaction(async (tx) => {
    const [revoked] = await tx
      .update(schema.integrations)
      .set({ revokedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(schema.integrations.id, existing.id), isNull(schema.integrations.revokedAt)))
      .returning();
    await tx
      .update(schema.integrationRadars)
      .set({ revokedAt: sql`now()`, revokedReason: 'integration_revoked' })
      .where(
        and(
          eq(schema.integrationRadars.integrationId, existing.id),
          isNull(schema.integrationRadars.revokedAt),
        ),
      );
    return revoked ?? existing;
  });
  await recordAudit(actor, 'integration.revoke', 'integration', row.id, {});
  return dtoFor(row);
}

/**
 * Connect a helpdesk radar to an integration: the one act that widens what the
 * credential reaches, so a person's (`docs/HELPDESK.md` §3.2).
 *
 * The radar must be the caller's own (`radar.owner_id`, not any holder of the
 * owner role: the credential acts as its owner and nobody else) and on a
 * client-facing template. A revoked enrolment is never revived; enrolling
 * again writes a new row.
 */
export async function enrolRadar(
  actor: Actor,
  integrationId: string,
  input: EnrolRadarInput,
): Promise<IntegrationDto> {
  assertHumanDecision(actor, ENROL_REFUSAL);
  const integration = await ownIntegration(actor, integrationId);
  if (integration.revokedAt) {
    throw conflict('This integration is revoked. Connect a new one instead.');
  }
  const access = await requireRadar(input.radarId, actor, 'manage');
  if (access.radar.ownerId !== actor.user.id) {
    throw badRequest('Only a radar you own can be connected to your client portal.');
  }
  if (access.radar.kind !== 'standard' || !isClientFacingTemplate(access.radar.template)) {
    throw badRequest('Only a Helpdesk radar can be connected to a client portal.');
  }
  try {
    const [row] = await getDb()
      .insert(schema.integrationRadars)
      .values({
        integrationId: integration.id,
        radarId: access.radar.id,
        externalRef: input.externalRef ?? null,
        enrolledBy: actor.user.id,
      })
      .returning();
    if (!row) throw new Error('enrolment insert returned no row');
    await recordAudit(actor, 'integration.enrol', 'radar', access.radar.id, {
      integrationId: integration.id,
      ...(row.externalRef ? { externalRef: row.externalRef } : {}),
    });
  } catch (err) {
    if (isUniqueViolation(err, 'integration_radars_live_key'))
      throw conflict(`"${access.radar.name}" is already connected to ${integration.name}.`);
    if (isUniqueViolation(err, 'integration_radars_live_ref_key'))
      throw conflict(
        `Another helpdesk is already connected to ${integration.name} as "${input.externalRef ?? ''}".`,
      );
    throw err;
  }
  return dtoFor(integration);
}

/**
 * Disconnect a radar. The safe direction, so an agent may do it too. Terminal
 * for that enrolment: connecting it again is a person's new decision.
 */
export async function unenrolRadar(
  actor: Actor,
  integrationId: string,
  radarId: string,
): Promise<IntegrationDto> {
  await requireScope(actor, 'write', 'disconnect a helpdesk from a client portal');
  const integration = await ownIntegration(actor, integrationId);
  const revoked = await getDb()
    .update(schema.integrationRadars)
    .set({ revokedAt: sql`now()`, revokedReason: 'unenrolled' })
    .where(
      and(
        eq(schema.integrationRadars.integrationId, integration.id),
        eq(schema.integrationRadars.radarId, radarId),
        isNull(schema.integrationRadars.revokedAt),
      ),
    )
    .returning({ id: schema.integrationRadars.id });
  if (revoked.length === 0) throw notFound('That radar is not connected to this integration.');
  await recordAudit(actor, 'integration.unenrol', 'radar', radarId, {
    integrationId: integration.id,
  });
  return dtoFor(integration);
}
