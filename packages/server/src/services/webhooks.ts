/**
 * Radar webhooks — the application's only unauthenticated ingress.
 *
 * ## The actor model
 *
 * A delivery does not get its own permissions. It is authorized as the person
 * who created the webhook, through `createBlip` → `requireRadar`, exactly like a
 * browser or an agent. Three consequences fall out of that rather than having to
 * be written down as separate rules:
 *
 *   * if the creator's write access to the radar is revoked, the webhook stops
 *     working — there is no second code path that could keep honouring it;
 *   * if the creator is suspended, the webhook stops working, which is what
 *     "suspension revokes everything immediately" has to mean;
 *   * blips arrive authored by a real person, so the stream is not full of rows
 *     with a null author.
 *
 * The actor is tagged `kind: 'webhook'` so the audit log records which of the
 * three it was instead of flattening them together.
 *
 * ## The secret
 *
 * The token is high-entropy random and stored as an HMAC keyed by
 * SESSION_SECRET, the same way a personal access token is. The full ingest URL
 * exists in plaintext exactly once, in the create/rotate response.
 *
 * ## Rate limiting
 *
 * A fixed window kept on the webhook row, rolled and counted by a single atomic
 * `UPDATE ... RETURNING`. There is no gap between checking and incrementing, and
 * no second table to sweep. It only applies to deliveries that presented a valid
 * token: a bad token is one indexed miss and has no row to charge. Absorbing a
 * flood of *invalid* requests is the edge's job, not this table's.
 */
import { and, eq, sql } from 'drizzle-orm';
import {
  humanizeFieldName,
  normalizeTags,
  renderPayloadTemplate,
  stringifyPayloadValue,
  WEBHOOK,
  type CreateWebhookInput,
  type UpdateWebhookInput,
  type WebhookDto,
} from '@onmyradar/contract';
import { hashSecret, randomToken } from '../auth/crypto.js';
import { getDb, schema } from '../db/client.js';
import { env } from '../env.js';
import { ApiError, badRequest, notFound, tooManyRequests, type Actor } from '../http.js';
import { errorMessage } from '../errors.js';
import { logger } from '../logger.js';
import { requireRadar } from './access.js';
import { recordAudit } from './audit.js';
import { createBlip } from './blips.js';

type WebhookRow = typeof schema.radarWebhooks.$inferSelect;
type UserRow = typeof schema.users.$inferSelect;

/* --------------------------------- secrets -------------------------------- */

function newWebhookToken(): string {
  return `${WEBHOOK.tokenPrefix}${randomToken()}`;
}

/** Ingest path. The token is a path segment so a sender that only accepts a URL still works. */
function ingestPath(webhookId: string, token?: string): string {
  return token ? `/hooks/${webhookId}/${token}` : `/hooks/${webhookId}`;
}

export function ingestUrl(webhookId: string, token?: string): string {
  return `${env().PUBLIC_URL}${ingestPath(webhookId, token)}`;
}

/* ----------------------------------- DTO ---------------------------------- */

function toDto(row: WebhookRow, secret?: string): WebhookDto {
  return {
    id: row.id,
    radarId: row.radarId,
    name: row.name,
    enabled: row.enabled,
    format: row.format,
    bodyTemplate: row.bodyTemplate,
    titleTemplate: row.titleTemplate,
    tags: row.tags,
    state: row.state,
    url: ingestUrl(row.id),
    lastDeliveryAt: row.lastDeliveryAt?.toISOString() ?? null,
    lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
    lastError: row.lastError,
    deliveryCount: row.deliveryCount,
    createdAt: row.createdAt.toISOString(),
    ...(secret ? { secretUrl: ingestUrl(row.id, secret) } : {}),
  };
}

/* -------------------------------- management ------------------------------ */

export async function listWebhooks(actor: Actor, radarId: string): Promise<WebhookDto[]> {
  // Managing an ingress into somebody's radar is an owner-level act, and the
  // list itself names the deliveries — so it is gated the same way.
  const access = await requireRadar(radarId, actor, 'manage');
  const rows = await getDb()
    .select()
    .from(schema.radarWebhooks)
    .where(eq(schema.radarWebhooks.radarId, access.radar.id))
    .orderBy(schema.radarWebhooks.createdAt);
  return rows.map((row) => toDto(row));
}

