import type { AttachmentDto } from './dto.js';
import { z } from 'zod';

const reserved = new Set([
  'admin',
  'administrator',
  'abuse',
  'postmaster',
  'hostmaster',
  'webmaster',
  'support',
  'hello',
  'noreply',
  'no-reply',
  'security',
  'root',
  'www',
  'mail',
]);
export const emailCaptureUsernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(32)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single hyphens.')
  .refine((value) => !reserved.has(value), 'Choose a different username.');
export const updateEmailCaptureIdentitySchema = z
  .object({ username: emailCaptureUsernameSchema })
  .strict();
export const updateRadarEmailCaptureSchema = z
  .object({
    enabled: z.boolean(),
    allowedSenders: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .email()
          .max(254)
          .refine(
            (value) => !value.includes('*'),
            'Enter an individual email address, not a wildcard.',
          ),
      )
      .max(25)
      .transform((values) => [...new Set(values)]),
  })
  .strict();
export interface EmailCaptureIdentityDto {
  available: boolean;
  username: string | null;
  address: string | null;
}
export interface RadarEmailCaptureDto {
  available: boolean;
  identityConfigured: boolean;
  enabled: boolean;
  address: string | null;
  allowedSenders: string[];
  lastReceivedAt: string | null;
  lastError: string | null;
}

/** Compact immutable email provenance; full message content is loaded separately. */
export interface EmailSummaryDto {
  subject: string | null;
  senderName: string | null;
  senderAddress: string | null;
  sentAt: string | null;
  receivedAt: string;
  preview: string;
  hasHtml: boolean;
  legacy: boolean;
  notes: string;
  attachmentCount: number;
}

export interface EmailDetailDto extends EmailSummaryDto {
  text: string;
  /** Sanitized fragment; render only in the isolated email reader. */
  html: string | null;
  attachments: AttachmentDto[];
  /** Private download-only original; never exposed to public-link readers. */
  originalHref: string | null;
  remoteImagesBlocked: number;
  /** Storage origins allowed for verified, blip-owned CID images. */
  imageOrigins: string[];
}
