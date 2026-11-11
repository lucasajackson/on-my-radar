# Contract: OpenID Connect provider

Status: Draft · Version 1.1 · Owner (OMR side): M1 Identity and sessions · Owner (other side): the operator's OIDC provider (Keycloak, Authentik, Okta, Entra ID or any conformant IdP) · Provider ref verified against: `auth/oidc.ts`; plain `fetch` for the protocol and `jose` for the ID-token signature

## 1. Scope

Single sign-on alternative to the emailed code: discovery, authorization-code exchange with PKCE, ID-token verification and userinfo. The account is matched by email or created under the normal access policy; nothing restricts it to staff. `.env.example` has a configuration recipe for each common provider.

## 2. Auth

Client credentials `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`, sent by `OIDC_TOKEN_AUTH_METHOD` (default `basic`, i.e. `client_secret_basic`; `post` puts them in the form body), PKCE S256 (`OIDC_USE_PKCE`), scopes `OIDC_SCOPES` (default `openid email profile`). State is an HMAC-signed `omr_oidc` cookie (state, verifier, nonce and next) with a 10 minute `maxAge`.

## 3. Operations

| Operation | Shape                                                | Effect   | Notes                                                                                                                                              |
| --------- | ---------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery | `GET <issuer>/.well-known/openid-configuration`      | read     | Tried at the issuer path, then at the host root. Explicit `OIDC_AUTHORIZATION_ENDPOINT` and `OIDC_TOKEN_ENDPOINT` (with the issuer) replace it     |
| Token     | `POST` token endpoint                                | exchange | Timeout `OIDC_HTTP_TIMEOUT_MS` (default 30 seconds)                                                                                                |
| JWKS      | `GET` `OIDC_JWKS_URI`, else the discovery `jwks_uri` | read     | Signs the ID token check; with neither, sign-in is refused                                                                                         |
| Userinfo  | `GET` userinfo with the bearer token                 | read     | Supplies the profile only. Its `sub` can never change who signed in. A `{ data: {...} }` wrapper is unwrapped only when the top level has no `sub` |

## 4. Errors and refusals

- The ID token must verify against the JWKS and carry the issuer, audience, authorized party, expiry and this attempt's nonce. A token without the nonce is refused unless `OIDC_ALLOW_MISSING_NONCE` is set; a wrong one is always refused.
- A failed discovery leaves SSO unavailable and is retried after five minutes. There is no guessed fallback: a provider with no discovery document needs its endpoints set explicitly.
- A failure is logged with what the token endpoint said. Without configuration `/api/auth/oidc/start` answers 400 "SSO is not configured" and `/api/auth/config` reports `oidc.enabled: false`.

## 5. Idempotency, versioning and limits

- Do not probe the identity provider in a loop; some providers lock out an address that makes repeated failing requests.

## 6. Known gaps and unverified facts

- A new account or link by email needs the provider's `email_verified: true`, or the operator's assertion `OIDC_TRUST_IDP_EMAIL`. Identities are keyed by (provider, issuer, subject).
