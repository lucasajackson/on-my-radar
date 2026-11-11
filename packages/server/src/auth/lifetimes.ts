/** Refresh lifetime shared by token redemption and credential retention. */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long a token row outlives its own refresh window before retention may
 * delete it. A rotated or revoked row is the only evidence that a retired
 * refresh token was once valid (`previous_refresh_hash`), and the token it
 * retired stays presentable for the whole refresh lifetime — measured from the
 * row's `created_at`. Sweeping the row earlier turns a replay into an
 * unremarkable "not valid" and leaves the successor alive.
 */
export const OAUTH_TOKEN_RETENTION_MARGIN_MS = 7 * 24 * 60 * 60 * 1000;
export const OAUTH_TOKEN_RETENTION_MS = REFRESH_TOKEN_TTL_MS + OAUTH_TOKEN_RETENTION_MARGIN_MS;