export async function createWebhook(
  actor: Actor,
  radarId: string,
  input: CreateWebhookInput,
): Promise<WebhookDto> {
  const access = await requireRadar(radarId, actor, 'manage');
  if (access.radar.kind === 'smart') {
    throw badRequest('A smart radar holds no blips, so there is nowhere for a delivery to land.');
  }
  // The drop box takes no webhook, and this is a **holding** refusal rather than
  // a settled one — the only refusal in this file that expects to be lifted.
  //
  // A webhook is an unauthenticated write path into a radar, minted by its
  // owner, addressed by an unguessable URL. Pointed at the drop box that is
  // precisely the "let people drop things into someone's inbox" feature, built
  // by accident and missing every part of it that needs designing: nothing marks
  // an arrival as having come from outside, so a stranger's delivery lands in
  // the unsorted pile the owner and their agent read as their own; the blip is
  // authored by the *owner* under the webhook actor model, which is honest for a
  // form you wired up yourself and a lie for something a stranger sent; and
  // there is no quarantine, so the only remedy for abuse is deleting the
  // delivered blips one at a time.
  //
  // It matters most over MCP. An agent holds manage on the drop box the moment
  // it is connected as its owner, so without this it could mint an ingest URL
  // into somebody's private inbox and be handed the secret in the response —
  // which is an agent widening access, the one thing the tool surface refuses
  // everywhere else. See MCP.md.
  if (access.radar.isDropBox) {
    throw badRequest(
      'The drop box does not take webhooks yet. An ingest URL is an unauthenticated way in, ' +
        'and letting things arrive in your private inbox from outside needs to say who sent ' +
        'them and hold them apart until you have looked — neither of which exists yet. Point ' +
        'the webhook at a radar of its own and file from there.',
    );
  }
  if ((input.format ?? 'auto') === 'template' && !input.bodyTemplate?.trim()) {
    throw badRequest('A template webhook needs a body template');
  }

  const token = newWebhookToken();
  const [row] = await getDb()
    .insert(schema.radarWebhooks)
    .values({
      radarId: access.radar.id,
      createdBy: actor.user.id,
      name: input.name,
      tokenHash: hashSecret(token),
      tokenPrefix: token.slice(0, WEBHOOK.tokenPrefix.length + 6),
      format: input.format ?? 'auto',
      bodyTemplate: input.bodyTemplate ?? null,
      titleTemplate: input.titleTemplate ?? null,
      tags: normalizeTags(input.tags ?? []),
      state: input.state ?? 'inbox',
      enabled: input.enabled ?? true,
    })
    .returning();
  if (!row) throw new Error('webhook insert returned no row');

  await recordAudit(actor, 'webhook.create', 'webhook', row.id, {
    radarId: access.radar.id,
    name: row.name,
  });
  return toDto(row, token);
}

async function ownWebhook(actor: Actor, webhookId: string): Promise<WebhookRow> {
  const rows = await getDb()
    .select()
    .from(schema.radarWebhooks)
    .where(eq(schema.radarWebhooks.id, webhookId))
    .limit(1);
  const row = rows[0];
  // Reported as missing rather than forbidden, for the same reason a radar is:
  // a 403 would confirm the id exists.
  if (!row) throw notFound('Webhook not found');
  await requireRadar(row.radarId, actor, 'manage');
  return row;
}

export async function updateWebhook(
  actor: Actor,
  webhookId: string,
  input: UpdateWebhookInput,
): Promise<WebhookDto> {
  const existing = await ownWebhook(actor, webhookId);
  const format = input.format ?? existing.format;
  const bodyTemplate =
    input.bodyTemplate !== undefined ? input.bodyTemplate : existing.bodyTemplate;
  if (format === 'template' && !bodyTemplate?.trim()) {
    throw badRequest('A template webhook needs a body template');
  }

  const [row] = await getDb()
    .update(schema.radarWebhooks)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.format !== undefined ? { format: input.format } : {}),
      ...(input.bodyTemplate !== undefined ? { bodyTemplate: input.bodyTemplate } : {}),
      ...(input.titleTemplate !== undefined ? { titleTemplate: input.titleTemplate } : {}),
      ...(input.tags !== undefined ? { tags: normalizeTags(input.tags) } : {}),
      ...(input.state !== undefined ? { state: input.state } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.radarWebhooks.id, existing.id))
    .returning();
  if (!row) throw notFound('Webhook not found');

  await recordAudit(actor, 'webhook.update', 'webhook', row.id, { fields: Object.keys(input) });
  return toDto(row);
}

/** Invalidates the URL already handed to a sender and issues a new one. */
export async function rotateWebhookSecret(actor: Actor, webhookId: string): Promise<WebhookDto> {
  const existing = await ownWebhook(actor, webhookId);
  const token = newWebhookToken();
  const [row] = await getDb()
    .update(schema.radarWebhooks)
    .set({
      tokenHash: hashSecret(token),
      tokenPrefix: token.slice(0, WEBHOOK.tokenPrefix.length + 6),
      updatedAt: new Date(),
    })
    .where(eq(schema.radarWebhooks.id, existing.id))
    .returning();
  if (!row) throw notFound('Webhook not found');
  await recordAudit(actor, 'webhook.rotate', 'webhook', row.id, {});
  return toDto(row, token);
}

