# ADR-0008: Sign-in is an emailed one-time code, with optional SSO, and all abuse limits are single database statements

Status: Accepted · Date: 2026-08-26

## Context

Capture has to be cheaper than the thought, and the product has no passwords to store. Sign-in must still resist guessing, enumeration and mail-bombing across several API pods.

## Decision

- A six-digit code is emailed, valid for 10 minutes, with 5 attempts; only its HMAC is stored. Per address 6 requests an hour, per network 30.
- The rate window is one `INSERT … ON CONFLICT` row (`login_code_limits`, `login_code_network_limits`), so the ceiling is exact within a fixed window (up to about twice that across a window boundary); the per-network limit is skipped when no trusted client IP header is present. Verification claims an attempt with a guarded `UPDATE`.
- `request-code` answers identically whether or not the address has an account. The browser flow needs a signed login-challenge cookie, checked before the code is consulted.
- OIDC SSO (any conformant provider, with PKCE) is an alternative, matched to accounts by email.
- Sessions are opaque tokens stored as HMACs; native clients receive a bearer `omr_s_…` token and no cookie.

## Evidence

- `0ca3520` (2026-08-26) shipped the code login and OIDC. `3aa2f3c` (2026-09-02) made the per-address ceiling exact; `68e3f8e` (2026-09-26) added the per-network ceiling; `afee8c2` (2026-09-26) closed login CSRF three ways.
- `packages/server/src/auth/codes.ts`, `packages/server/src/auth/races.test.ts`, `packages/server/src/auth/code-limits.test.ts`.
- Code, TTL and limit constants are in `packages/contract/src/domain.ts`.

## Consequences

- Good: no password reset flow, nothing to crack.
- Cost: mail delivery is on the login path. `identities` (provider, subject) is written but never read; accounts are matched by email, and the SSO path falls back to unsigned id_token claims when userinfo fails (a recorded gap).
