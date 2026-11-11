# Component: M2 Credentials and OAuth

Status: Draft · Version 0.1 · As built at `origin/main` 2c4905d

## 1. Responsibility

Mints, resolves and revokes the long-lived credentials an agent or script uses: personal access tokens (`omr_pat_…`) and OAuth 2.1 grants for remote MCP clients. It owns the OAuth authorization server (dynamic client registration, PKCE, consent, refresh rotation), the scope vocabulary's enforcement at the bearer boundary, and the rule that a credential's scope is a ceiling.

**Depends on:** M1 (sessions for consent), M3 (the clamp is applied in `access.ts`), M21 (a credential may be bound to an agent), M20 (the refresh path rechecks the closure fence).

**Used by:** M23 (every `/mcp` call), M24 (bearer resolution in `attachActor`).

**Invariants (and what enforces each):**

- Scopes are `radars:read`, `radars:write` and `radars:manage`, mapping to ceiling roles viewer, editor and owner. A scope string that names nothing this server grants does not authenticate (`withScopes` in `auth/bearer.ts`; `services/scopes.test.ts`).
- State comes first: `users.state = 'active'` and `omr_account_open` are checked on every bearer request, so suspending an account stops its tokens at once (`auth/bearer.ts`; `services/agent-boundary.test.ts`).
- Minting, listing and revoking credentials, require a signed-in person (`requireUser` plus `assertHumanDecision` in `services/tokens.ts`), and OAuth consent requires `requireUser` in the route; a read-only token cannot hand itself a full-access one (`services/tokens.ts`).
- OAuth: public clients only, PKCE S256 mandatory, redirect URIs exact and https (or loopback), non-loopback hosts must be in `MCP_ALLOWED_REDIRECT_HOSTS`. A code lives 5 minutes, an access token 1 hour, a refresh window 30 days (`routes/oauth.ts`, `auth/lifetimes.ts`).
- A code is redeemed once and refresh rotates exactly once, under an advisory lock keyed on user and client, with `omr_account_open` rechecked under `account_lifecycle_fences … FOR SHARE` in the refresh branch (code redemption does not recheck it); `auth/races.test.ts` covers single redemption and single rotation, not the fence.
- `scope_consented` on `oauth_tokens` marks grants made before scopes were enforced; those resolve to the default full ceiling until re-authorised (migration 0014, `auth/bearer.ts`).
- Tokens are stored as HMAC hashes only (`api_tokens.token_hash` unique; `oauth_tokens` holds `access_token_hash` and `refresh_token_hash`); the plaintext is shown once.

## 2. Owned data

| Owned                                     | Kind  | Notes                                          |
| ----------------------------------------- | ----- | ---------------------------------------------- |
| `api_tokens`                              | table |                                                |
| `oauth_clients`                           | table |                                                |
| `oauth_codes`                             | table |                                                |
| `oauth_tokens`                            | table |                                                |
| `packages/server/src/services/tokens.ts`  | file  | Mint, list, revoke, grants                     |
| `packages/server/src/auth/bearer.ts`      | file  | Resolves a bearer to an `Actor` with a ceiling |
| `packages/server/src/auth/lifetimes.ts`   | file  | OAuth and token lifetimes                      |
| `packages/server/src/auth/integration.ts` | file  | Integration credential (`omr_int_`) resolution |
| `packages/server/src/routes/tokens.ts`    | file  | Mounted at `/api/tokens`                       |
| `packages/server/src/routes/oauth.ts`     | file  | Mounted at `/oauth` and `/.well-known`         |

## 3. Interface

- **Routes:** `/api/tokens`: `GET /`, `POST /`, `DELETE /:id`, `GET /grants`, `DELETE /grants/:clientId` (the `/agents` routes return 410). `/oauth`: `POST /register`, `GET /authorize`, `POST /authorize/decision`, `GET /client/:clientId`, `POST /token`. `/.well-known`: `oauth-protected-resource`, `oauth-authorization-server`, `openid-configuration`. The consent screen is the SPA route `/connect`.
- **MCP tools:** none; every credential route is human-only.
- **Configuration:** `MCP_ENABLED` (default true), `MCP_ALLOWED_REDIRECT_HOSTS`, `PUBLIC_URL`.

## 4. Failure and degradation

- `MCP_ENABLED=false` answers 404 on `/mcp` and leaves the OAuth routes in place.

## 5. Known gaps and unverified facts

- `docs/DESIGN.md` and `mcp/capabilities.ts` (around line 430) describe invite acceptance as needing the signed-in recipient; the route is unauthenticated and previews only, the claim happening at sign-in (M1). The doc comment is stale.
- The `omr_int_` integration credential is resolved in `auth/integration.ts` and confined to `/api/v1/helpdesk` by `auth/middleware.ts`; it is described under M18.
