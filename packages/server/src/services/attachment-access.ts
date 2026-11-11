/** Attachment authorization shared by REST and MCP; signed URLs remain short lived. */
import { eq, sql } from 'drizzle-orm';
import { uploadTicketSchema } from '@onmyradar/contract';
import { getDb, schema } from '../db/client.js';
import { notFound, type Actor } from '../http.js';
import { requireRadar } from './access.js';
import {
  createDownloadUrl,
  createUploadTicket,
  buildObjectKey,
  assertUploadable,
} from './storage.js';
import { lockOwner } from './owner-lock.js';
import { writeAsAgent } from './agents.js';

export async function requestAttachmentUpload(
  actor: Actor,
  radarId: string,
  input: { filename: string; contentType: string; size: number; session?: string | undefined },
) {
  // Issued to the user, and to the agent when the call names one: `update_blip` attaches it for them only.
  actor = await writeAsAgent(actor, input.session);
  const access = await requireRadar(radarId, actor, 'write');
  const parsed = uploadTicketSchema.parse(input);
  assertUploadable(parsed.contentType, parsed.size);
  const key = buildObjectKey(access.radar.id, parsed.filename);
  return getDb().transaction(async (tx) => {
    await lockOwner(tx, access.radar.ownerId);
    await tx.execute(sql`SELECT omr_assert_account_open(${access.radar.ownerId}::uuid)`);
    const current = await requireRadar(access.radar.id, actor, 'write', tx);
    if (current.radar.ownerId !== access.radar.ownerId) throw notFound('Radar not found');
    await tx.insert(schema.uploadTickets).values({
      objectKey: key,
      radarId: access.radar.id,
      userId: actor.user.id,
      agentId: actor.agent?.agentId ?? null,
    });
    return createUploadTicket(
      access.radar.id,
      parsed.filename,
      parsed.contentType,
      parsed.size,
      key,
    );
  });
}

export async function getReadableAttachment(actor: Actor | null, attachmentId: string) {
  const [attachment] = await getDb()
    .select()
    .from(schema.attachments)
    .where(eq(schema.attachments.id, attachmentId))
    .limit(1);
  if (!attachment) throw notFound('Attachment not found');
  const access = await requireRadar(attachment.radarId, actor, 'read');
  return { attachment, access };
}

export async function getAttachmentUrl(
  actor: Actor | null,
  attachmentId: string,
  download = false,
) {
  const { attachment } = await getReadableAttachment(actor, attachmentId);
  return createDownloadUrl(
    attachment.objectKey,
    attachment.filename,
    attachment.contentType,
    download ? 'attachment' : 'inline',
  );
}
