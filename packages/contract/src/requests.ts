/**
 * Request bodies, as a client writes them.
 *
 * The `…Input` types beside each schema are `z.infer` — the *parsed* shape, in
 * which a field with a default is required — which is the server's view. A
 * client sends the other shape: defaults omitted, the server fills them in. That
 * is `z.input`, and it is spelled here once so a client does not need its own
 * copy of zod to ask for it.
 *
 * The SPA's `lib/api.ts` took `Record<string, unknown>` for every one of these,
 * so a misspelt field compiled and was silently stripped by the schema.
 */
import type { z } from 'zod';
import type {
  createBlipSchema,
  createRadarSchema,
  createTopicSchema,
  createWebhookSchema,
  updateBlipSchema,
  updateDashboardSchema,
  updateRadarSchema,
  updateTopicSchema,
  updateWebhookSchema,
} from './schemas.js';
import type {
  createRepoAgentSchema,
  modelCatalogEntrySchema,
  rememberSchema,
  setProfileSchema,
  shareAgentSchema,
  updateModelCatalogEntrySchema,
  updateRepoAgentSchema,
  updateBriefSchema,
  updateShareSchema,
} from './agent-repo.js';

export type CreateRadarRequest = z.input<typeof createRadarSchema>;
export type UpdateRadarRequest = z.input<typeof updateRadarSchema>;
export type CreateBlipRequest = z.input<typeof createBlipSchema>;
export type UpdateBlipRequest = z.input<typeof updateBlipSchema>;
export type CreateTopicRequest = z.input<typeof createTopicSchema>;
export type UpdateTopicRequest = z.input<typeof updateTopicSchema>;
export type CreateWebhookRequest = z.input<typeof createWebhookSchema>;
export type UpdateWebhookRequest = z.input<typeof updateWebhookSchema>;
export type UpdateDashboardRequest = z.input<typeof updateDashboardSchema>;
export type CreateRepoAgentRequest = z.input<typeof createRepoAgentSchema>;
export type UpdateRepoAgentRequest = z.input<typeof updateRepoAgentSchema>;
export type RememberRequest = z.input<typeof rememberSchema>;
export type SetProfileRequest = z.input<typeof setProfileSchema>;
export type ShareAgentRequest = z.input<typeof shareAgentSchema>;
export type UpdateShareRequest = z.input<typeof updateShareSchema>;
export type UpdateBriefRequest = z.input<typeof updateBriefSchema>;
export type ModelCatalogEntryRequest = z.input<typeof modelCatalogEntrySchema>;
export type UpdateModelCatalogEntryRequest = z.input<typeof updateModelCatalogEntrySchema>;
