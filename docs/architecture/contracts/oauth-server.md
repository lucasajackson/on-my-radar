# Contract: AI agents (OAuth authorization server)

Status: Draft · Version 1.0 · Owner (OMR side): M2 Credentials and OAuth · Owner (other side): AI agents (remote MCP clients that register themselves) · Provider ref verified against: `routes/oauth.ts` at `2c4905d`; clients seen in comments: claude.ai and LM Studio

## 1. Scope

OAuth 2.1 for remote MCP clients: discovery documents, dynamic client registration, authorization with PKCE, a consent decision made by a signed-in person, token issue and refresh rotation.

## 2. Auth

- Public clients only (`token_endpoint_auth_methods_supported: ['none']`). PKCE S256 is mandatory. A redirect URI must be registered exactly and be https or loopback; other hosts must be in `MCP_ALLOWED_REDIRECT_HOSTS`.
- The consent decision is `POST /oauth/authorize/decision`, which needs a signed-in `user` actor (a session cookie, or an `omr_s_` bearer, which is exempt from the CSRF guard) and refuses PAT and OAuth tokens; it is never auto-approved. The person picks the agent to write as by id and ownership is checked.

## 3. Operations

| Operation   | Shape                                                                                             | Effect           | Notes                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------- |
| Discovery   | `GET /.well-known/oauth-protected-resource`, `oauth-authorization-server`, `openid-configuration` | read             |                                                                           |
| Register    | `POST /oauth/register`                                                                            | creates a client | Idle clients are swept                                                    |
| Authorize   | `GET /oauth/authorize`, `POST /oauth/authorize/decision`                                          | creates a code   | Code lives 5 minutes, redeemed once                                       |
| Token       | `POST /oauth/token` (`authorization_code`, `refresh_token`)                                       | mints or rotates | Access token 1 hour, refresh window 30 days; refresh rotates exactly once |
| Client info | `GET /oauth/client/:clientId`                                                                     | read             | Used by the consent screen                                                |

## 4. Errors and refusals

- A refresh for a suspended or closed account is refused. Authorize errors redirect to the SPA route `/connect/error`.

## 5. Idempotency, versioning and limits

- Burn and mint of a code happen in one transaction under an advisory lock keyed on user and client. `scope_consented` is carried through refresh; a grant made before scopes were enforced resolves to the default ceiling until re-authorised.

## 6. Known gaps and unverified facts

- Access tokens carry no prefix; any bearer that is not `omr_pat_…`, `omr_s_…` or `omr_int_…` is looked up as OAuth.
