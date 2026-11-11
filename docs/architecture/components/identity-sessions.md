# Component: M1 Identity and sessions

Status: Draft · Version 0.1 · As built at `origin/main` 2c4905d

## 1. Responsibility

Decides who is signed in. It issues and checks the emailed one-time code, runs the OIDC SSO flow, creates accounts in the right initial state (pending or active; suspension is only an admin act), keeps the waitlist, and creates, resolves and revokes sessions. It stops at identity: what a person may do is M3, and long-lived machine credentials are M2.

**Depends on:** M3 (the `Actor`), M10 (mail through `services/mail.ts`, outbox `email` jobs), M11, M20 (the `omr_account_open` fence).

**Used by:** Every request, through `attachActor` in `auth/middleware.ts`; M2 (bearer resolution falls through to session tokens); M24.

**Invariants (and what enforces each):**

- A code is six digits, valid 10 minutes, five attempts, and only its HMAC-SHA256 is stored (`auth/crypto.ts`, `packages/contract/src/domain.ts`). Enforced by `auth/races.test.ts` (a code redeems once; the per-address ceiling is exact; a live code survives a refused request).
- The rate window is one `INSERT … ON CONFLICT` statement per address (`login_code_limits`) and per network (`login_code_network_limits`), so concurrent pods cannot overshoot it (`chargeWindow` in `auth/codes.ts`; `auth/code-limits.test.ts`). The network is charged first, so a refused network does not spend an address's allowance.
- `request-code` answers the same whether or not the address has an account; the browser flow requires the signed `omr_login` cookie, checked before the code is consulted (`routes/auth.ts`, `routes/login-csrf.test.ts`).
- An account's initial state is decided at creation (`findOrCreateUser`); re-authenticating never un-suspends, though under `SIGNUP_MODE=open` a pending account is admitted on its next sign-in or session use (`admitOnOpenSignup`). `activateUser` touches only `pending` rows with a guarded `UPDATE … WHERE state = 'pending'` and is the single approval path (`auth/accounts.ts`; `routes/open-signup.test.ts`, `routes/waitlist.test.ts`).
- A session cookie is `omr_session`, httpOnly and SameSite Lax; a native session is `omr_s_…` as a bearer token, returned in the body and never as a cookie. Resolving a session requires an unexpired row and `omr_account_open(user)`; suspending revokes every session that exists then, though a suspended person can sign in again to be told so, and that new session passes `resolveSession` but not `requireActor` (`auth/session.ts`, `routes/admin.ts`; `bearer-session.test.ts`).
- Cross-site writes are refused by `Sec-Fetch-Site` or `Origin`, and bearer requests are exempt (`csrf.ts`).
- The waitlist form creates only `pending` users and nothing for an address that would skip the queue; every outcome returns the same body; one confirmation email per address per day is decided in the statement that charges it (`services/waitlist.ts`, `routes/waitlist.test.ts`).

## 2. Owned data

| Owned                                      | Kind  | Notes                                                      |
| ------------------------------------------ | ----- | ---------------------------------------------------------- |
| `users`                                    | table |                                                            |
| `identities`                               | table |                                                            |
| `login_codes`                              | table |                                                            |
| `login_code_limits`                        | table |                                                            |
| `login_code_network_limits`                | table |                                                            |
| `sessions`                                 | table |                                                            |
| `waitlist_requests`                        | table |                                                            |
| `packages/server/src/auth/codes.ts`        | file  | Code issue, verify, rate windows                           |
| `packages/server/src/auth/crypto.ts`       | file  | HMAC hashing of tokens and codes, domain-separated signing |
| `packages/server/src/auth/oidc.ts`         | file  | OIDC SSO client: discovery, token exchange, userinfo       |
| `packages/server/src/auth/accounts.ts`     | file  | Account creation and the initial-state policy              |
| `packages/server/src/auth/session.ts`      | file  | Session issue, resolve, revoke, cookie options             |
| `packages/server/src/auth/middleware.ts`   | file  | `attachActor`: resolves the `Actor` for every request      |
| `packages/server/src/auth/retention.ts`    | file  | Sweeps expired rows (run by the worker)                    |
| `packages/server/src/auth/welcome.ts`      | file  | The welcome workspace for a new account                    |
| `packages/server/src/csrf.ts`              | file  | Cross-site write refusal                                   |
| `packages/server/src/cors.ts`              | file  | Bearer-only cross-origin access when configured            |
| `packages/server/src/services/waitlist.ts` | file  | Waitlist requests and confirmation mail                    |
| `packages/server/src/routes/auth.ts`       | file  | Mounted at `/api/auth` and `/api/v1/auth`                  |
| `packages/server/src/routes/waitlist.ts`   | file  | Mounted at `/api/waitlist`                                 |

## 3. Interface

- **Routes (`/api/auth`):** `GET /config`, `GET /session`, `POST /request-code`, `POST /verify-code`, `GET /oidc/start`, `GET /oidc/callback`, `POST /logout`, `PATCH /profile`, `GET /sessions`, `DELETE /sessions/:id`. `POST /api/waitlist` is unauthenticated and returns 202. Admin approval is `GET /api/admin/users` and `POST /api/admin/users/:id` in `routes/admin.ts` (hosted by M24).
- **MCP tools:** none. Every auth route is classified human-only in `mcp/capabilities.ts`.
- **Configuration:** `SESSION_SECRET` (at least 32 characters), session lifetime 30 days (the constant `SESSION_TTL_DAYS` in `packages/contract/src/domain.ts`, not an env variable), `SIGNUP_MODE` (`open` or `waitlist`, default `waitlist`), `ADMIN_EMAILS`, `AUTO_APPROVE_EMAILS`, `TRUSTED_IP_HEADER` default `cf-connecting-ip`, `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_PROVIDER_NAME`, `OIDC_SCOPES`, `OIDC_TOKEN_AUTH_METHOD`, `OIDC_USE_PKCE`, `OIDC_HTTP_TIMEOUT_MS`.

## 4. Failure and degradation

- Without OIDC configuration `/api/auth/oidc/start` answers 400 "SSO is not configured" and code login is the only way in. Without `RESEND_API_KEY`, production throws on the code email and other environments log and skip.
- A rate limit that cannot be charged fails the request; it never falls open.

## 5. Known gaps and unverified facts

- `identities (provider, subject)` is inserted at sign-in and never read; accounts are matched by email (`routes/auth.ts`).
- SSO identity is read from userinfo but falls back to unsigned id_token claims when userinfo fails, and no `email_verified` check exists (`auth/oidc.ts`). `docs/DESIGN.md` section 13 describes only userinfo.
- The comment at `env.ts` says `SESSION_SECRET` signs cookies; the cookie is an opaque token and the secret only keys its stored hash.
