import { blipEmails, attachments } from '../db/schema.js';
import { EMAIL_FAILURE_MESSAGES, type EmailFailureReason } from './email-failures.js';
import { getRadarAccess, orgAllows } from './access.js';
import { ensureDropBox } from './radars.js';
import { z } from 'zod';
import { LIMITS } from '@onmyradar/contract';
import { EMAIL_LIMITS, EMAIL_MAX_STORED_FILES } from './email-limits.js';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, inArray, or, sql } from 'drizzle-orm';
import {
  updateEmailCaptureIdentitySchema,
  updateRadarEmailCaptureSchema,
  type EmailCaptureIdentityDto,
  type RadarEmailCaptureDto,
} from '@onmyradar/contract';
import { env } from '../env.js';
import { getDb, type Db } from '../db/client.js';
import {
  emailCaptureIdentities,
  radarEmailCapture,
  emailCaptureReceipts,
  radars,
  users,
} from '../db/schema.js';
import { ApiError, badRequest, type Actor } from '../http.js';
import { enqueue } from './outbox.js';
import { createBlip } from './blips.js';
import { assertUploadable, safeFilename, headObject, buildObjectPrefix } from './storage.js';
import { assertHumanDecision, requireRadar } from './access.js';

export function emailCaptureAvailable(): boolean {
  return Boolean(
    env().EMAIL_CAPTURE_ENABLED && env().EMAIL_INGEST_SECRET && env().EMAIL_CAPTURE_DOMAIN,
  );
}
function domain(): string {
  return env().EMAIL_CAPTURE_DOMAIN ?? '';
}
export async function getEmailCaptureIdentity(actor: Actor): Promise<EmailCaptureIdentityDto> {
  assertHumanDecision(actor, 'Email capture settings belong to the account owner.');
  const [row] = await getDb()
    .select()
    .from(emailCaptureIdentities)
    .where(eq(emailCaptureIdentities.userId, actor.user.id));
  return {
    available: emailCaptureAvailable(),
    username: row?.username ?? null,
    address: row && domain() ? `${row.username}@${domain()}` : null,
  };
}
export async function claimEmailCaptureIdentity(
  actor: Actor,
  username: string,
): Promise<EmailCaptureIdentityDto> {
  assertHumanDecision(actor, 'Email capture settings belong to the account owner.');
  username = updateEmailCaptureIdentitySchema.parse({ username }).username;
  const existing = await getEmailCaptureIdentity(actor);
  if (existing.username && existing.username !== username)
    throw badRequest('Your email capture username is permanent.');
  await getDb().transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, actor.user.id)).for('update');
    const inserted = await tx
      .insert(emailCaptureIdentities)
      .values({ userId: actor.user.id, username })
      .onConflictDoNothing()
      .returning({ username: emailCaptureIdentities.username });
    if (!inserted.length) return;
    const dropBox = await ensureDropBox(actor, tx);
    await tx
      .insert(radarEmailCapture)
      .values({
        radarId: dropBox.id,
        ownerId: actor.user.id,
        alias: `inbox-${randomUUID().slice(0, 8)}`,
        enabled: true,
        allowedSenders: [],
      })
      .onConflictDoUpdate({
        target: radarEmailCapture.radarId,
        set: { enabled: true, allowedSenders: [] },
      });
  });
  const current = await getEmailCaptureIdentity(actor);
  if (current.username !== username)
    throw new ApiError(409, 'username_unavailable', 'Choose a different email capture username.');
  return current;
}
export async function getRadarEmailCapture(
  actor: Actor,
  radarId: string,
): Promise<RadarEmailCaptureDto> {
  assertHumanDecision(actor, 'Email capture settings belong to the radar owner.');
  const access = await requireRadar(radarId, actor, 'manage');
  if (access.radar.ownerId !== actor.user.id)
    throw new ApiError(403, 'owner_required', 'Only the radar owner can configure email capture.');
  const identity = await getEmailCaptureIdentity(actor);
  const [row] = await getDb()
    .select()
    .from(radarEmailCapture)
    .where(eq(radarEmailCapture.radarId, access.radar.id));
  return {
    available: emailCaptureAvailable(),
    identityConfigured: Boolean(identity.username),
    enabled: row?.enabled ?? false,
    address:
      domain() && identity.username && (row || access.radar.isDropBox)
        ? `${identity.username}${access.radar.isDropBox || !row ? '' : `+${row.alias}`}@${domain()}`
        : null,
    allowedSenders: [...new Set([actor.user.email.toLowerCase(), ...(row?.allowedSenders ?? [])])],
    lastReceivedAt: row?.lastReceivedAt?.toISOString() ?? null,
    lastError: row?.lastError ?? null,
  };
}
export async function updateRadarEmailCapture(
  actor: Actor,
  radarId: string,
  input: { enabled: boolean; allowedSenders: string[] },
): Promise<RadarEmailCaptureDto> {
  assertHumanDecision(actor, 'Email capture settings belong to the radar owner.');
  const access = await requireRadar(radarId, actor, 'manage');
  if (access.radar.ownerId !== actor.user.id)
    throw new ApiError(403, 'owner_required', 'Only the radar owner can configure email capture.');
  if (access.radar.kind === 'smart') throw badRequest('Smart radars cannot receive email.');
  const identity = await getEmailCaptureIdentity(actor);
  if (input.enabled && !identity.username)
    throw badRequest('Choose your email capture username in account settings first.');
  input = updateRadarEmailCaptureSchema.parse(input);
  const base =
    access.radar.slug
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 31)
      .replace(/-$/, '') || 'radar';
  for (let attempt = 0; attempt < 3; attempt++) {
    const alias = attempt === 0 ? base : `${base.slice(0, 24)}-${randomUUID().slice(0, 6)}`;
    await getDb()
      .insert(radarEmailCapture)
      .values({ radarId: access.radar.id, ownerId: actor.user.id, alias, ...input })
      .onConflictDoNothing();
    const changed = await getDb()
      .update(radarEmailCapture)
      .set(input)
      .where(eq(radarEmailCapture.radarId, access.radar.id))
      .returning({ id: radarEmailCapture.radarId });
    if (changed.length) break;
    if (attempt === 2)
      throw new ApiError(
        409,
        'email_alias_unavailable',
        'Please try creating this capture address again.',
      );
  }
  return getRadarEmailCapture(actor, access.radar.id);
}