export async function deleteWebhook(actor: Actor, webhookId: string): Promise<void> {
  const existing = await ownWebhook(actor, webhookId);
  await getDb().delete(schema.radarWebhooks).where(eq(schema.radarWebhooks.id, existing.id));
  await recordAudit(actor, 'webhook.delete', 'webhook', existing.id, {
    radarId: existing.radarId,
  });
}

/* --------------------------------- ingest --------------------------------- */

export interface InboundDelivery {
  /** Already parsed by the route, which owns the content-type handling. */
  payload: unknown;
  /** True when the payload came from a form post or plain text rather than JSON. */
  shape: 'json' | 'form' | 'text';
  raw: string;
}

export interface DeliveryResult {
  blipId: string;
  radarId: string;
}

/**
 * Fields a sender is likely to have called "the message". Ordered: the first one
 * that holds a non-empty string wins.
 */
const BODY_FIELDS = ['body', 'text', 'message', 'content', 'description', 'note', 'summary'];
const TITLE_FIELDS = ['title', 'subject', 'name', 'event', 'headline'];
const URL_FIELDS = ['url', 'link', 'permalink', 'html_url'];

/** Returns the value *and* the key it came from, so the caller can avoid printing it twice. */
function readString(
  payload: Record<string, unknown>,
  keys: string[],
): { value: string; key: string } | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return { value: value.trim(), key };
  }
  return null;
}

/**
 * Renders every field as a labelled markdown line.
 *
 * This is the case a form-submission webhook actually hits: there is no single
 * "message" field, there are eleven fields and all of them matter. Turning them
 * into `**Email:** someone@example.com` lines keeps the blip readable and keeps
 * the values searchable, which a raw JSON dump would not.
 */
function renderFields(payload: Record<string, unknown>, skip: Set<string> = new Set()): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    // A field already lifted into the title, the link or the tags must not also
    // appear as a line — that prints the same words twice, which is the exact
    // mistake title derivation made before it was restricted to real headings.
    if (skip.has(key)) continue;
    const rendered = stringifyPayloadValue(value);
    if (!rendered.trim()) continue;
    lines.push(
      rendered.includes('\n')
        ? `**${humanizeFieldName(key)}:**\n\n${rendered}`
        : `**${humanizeFieldName(key)}:** ${rendered}`,
    );
  }
  return lines.join('\n\n');
}

interface MappedBlip {
  body: string;
  title: string | null;
  url: string | null;
  tags: string[];
}

