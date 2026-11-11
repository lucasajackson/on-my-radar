import { and, eq } from 'drizzle-orm';
import type { EmailDetailDto } from '@onmyradar/contract';
import { getDb, schema } from '../db/client.js';
import { ApiError, notFound, type Actor } from '../http.js';
import { requireRadar } from './access.js';
import { liveExpr } from './blips.js';
import { emailSummary } from './email-summary.js';
import { isInlineEmailImage } from './email-html.js';
import { renderEmailHtmlIsolated } from './email-render.js';
import { createDownloadUrl, readEmailContent } from './storage.js';

async function accessibleEmail(id: string, actor: Actor | null, publicSlug?: string) {
  const [row] = await getDb()
    .select({ blip: schema.blips, email: schema.blipEmails })
    .from(schema.blips)
    .innerJoin(schema.blipEmails, eq(schema.blipEmails.blipId, schema.blips.id))
    .where(and(eq(schema.blips.id, id), publicSlug ? liveExpr : undefined));
  if (!row) throw notFound('Email not found');
  const access = await requireRadar(publicSlug ?? row.blip.radarId, actor, 'read');
  if (row.blip.radarId !== access.radar.id || (publicSlug && !access.viaPublicLink))
    throw notFound('Email not found');
  return { ...row, access };
}

/**
 * How many emails may be read at once, as two budgets rather than one.
 *
 * A read pulls the stored payload out of object storage and renders its HTML in
 * a worker with a 64 MB heap, so it is bounded. It used to be bounded by one
 * process-wide counter of 2 that the public route shared with everybody: two
 * slow anonymous requests on any published email blip answered every member of
 * every radar "busy". Callers with a role on the radar and callers reaching it
 * through a public link now draw on separate budgets, so nothing an anonymous
 * caller does can take a member's slot. The public budget is still exhaustible
 * by the public, which is where that cost belongs.
 */
export const EMAIL_READ_BUDGETS = { member: 2, public: 2 } as const;
const inFlight = { member: 0, public: 0 };

export async function getEmailDetail(
  id: string,
  actor: Actor | null,
  publicSlug?: string,
  images = false,
  options: { renderHtml?: boolean } = {},
): Promise<EmailDetailDto> {
  const { blip, email, access } = await accessibleEmail(id, actor, publicSlug);
  const budget = access.role === null ? 'public' : 'member';
  if (inFlight[budget] >= EMAIL_READ_BUDGETS[budget])
    throw new ApiError(
      503,
      'email_reader_busy',
      'Email reading is busy. Please try again shortly.',
    );
  inFlight[budget]++;
  try {
    const content = email.payloadKey
      ? await readEmailContent(email.payloadKey)
      : { text: blip.body, html: null, files: [] };
    const rows = await getDb()
      .select()
      .from(schema.attachments)
      .where(and(eq(schema.attachments.blipId, id), eq(schema.attachments.radarId, blip.radarId)));
    const cidUrls = new Map<string, string>();
    const inlineKeys = new Set<string>();
    for (const file of content.files) {
      const attachment = rows.find((row) => row.objectKey === file.key);
      if (!attachment || !file.inline || !file.contentId) continue;
      if (!isInlineEmailImage(content.html, attachment.contentType, file.contentId)) continue;
      inlineKeys.add(file.key);
      if (options.renderHtml === false) continue;
      cidUrls.set(
        file.contentId,
        await createDownloadUrl(file.key, attachment.filename, attachment.contentType),
      );
    }
    const rendered =
      content.html && options.renderHtml !== false
        ? await renderEmailHtmlIsolated(content.html, cidUrls, images)
        : { html: null, remoteImagesBlocked: 0, imageOrigins: [] };
    const prefix = publicSlug
      ? `/api/public/radars/${encodeURIComponent(publicSlug)}/attachments/`
      : '/api/attachments/';
    return {
      ...emailSummary(email, blip.emailNotes),
      senderAddress: publicSlug ? null : email.senderAddress,
      text: content.text,
      ...rendered,
      attachments: rows
        .filter((row) => !inlineKeys.has(row.objectKey))
        .map((row) => ({
          id: row.id,
          filename: row.filename,
          contentType: row.contentType,
          size: row.size,
          width: row.width,
          height: row.height,
          href: prefix + row.id,
        })),
      originalHref: !publicSlug && email.originalKey ? `/api/blips/${id}/email/original` : null,
    };
  } finally {
    inFlight[budget]--;
  }
}

/** Raw MIME can contain recipient/header information, so only current radar members can download it. */
export async function getOriginalEmailUrl(id: string, actor: Actor): Promise<string> {
  const { email } = await accessibleEmail(id, actor);
  if (!email.originalKey) throw notFound('Original email is unavailable');
  return createDownloadUrl(email.originalKey, 'original.eml', 'message/rfc822', 'attachment');
}