// The raw email ingress calls this seam after isolated DKIM verification.
// Sender-provided authentication headers never constitute a verdict.
export const emailDeliveryIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const emailDeliverySchema = z
  .object({
    id: emailDeliveryIdSchema,
    recipient: z.string().trim().toLowerCase().email().max(254),
    sender: z.string().trim().toLowerCase().email().max(254),
    body: z.string().min(1).max(LIMITS.blipBody),
    email: z
      .object({
        subject: z.string().max(2000).nullable(),
        senderName: z.string().max(500).nullable(),
        sentAt: z.string().datetime().nullable(),
        preview: z.string().max(220),
        hasHtml: z.boolean(),
        attachmentCount: z.number().int().min(0).max(EMAIL_LIMITS.attachments),
      })
      .strict()
      .optional(),
    files: z
      .array(
        z
          .object({
            filename: z.string().min(1).max(255),
            contentType: z.string().min(1).max(255),
            size: z.number().int().nonnegative().max(LIMITS.attachmentBytes),
          })
          .strict(),
      )
      .max(EMAIL_MAX_STORED_FILES),
  })
  .strict();
export type EmailDelivery = z.infer<typeof emailDeliverySchema>;
export async function authorizeEmailDelivery(input: EmailDelivery) {
  assertEmailAvailable();
  input = emailDeliverySchema.parse(input);
  const db = getDb();
  const [local, host, ...extra] = input.recipient.toLowerCase().split('@');
  if (host !== domain() || extra.length || !local)
    throw badRequest('Email capture address is unavailable.');
  const [username = '', alias, ...more] = local.split('+');
  if (more.length) throw badRequest('Email capture address is unavailable.');
  const [target] = await db
    .select({ radar: radars, owner: users, settings: radarEmailCapture })
    .from(emailCaptureIdentities)
    .innerJoin(users, eq(users.id, emailCaptureIdentities.userId))
    .innerJoin(radars, eq(radars.ownerId, users.id))
    .innerJoin(radarEmailCapture, eq(radarEmailCapture.radarId, radars.id))
    .where(
      and(
        eq(emailCaptureIdentities.username, username),
        alias ? eq(radarEmailCapture.alias, alias) : eq(radars.isDropBox, true),
        eq(radarEmailCapture.enabled, true),
        eq(users.state, 'active'),
        sql`omr_account_open(${users.id})`,
        eq(radars.archived, false),
        eq(radars.kind, 'standard'),
        // Delivered into the owner's radar only while the owner can still reach it.
        orgAllows(radars.organizationId, users.id, 'owner'),
      ),
    )
    .limit(1);
  if (!target) throw badRequest('Email capture address is unavailable.');
  if (
    ![target.owner.email.toLowerCase(), ...target.settings.allowedSenders].includes(input.sender)
  ) {
    await db
      .update(radarEmailCapture)
      .set({ lastError: 'A message was refused because its sender is not approved.' })
      .where(eq(radarEmailCapture.radarId, target.radar.id));
    throw new ApiError(
      403,
      'sender_not_approved',
      'This sender is not approved for email capture.',
    );
  }
  const objectPrefix = `${buildObjectPrefix(target.radar.id)}/${input.id}`;
  const files = input.files.map((file, index) => {
    assertUploadable(file.contentType, file.size);
    return {
      ...file,
      filename: safeFilename(file.filename),
      key: `${objectPrefix}/${index}-${safeFilename(file.filename)}`,
    };
  });
  await db.transaction(async (tx) => {
    await lockEmailAuthorization(tx, target.owner.id, target.radar.id, input.sender);
    const inserted = await tx
      .insert(emailCaptureReceipts)
      .values({
        id: input.id,
        radarId: target.radar.id,
        sender: input.sender,
        body: input.body,
        files,
        email: input.email
          ? {
              ...input.email,
              payloadKey: `${objectPrefix}/email-content.json`,
              originalKey: `${objectPrefix}/original.eml`,
            }
          : null,
      })
      .onConflictDoNothing()
      .returning({ id: emailCaptureReceipts.id });
    if (!inserted.length) return;
    const charged = await tx
      .update(radarEmailCapture)
      .set({
        windowStartedAt: sql`CASE WHEN window_started_at < now() - interval '1 day' THEN now() ELSE window_started_at END`,
        windowCount: sql`CASE WHEN window_started_at < now() - interval '1 day' THEN 1 ELSE window_count + 1 END`,
      })
      .where(
        and(
          eq(radarEmailCapture.radarId, target.radar.id),
          sql`(window_started_at < now() - interval '1 day' OR window_count < 100)`,
        ),
      )
      .returning({ id: radarEmailCapture.radarId });
    if (!charged.length)
      throw new ApiError(
        429,
        'email_capture_rate_limit',
        'This radar has reached its daily email limit.',
      );
  });
  const [receipt] = await db
    .select()
    .from(emailCaptureReceipts)
    .where(eq(emailCaptureReceipts.id, input.id));
  if (!receipt || receipt.radarId !== target.radar.id || receipt.sender !== input.sender)
    throw badRequest('Delivery identity does not match.');
  if (!receipt.completedAt && Date.now() - receipt.createdAt.getTime() > 86400000)
    throw badRequest('This upload authorization expired. Send the email again.');
  return {
    id: receipt.id,
    completed: receipt.completedAt !== null,
    files: receipt.files,
    email: receipt.email,
  };
}
class AlreadyCaptured extends Error {}
export async function finalizeEmailDelivery(id: string, signal?: AbortSignal) {
  assertEmailAvailable();
  id = emailDeliveryIdSchema.parse(id);
  const db = getDb();
  const [receipt] = await db
    .select()
    .from(emailCaptureReceipts)
    .where(eq(emailCaptureReceipts.id, id));
  if (!receipt) throw badRequest('Email delivery was not authorized.');
  if (receipt.completedAt) return { captured: true };
  if (Date.now() - receipt.createdAt.getTime() > 86400000)
    throw badRequest('This upload authorization expired. Send the email again.');
  const [target] = await db
    .select({ radar: radars, owner: users, settings: radarEmailCapture })
    .from(radars)
    .innerJoin(users, eq(users.id, radars.ownerId))
    .innerJoin(radarEmailCapture, eq(radarEmailCapture.radarId, radars.id))
    .where(eq(radars.id, receipt.radarId));
  if (
    !target ||
    !target.settings.enabled ||
    target.owner.state !== 'active' ||
    target.radar.archived ||
    ![target.owner.email.toLowerCase(), ...target.settings.allowedSenders].includes(receipt.sender)
  )
    throw badRequest('Email capture is no longer authorized.');
  if (receipt.email) {
    for (const key of [receipt.email.payloadKey, receipt.email.originalKey]) {
      if (!(await headObject(key, signal)))
        throw badRequest('Email content upload was not completed.');
    }
  }
  const actor: Actor = { kind: 'webhook', user: target.owner };
  try {
    await createBlip(
      actor,
      receipt.radarId,
      {
        body: receipt.body,
        attachments: receipt.files,
        ...(receipt.email?.subject
          ? { title: receipt.email.subject.slice(0, LIMITS.blipTitle) }
          : {}),
      },
      {
        signal,
        beforeInsert: async (tx) => {
          signal?.throwIfAborted();
          await lockEmailAuthorization(tx, target.owner.id, receipt.radarId, receipt.sender);
          const claimed = await tx
            .update(emailCaptureReceipts)
            .set({ completedAt: new Date() })
            .where(and(eq(emailCaptureReceipts.id, id), isNull(emailCaptureReceipts.completedAt)))
            .returning({ id: emailCaptureReceipts.id });
          if (!claimed.length) {
            const [existing] = await tx
              .select({ completed: emailCaptureReceipts.completedAt })
              .from(emailCaptureReceipts)
              .where(eq(emailCaptureReceipts.id, id));
            if (existing?.completed) throw new AlreadyCaptured();
            throw badRequest('This email upload authorization expired.');
          }
        },
        afterInsert: async (tx, blipId) => {
          if (receipt.email)
            await tx.insert(blipEmails).values({
              ...receipt.email,
              sentAt: receipt.email.sentAt ? new Date(receipt.email.sentAt) : null,
              blipId,
              senderAddress: receipt.sender,
              receivedAt: receipt.createdAt,
            });
          else
            await tx.insert(blipEmails).values({
              blipId,
              senderAddress: receipt.sender,
              receivedAt: receipt.createdAt,
              preview: receipt.body.replace(/\s+/g, ' ').slice(0, 220),
              legacy: true,
              attachmentCount: receipt.files.length,
            });
          await tx
            .update(emailCaptureReceipts)
            .set({ blipId, body: '', files: [], email: null })
            .where(eq(emailCaptureReceipts.id, id));
          await tx
            .update(radarEmailCapture)
            .set({ lastReceivedAt: new Date(), lastError: null })
            .where(eq(radarEmailCapture.radarId, receipt.radarId));
        },
        deferDelivery: true,
      },
    );
  } catch (error) {
    if (!(error instanceof AlreadyCaptured)) throw error;
  }
  return { captured: true };
}

