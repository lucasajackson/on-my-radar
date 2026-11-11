import { z } from 'zod';

export const SUBSCRIPTION_EVENTS = [
  'blip.created',
  'blip.updated',
  'blip.deleted',
  'comment.created',
] as const;
export type SubscriptionEvent = (typeof SUBSCRIPTION_EVENTS)[number];
export const createSubscriptionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  url: z
    .string()
    .url()
    .max(2048)
    .refine((value) => {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
    }, 'Use a public HTTPS URL without credentials or a fragment'),
  events: z
    .array(z.enum(SUBSCRIPTION_EVENTS))
    .min(1)
    .max(4)
    .transform((v) => [...new Set(v)]),
});
export const updateSubscriptionSchema = z.object({ enabled: z.boolean() }).strict();
export type CreateSubscriptionInput = z.infer<typeof createSubscriptionSchema>;
export interface SubscriptionDto {
  id: string;
  radarId: string;
  name: string;
  url: string;
  events: SubscriptionEvent[];
  enabled: boolean;
  lastError: string | null;
  createdAt: string;
  secret?: string;
}
export interface SubscriptionDeliveryDto {
  id: string;
  eventId: string;
  event: string;
  attempt: number;
  status: number | null;
  error: string | null;
  createdAt: string;
}
export interface SubscriptionPayload {
  id: string;
  event: SubscriptionEvent | 'subscription.test';
  occurredAt: string;
  radar: { id: string; name: string };
  actor: {
    kind: 'user' | 'agent' | 'webhook' | 'integration' | 'guest' | 'system';
    id: string;
    name: string | null;
    agentId: string | null;
  };
  blip: Record<string, unknown> | null;
  changes: Record<string, { from: unknown; to: unknown }> | null;
  comment: Record<string, unknown> | null;
}
