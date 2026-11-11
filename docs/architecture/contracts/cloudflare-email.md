# Contract: Cloudflare Email Routing (catch-all to the relay Worker)

Status: Draft · Version 1.0 · Owner (OMR side): M14 Email relay · Owner (other side): Cloudflare Email Routing (the root zone's catch-all rule and MX records) · Provider ref verified against: `packages/email-worker/wrangler.jsonc` and `docs/ARCHITECTURE.md`

## 1. Scope

Cloudflare delivers each message addressed to the capture domain to the Worker `onmyradar-email-capture`. Plus-addresses are supported.

## 2. Auth

Cloudflare invokes the Worker; no credential is exchanged in this direction.

## 3. Operations

| Operation | Shape                 | Effect | Notes                                                |
| --------- | --------------------- | ------ | ---------------------------------------------------- |
| Deliver   | Email Routing handler | —      | The Worker rejects a message over 10 MiB at the edge |

## 4. Errors and refusals

- The Worker throws on a retryable API answer, so Cloudflare retries or bounces.

## 5. Idempotency, versioning and limits

- The Workers Free plan CPU allowance is why parsing runs in Kubernetes.

## 6. Known gaps and unverified facts

- The catch-all rule and MX records are outside the repository; `docs/ARCHITECTURE.md` records them as activated and verified on 2026-09-19.