/** Abandoned uploads are retired in the same transaction that queues deletion. */
export async function cleanupEmailReceipts(): Promise<number> {
  return getDb().transaction(async (tx) => {
    const expired = await tx
      .select({
        id: emailCaptureReceipts.id,
        completedAt: emailCaptureReceipts.completedAt,
        files: emailCaptureReceipts.files,
        email: emailCaptureReceipts.email,
      })
      .from(emailCaptureReceipts)
      .where(
        sql`(${emailCaptureReceipts.completedAt} IS NULL AND ${emailCaptureReceipts.createdAt} < now() - interval '1 day') OR (${emailCaptureReceipts.completedAt} < now() - interval '90 days')`,
      )
      .limit(500)
      .for('update', { skipLocked: true });
    if (!expired.length) return 0;
    const keys = expired
      .filter((row) => !row.completedAt)
      .flatMap((row) => [
        ...row.files.map((file) => file.key),
        ...(row.email ? [row.email.payloadKey, row.email.originalKey] : []),
      ]);
    if (keys.length) await enqueue(tx, 'object-cleanup', { keys });
    await tx.delete(emailCaptureReceipts).where(
      inArray(
        emailCaptureReceipts.id,
        expired.map((row) => row.id),
      ),
    );
    return expired.length;
  });
}

