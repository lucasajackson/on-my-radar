# Component: M24 API edge

Status: Draft · Version 0.1 · As built at `origin/main` 2c4905d

## 1. Responsibility

The HTTP application and the shared runtime beneath it: the Hono app and its middleware order, the uniform error envelope, API versioning, configuration validation, the database client and migrator, the logger, the health routes, the SPA fallback and the one vetted outbound transport. It contains no domain rules; it hosts the admin routes that M1 and M21 define.

**Depends on:** M1 (`attachActor`), M2, M25, PostgreSQL.

**Used by:** Every other component.

**Invariants (and what enforces each):**

- Middleware order in `createApp`: request id (`cf-ray` or a UUID, echoed as `x-request-id`) and request logging (health excluded); radar CSP; guest-support no-store; cross-origin access; secure headers; `attachActor`; the body bound; `refuseCrossSiteWrites` (`app.ts`).
- The API is mounted twice from one list: `/api<path>` and `/api/v1<path>`; `/health`, `/.well-known`, `/oauth`, `/mcp` and `/hooks` are mounted unversioned; the helpdesk router is versioned only (`HELPDESK_PREFIX`).
- The error envelope is `{error:{code,message,id?,fields?}}`; unknown paths under `/api`, `/oauth`, `/hooks`, `/.well-known` and `/mcp` are JSON 404s and everything else falls to the SPA (`app.ts`; `api-version.test.ts` covers only `/api/v1/*`; the match is `startsWith('/api/')`, so a bare `/api` falls to the SPA).
- Cross-origin access can grant bearer-only access to `/api` from `CORS_ALLOWED_ORIGINS` (default empty; the production value is in the chart); `Access-Control-Allow-Credentials` is never sent (`cors.ts`; `api-cors.test.ts`).
- Configuration is validated at boot (`env.ts`): `DATABASE_URL` and a `SESSION_SECRET` of at least 32 characters are required; half-configured pairs (APNs key id and key) fail startup; a malformed GitLab token map turns the feature off rather than failing.
- The migrator applies `drizzle/NNNN_*.sql` in order, records checksums in `schema_migrations`, refuses an edited applied file or a new file numbered below an applied one, and serialises concurrent boot (`db/migrate.ts`; `db/migrate.test.ts`).
- `/health/live` answers with the build sha and no database call; `/health/ready` pings the database and answers 503 while draining (`routes/health.ts`).
- `publicRequest` is the only transport for a user-chosen URL (principle P10; `services/public-request.ts`).
- The pool is `DB_POOL_MAX` (default 10); request bodies are capped at `HTTP_BODY_LIMIT_BYTES` (default 2 MiB) for authenticated callers; requests with no actor are capped at 16 KiB (guest support excepted), `/hooks/*` at the webhook payload limit, and the Stripe and raw-email hooks at their own caps (`body-limit.ts`).

## 2. Owned data

| Owned                                            | Kind      | Notes                                                                               |
| ------------------------------------------------ | --------- | ----------------------------------------------------------------------------------- |
| `schema_migrations`                              | elsewhere | Created by the migrator, not a Drizzle table, excluded from `ALL_TABLE_NAMES`       |
| `packages/server/src/app.ts`                     | file      | The Hono app                                                                        |
| `packages/server/src/env.ts`                     | file      | Configuration schema                                                                |
| `packages/server/src/errors.ts`                  | file      | `ApiError` and the envelope                                                         |
| `packages/server/src/logger.ts`                  | file      | Structured logging and path scrubbing                                               |
| `packages/server/src/body-limit.ts`              | file      | Request body bound                                                                  |
| `packages/server/src/text-value.ts`              | file      | Text normalisation                                                                  |
| `packages/server/src/db/client.ts`               | file      | Pool and Drizzle client                                                             |
| `packages/server/src/db/migrate.ts`              | file      | Migrator                                                                            |
| `packages/server/src/db/schema.ts`               | file      | Drizzle mirror of the SQL and `ALL_TABLE_NAMES`                                     |
| `packages/server/src/db/stored.ts`               | file      | Stored-value helpers                                                                |
| `packages/server/drizzle`                        | file      | The forward-only SQL migrations (58 files)                                          |
| `packages/server/src/services/public-request.ts` | file      | The vetted outbound transport                                                       |
| `packages/server/src/routes/admin.ts`            | file      | Mounted at `/api/admin`; hosts account approval (M1) and model catalog (M21) routes |
| `packages/server/src/routes/health.ts`           | file      | Mounted at `/health`                                                                |

## 3. Interface

- **Routes hosted:** `/api/admin/users`, `/api/admin/models`, `/api/admin/overview`; `/health/live`, `/health/ready`; the SPA fallback and `/agent-setup/:file`.
- **Configuration:** `NODE_ENV`, `PORT` (3500), `LOG_LEVEL`, `PUBLIC_URL`, `APP_URL`, `CORS_ALLOWED_ORIGINS`, `MIGRATE_ON_BOOT`, `DB_POOL_MAX`, `DB_POOL_IDLE_TIMEOUT_MS`, `DB_POOL_CONNECT_TIMEOUT_MS`, `HTTP_BODY_LIMIT_BYTES`, `TRUSTED_IP_HEADER`, `UI_DIST_DIR`, `ONMYRADAR_BUILD_SHA`, plus those of each component.

## 4. Failure and degradation

- The API is replica-safe except for the in-memory email nonce cache (M13); the chart sets one API replica (a code comment; the chart is outside the repository).
- A draining API fails readiness first so Traefik stops routing before connections close; `SHUTDOWN_DRAIN_MS` is 5000 and `SHUTDOWN_TIMEOUT_MS` 25000.

## 5. Known gaps and unverified facts

- Migration numbers 0007, 0009, 0012, 0059 to 0077 and 0079 to 0084 are absent on `main` (the migrator requires increasing order, not contiguity).
- `docs/SCALE.md` section 6 plans read replicas; no replica setting exists in `env.ts`.