/** Payload → blip. Pure, so it can be unit-tested without a database. */
export function mapPayload(webhook: WebhookRow, delivery: InboundDelivery): MappedBlip {
  const { payload, shape, raw } = delivery;
  const record =
    payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;

  let body: string;
  let title: string | null = null;
  let url: string | null = null;
  let tags: string[] = [];

  // Metadata is lifted first, so the body pass knows which keys it has already
  // used and does not repeat them underneath.
  const consumed = new Set<string>();
  if (record) {
    const foundTitle = readString(record, TITLE_FIELDS);
    if (foundTitle) {
      title = foundTitle.value;
      consumed.add(foundTitle.key);
    }
    const foundUrl = readString(record, URL_FIELDS);
    if (foundUrl) {
      url = foundUrl.value;
      consumed.add(foundUrl.key);
    }
    const rawTags = record['tags'];
    if (Array.isArray(rawTags)) {
      tags = rawTags.map(stringifyPayloadValue);
      consumed.add('tags');
    } else if (typeof rawTags === 'string') {
      tags = rawTags.split(/[,\s]+/);
      consumed.add('tags');
    }
  }

  if (webhook.format === 'template') {
    body = renderPayloadTemplate(webhook.bodyTemplate ?? '', payload, WEBHOOK.maxBodyChars);
  } else if (shape === 'text' || !record) {
    body = raw.slice(0, WEBHOOK.maxBodyChars);
  } else {
    // One obvious message field, and nothing else of substance, *is* the
    // message. As soon as there is more than one, every field matters — a form
    // submission has eleven of them and picking one would throw ten away. The
    // rendered version still contains the message field, so nothing is lost.
    const content = Object.entries(record).filter(
      ([key, value]) => !consumed.has(key) && stringifyPayloadValue(value).trim(),
    );
    const sole = content.length === 1 ? content[0] : undefined;
    body =
      sole && BODY_FIELDS.includes(sole[0])
        ? stringifyPayloadValue(sole[1])
        : renderFields(record, consumed);
    body = body.slice(0, WEBHOOK.maxBodyChars);
  }

  if (webhook.titleTemplate?.trim()) {
    title = renderPayloadTemplate(webhook.titleTemplate, payload, 300).trim() || null;
  }

  // Only http(s) survives: the URL reaches an anchor's href in the SPA.
  if (url && !/^https?:\/\//i.test(url)) url = null;

  return {
    body: body.trim(),
    title,
    url,
    tags: normalizeTags([...webhook.tags, ...tags]),
  };
}

/**
 * Rolls the fixed window and counts this request in one statement.
 *
 * Both `CASE` arms read the pre-update value of `window_started_at` — Postgres
 * evaluates every SET expression against the old row — so the reset and the
 * increment cannot disagree, and two concurrent deliveries cannot both see a
 * fresh window.
 */
async function chargeRateLimit(webhookId: string): Promise<number> {
  const result = await getDb().execute<{ window_count: number }>(
    sql`UPDATE radar_webhooks
        SET window_started_at = CASE
              WHEN window_started_at < now() - interval '1 minute' THEN now()
              ELSE window_started_at END,
            window_count = CASE
              WHEN window_started_at < now() - interval '1 minute' THEN 1
              ELSE window_count + 1 END
        WHERE id = ${webhookId}
        RETURNING window_count`,
  );
  return result.rows[0]?.window_count ?? 0;
}

async function noteFailure(webhookId: string, message: string): Promise<void> {
  await getDb()
    .update(schema.radarWebhooks)
    .set({ lastErrorAt: new Date(), lastError: message.slice(0, 500) })
    .where(eq(schema.radarWebhooks.id, webhookId))
    .catch(() => undefined);
}

/**
 * The unauthenticated path. Everything it is allowed to do, it does through the
 * ordinary service layer as the webhook's creator.
 */
export async function ingestWebhook(
  webhookId: string,
  token: string,
  delivery: InboundDelivery,
): Promise<DeliveryResult> {
  // A wrong token and a missing webhook are the same answer: a 404 must not
  // become an oracle for which ingest ids exist.
  const rows = await getDb()
    .select({ webhook: schema.radarWebhooks, user: schema.users })
    .from(schema.radarWebhooks)
    .innerJoin(schema.users, eq(schema.users.id, schema.radarWebhooks.createdBy))
    .where(
      and(
        eq(schema.radarWebhooks.id, webhookId),
        eq(schema.radarWebhooks.tokenHash, hashSecret(token)),
        sql`omr_account_open(${schema.users.id})`,
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) throw notFound('No such webhook');

  const webhook: WebhookRow = row.webhook;
  const creator: UserRow = row.user;

  if (!webhook.enabled) throw badRequest('This webhook is disabled');
  // Suspension has to reach every credential the account holds, not just its
  // sessions — otherwise a suspended user keeps writing through a URL.
  if (creator.state !== 'active') {
    throw badRequest('The account behind this webhook is not active');
  }

  const count = await chargeRateLimit(webhook.id);
  if (count > WEBHOOK.requestsPerMinute) {
    throw tooManyRequests(
      `This webhook accepts ${WEBHOOK.requestsPerMinute} deliveries per minute.`,
    );
  }

  const actor: Actor = { user: creator, kind: 'webhook', webhookId: webhook.id };
  const mapped = mapPayload(webhook, delivery);

  if (!mapped.body && !mapped.title && !mapped.url) {
    await noteFailure(webhook.id, 'Delivery had nothing in it that could become a blip');
    throw badRequest('That payload produced an empty blip');
  }

  try {
    // Same function the composer and the MCP tool call, with the same
    // authorization: if the creator can no longer write here, this throws.
    const blip = await createBlip(actor, webhook.radarId, {
      body: mapped.body,
      title: mapped.title,
      url: mapped.url,
      tags: mapped.tags,
      state: webhook.state,
    });

    await getDb()
      .update(schema.radarWebhooks)
      .set({
        lastDeliveryAt: new Date(),
        deliveryCount: sql`${schema.radarWebhooks.deliveryCount} + 1`,
        lastError: null,
        lastErrorAt: null,
      })
      .where(eq(schema.radarWebhooks.id, webhook.id));

    return { blipId: blip.id, radarId: blip.radarId };
  } catch (err) {
    // Not a cast: a thrown `null` here would `TypeError` inside the catch and
    // escape it, skipping `noteFailure` — so the sender's only diagnostic would
    // still read as though the last delivery had gone through.
    //
    // Only an `ApiError`'s words are stored: they were written to be read by
    // whoever asked. Anything else is our fault, and its text — a Postgres
    // message, a constraint name — would be shown to every manager of the
    // radar as `lastError`, in the settings screen and in `list_webhooks`.
    const message =
      err instanceof ApiError
        ? errorMessage(err, 'Delivery failed')
        : 'Delivery failed on the server rather than because of the payload.';
    await noteFailure(webhook.id, message);
    logger.warn({ webhookId: webhook.id, err }, 'webhook delivery failed');
    throw err;
  }
}
