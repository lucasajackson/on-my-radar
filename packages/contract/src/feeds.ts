import { z } from 'zod';

export const FEED_LOOKBACKS = ['forever', 'year', 'month', 'week', 'day'] as const;
export type FeedLookback = (typeof FEED_LOOKBACKS)[number];
export const createFeedSchema = z.object({
  url: z
    .string()
    .trim()
    .url()
    .max(2048)
    .refine((v) => {
      try {
        const url = new URL(v);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
      } catch {
        return false;
      }
    }, 'Use a public HTTP or HTTPS feed URL without credentials'),
  lookback: z.enum(FEED_LOOKBACKS),
});
export const updateFeedSchema = z
  .object({
    lookback: z.enum(FEED_LOOKBACKS).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type CreateFeedInput = z.infer<typeof createFeedSchema>;
export type UpdateFeedInput = z.infer<typeof updateFeedSchema>;
export interface FeedDto {
  id: string;
  radarId: string;
  url: string;
  title: string | null;
  lookback: FeedLookback;
  enabled: boolean;
  lastPolledAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  itemCount: number;
  createdAt: string;
}