function assertEmailAvailable(): void {
  if (!emailCaptureAvailable())
    throw new ApiError(503, 'email_unavailable', 'Email capture is not available.');
}
// Consistent aggregate lock order closes revocation during object HEAD checks.
async function lockEmailAuthorization(
  tx: Pick<Db, 'select' | 'selectDistinct'>,
  ownerId: string,
  radarId: string,
  sender: string,
) {
  const [owner] = await tx.select().from(users).where(eq(users.id, ownerId)).for('update');
  const [radar] = await tx.select().from(radars).where(eq(radars.id, radarId)).for('update');
  const [settings] = await tx
    .select()
    .from(radarEmailCapture)
    .where(eq(radarEmailCapture.radarId, radarId))
    .for('update');
  // The same question the lookup answers for anybody: may the owner write to this radar now?
  const reach = owner ? await getRadarAccess(radarId, { user: owner, kind: 'user' }, tx) : null;
  if (
    !owner ||
    owner.state !== 'active' ||
    !radar ||
    radar.ownerId !== ownerId ||
    !reach?.canWrite ||
    radar.archived ||
    radar.kind !== 'standard' ||
    !settings?.enabled ||
    ![owner.email.toLowerCase(), ...settings.allowedSenders].includes(sender)
  )
    throw badRequest('Email capture is no longer authorized.');
}

