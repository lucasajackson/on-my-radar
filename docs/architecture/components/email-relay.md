# Component: M14 Email relay

Status: Draft · Version 0.1 · As built at `origin/main` 2c4905d

## 1. Responsibility

A small Cloudflare Worker, `onmyradar-email-capture`, bound to Email Routing's catch-all for the root zone. It streams each message's original bytes to the API, signed. It does not parse mail and has no access to storage; it exists because the original design (parsing at the edge) exceeded the Workers Free CPU allowance.

**Depends on:** M13 (the endpoint it calls), Cloudflare Email Routing.

**Used by:** Cloudflare Email Routing invokes it.

**Invariants (and what enforces each):**

- A message over 10 MiB is rejected at the edge. The request is signed with HMAC-SHA256 over `timestamp, nonce, recipient, rawSize` and streams the raw bytes with `redirect: 'manual'` and a 25 second timeout (`packages/email-worker/src/index.mjs`, `signing.mjs`; `relay.test.mjs`).
- It maps the API's `x-omr-email-result` header to accept, permanent reject or retry (see M13).
- The shared secret is configured on the Worker, not in the repository (`wrangler.jsonc` holds `API_ORIGIN`).

## 2. Owned data

| Owned                                      | Kind | Notes                                       |
| ------------------------------------------ | ---- | ------------------------------------------- |
| `packages/email-worker/src/index.mjs`      | file | The Worker                                  |
| `packages/email-worker/src/signing.mjs`    | file | Request signing                             |
| `packages/email-worker/src/relay.test.mjs` | file | Relay tests                                 |
| `packages/email-worker/wrangler.jsonc`     | file | Worker configuration                        |
| `packages/email-worker/README.md`          | file | Activation status, limits, secret ownership |

## 3. Interface

- **Inbound:** a Cloudflare Email Routing invocation. **Outbound:** `POST <API_ORIGIN>/hooks/email-capture/raw`.
- `packages/email-worker/scripts/runtime-test.mjs` runs the Worker in workerd.

## 4. Failure and degradation

- If the API refuses or is down, the relay throws and Cloudflare retries or bounces.

## 5. Known gaps and unverified facts

- Whether the Worker is currently deployed and bound is recorded in `docs/ARCHITECTURE.md` (activated and verified on 2026-09-19) and cannot be checked from the repository.
