/** Explicit bounded raster-view exception to direct attachment downloads. */
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { getDb, schema } from '../db/client.js';
import { ApiError, notFound, type Actor } from '../http.js';
import { refreshBearerActor } from '../auth/bearer.js';
import { getReadableAttachment } from './attachment-access.js';
import { readImageObject } from './storage.js';
import { mediaType } from './content-types.js';

export const ATTACHMENT_IMAGE_LIMITS = {
  bytes: 4 * 1024 * 1024,
  pixels: 8_000_000,
  dimension: 8192,
  readMs: 10_000,
  decodeSeconds: 5,
  inFlight: 2,
} as const;
let inFlight = 0;
const unsupported = () =>
  new ApiError(
    422,
    'image_unsupported',
    'This attachment is not a supported static PNG, JPEG or WebP within the image-view limits. Use download_attachment for the original.',
  );

function signature(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp';
  return null;
}

/** libvips reads APNG's first frame as ordinary PNG; reject its animation chunk explicitly. */
function animatedPng(bytes: Buffer): boolean {
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) throw unsupported();
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'acTL') return true;
    offset += length + 12;
    if (type === 'IEND') break;
  }
  return false;
}

async function readableAttachment(actor: Actor, attachmentId: string) {
  const [user] = await getDb()
    .select({ state: schema.users.state })
    .from(schema.users)
    .where(eq(schema.users.id, actor.user.id));
  if (!user || user.state !== 'active' || !['user', 'agent'].includes(actor.kind))
    throw notFound('Attachment not found');
  let current = actor;
  if (actor.kind === 'agent') {
    const bearer = await refreshBearerActor(actor);
    if (!bearer) throw notFound('Attachment not found');
    current = { ...bearer, kind: 'agent' };
  }
  const { attachment, access } = await getReadableAttachment(current, attachmentId);
  const [blip] = await getDb()
    .select({ radarId: schema.blips.radarId })
    .from(schema.blips)
    .where(eq(schema.blips.id, attachment.blipId));
  if (!blip || blip.radarId !== attachment.radarId) throw notFound('Attachment not found');
  return { attachment, clientSupplied: access.radar.wasClientFacing };
}

export async function readAttachmentImage(actor: Actor, attachmentId: string) {
  const selected = await readableAttachment(actor, attachmentId);
  const attachment = selected.attachment;
  const mimeType = mediaType(attachment.contentType);
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) throw unsupported();
  if (attachment.size < 1 || attachment.size > ATTACHMENT_IMAGE_LIMITS.bytes)
    throw new ApiError(
      413,
      'image_too_large',
      'Image exceeds the 4 MiB view limit. Use download_attachment for the original.',
    );
  if (inFlight >= ATTACHMENT_IMAGE_LIMITS.inFlight)
    throw new ApiError(
      429,
      'image_busy',
      'Image viewing is busy. Try again shortly or use download_attachment.',
    );
  inFlight++;
  try {
    const { bytes, contentType } = await readImageObject(
      attachment.objectKey,
      ATTACHMENT_IMAGE_LIMITS.bytes,
      ATTACHMENT_IMAGE_LIMITS.readMs,
    );
    if (
      bytes.length !== attachment.size ||
      signature(bytes) !== mimeType ||
      mediaType(contentType ?? '') !== mimeType ||
      (mimeType === 'image/png' && animatedPng(bytes))
    )
      throw unsupported();
    const decoder = sharp(bytes, {
      failOn: 'warning',
      limitInputPixels: ATTACHMENT_IMAGE_LIMITS.pixels,
      limitInputChannels: 4,
    });
    try {
      const metadata = await decoder.metadata();
      if (
        !metadata.width ||
        !metadata.height ||
        metadata.width > ATTACHMENT_IMAGE_LIMITS.dimension ||
        metadata.height > ATTACHMENT_IMAGE_LIMITS.dimension ||
        metadata.width * metadata.height > ATTACHMENT_IMAGE_LIMITS.pixels ||
        (metadata.pages ?? 1) !== 1 ||
        (metadata.format === 'png'
          ? 'image/png'
          : metadata.format === 'jpeg'
            ? 'image/jpeg'
            : metadata.format === 'webp'
              ? 'image/webp'
              : null) !== mimeType
      )
        throw unsupported();
      await decoder
        .timeout({ seconds: ATTACHMENT_IMAGE_LIMITS.decodeSeconds })
        .raw({ depth: 'uchar' })
        .toBuffer();
    } catch {
      throw unsupported();
    } finally {
      decoder.destroy();
    }
    // A grant/source can change while the provider or decoder is awaited.
    const current = await readableAttachment(actor, attachmentId);
    for (const field of ['blipId', 'radarId', 'objectKey', 'size', 'contentType'] as const)
      if (current.attachment[field] !== attachment[field]) throw notFound('Attachment not found');
    return { bytes, mimeType, clientSupplied: selected.clientSupplied || current.clientSupplied };
  } finally {
    inFlight--;
  }
}