/** Fixed diagnostic from the authenticated receiver, never attacker mail text. */
export async function recordEmailAuthenticationFailure(
  recipient: string,
  reason: EmailFailureReason = 'dkim_invalid',
): Promise<void> {
  assertEmailAvailable();
  const address = z.string().trim().toLowerCase().email().max(254).parse(recipient);
  const [local = '', host] = address.split('@');
  if (host !== domain()) return;
  const [username = '', alias, ...extra] = local.split('+');
  if (extra.length) return;
  const [target] = await getDb()
    .select({ id: radars.id })
    .from(emailCaptureIdentities)
    .innerJoin(radars, eq(radars.ownerId, emailCaptureIdentities.userId))
    .innerJoin(radarEmailCapture, eq(radarEmailCapture.radarId, radars.id))
    .where(
      and(
        eq(emailCaptureIdentities.username, username),
        eq(radarEmailCapture.enabled, true),
        alias ? eq(radarEmailCapture.alias, alias) : eq(radars.isDropBox, true),
      ),
    )
    .limit(1);
  if (target)
    await getDb()
      .update(radarEmailCapture)
      .set({
        lastError: EMAIL_FAILURE_MESSAGES[reason],
      })
      .where(eq(radarEmailCapture.radarId, target.id));
}

/** A radar may disappear while an already authorized PUT is in flight. Its
 * deletion job can run before that PUT finishes, so enqueue a second cleanup
 * after the upload settles. A deleted UUID can never acquire new attachments. */
export async function cleanupDeletedRadarEmailUploads(
  keys: string[],
  receiptId?: string,
): Promise<void> {
  const [first] = keys;
  if (first === undefined) return;
  // An unscoped first key leaves radarId empty, and the check below then
  // refuses every key rather than trusting any of them.
  const radarId = first.split('/')[1] ?? '';
  if (keys.some((key) => !key.startsWith(`radars/${radarId}/`)))
    throw new Error('Mixed email upload scopes');
  const [radar] = await getDb()
    .select({ id: radars.id })
    .from(radars)
    .where(eq(radars.id, radarId));
  const owned = new Set<string>();
  if (receiptId) {
    const [receipt] = await getDb()
      .select({
        completedAt: emailCaptureReceipts.completedAt,
        blipId: emailCaptureReceipts.blipId,
        radarId: emailCaptureReceipts.radarId,
        files: emailCaptureReceipts.files,
        email: emailCaptureReceipts.email,
      })
      .from(emailCaptureReceipts)
      .where(eq(emailCaptureReceipts.id, receiptId));
    if (receipt?.radarId === radarId) {
      for (const file of receipt.files) owned.add(file.key);
      if (receipt.email) {
        owned.add(receipt.email.payloadKey);
        owned.add(receipt.email.originalKey);
      }
    }
    if (receipt?.completedAt && receipt.blipId) {
      const [files, emails] = await Promise.all([
        getDb()
          .select({ key: attachments.objectKey })
          .from(attachments)
          .where(eq(attachments.blipId, receipt.blipId)),
        getDb()
          .select({ payloadKey: blipEmails.payloadKey, originalKey: blipEmails.originalKey })
          .from(blipEmails)
          .where(eq(blipEmails.blipId, receipt.blipId)),
      ]);
      for (const file of files) owned.add(file.key);
      for (const email of emails) {
        if (email.payloadKey) owned.add(email.payloadKey);
        if (email.originalKey) owned.add(email.originalKey);
      }
    }
  }
  let obsoleteKeys = receiptId || !radar ? keys.filter((key) => !owned.has(key)) : [];
  if (obsoleteKeys.length) {
    // A moved blip can outlive its source radar and receipt. Even a replacement
    // pending receipt must not hide a live object's ownership by an older blip.
    const [files, emails] = await Promise.all([
      getDb()
        .select({ key: attachments.objectKey })
        .from(attachments)
        .where(inArray(attachments.objectKey, obsoleteKeys)),
      getDb()
        .select({ payloadKey: blipEmails.payloadKey, originalKey: blipEmails.originalKey })
        .from(blipEmails)
        .where(
          or(
            inArray(blipEmails.payloadKey, obsoleteKeys),
            inArray(blipEmails.originalKey, obsoleteKeys),
          ),
        ),
    ]);
    for (const file of files) owned.add(file.key);
    for (const email of emails) {
      if (email.payloadKey) owned.add(email.payloadKey);
      if (email.originalKey) owned.add(email.originalKey);
    }
    obsoleteKeys = obsoleteKeys.filter((key) => !owned.has(key));
  }
  // Replacement receipts use random generation directories; candidate obsolete
  // keys cannot be acquired by a later replacement after this ownership check.
  if (obsoleteKeys.length) await enqueue(getDb(), 'object-cleanup', { keys: obsoleteKeys });
}
