import { z } from 'zod';
import type { ClientStatus } from './helpdesk.js';

const noNul = (value: string) => !value.includes('\u0000');

export const SUPPORT_CATEGORIES = ['account', 'billing', 'bug', 'feature', 'privacy'] as const;
const body = z.string().trim().min(1).max(8_000).refine(noNul, 'Remove null characters.');
export const supportRequestSchema = z
  .object({
    operationId: z.string().uuid(),
    category: z.enum(SUPPORT_CATEGORIES),
    title: z.string().trim().min(1).max(160).refine(noNul, 'Remove null characters.'),
    body,
  })
  .strict();
export const supportReplySchema = z.object({ operationId: z.string().uuid(), body }).strict();
export type SupportRequestInput = z.infer<typeof supportRequestSchema>;
export type SupportReplyInput = z.infer<typeof supportReplySchema>;
export interface SupportRequestDto {
  id: string;
  category: (typeof SUPPORT_CATEGORIES)[number];
  title: string;
  body: string;
  status: ClientStatus;
  createdAt: string;
}
export interface SupportReplyDto {
  id: string;
  from: 'you' | 'support';
  body: string;
  createdAt: string;
}
export const supportPageSchema = z.object({ after: z.string().uuid().optional() }).strict();
export interface SupportThreadDto {
  request: SupportRequestDto;
  replies: SupportReplyDto[];
  next: string | null;
}

export const guestSupportRequestSchema = supportRequestSchema
  .extend({
    email: z.string().trim().email().max(254).optional(),
  })
  .strict();
export const guestSupportRecoverySchema = z
  .object({
    recoveryCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
export type GuestSupportRequestInput = z.infer<typeof guestSupportRequestSchema>;
export interface GuestSupportCredentialsDto {
  token: string;
  recoveryCode: string;
  expiresAt: string;
}
export interface GuestSupportThreadDto {
  thread: SupportThreadDto | null;
  expiresAt: string;
}
