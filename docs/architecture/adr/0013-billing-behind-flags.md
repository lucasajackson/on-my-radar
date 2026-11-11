# ADR-0013: Billing, quotas and plan gates are built behind flags, and Stripe is read, not trusted

Status: Accepted · Date: 2026-10-02

**Superseded on 2026-11-11** (Lucas): On My Radar is open source and carries no billing. The code, routes, plan gates and the Stripe integration were deleted; the tables stay (ADR-0019). Kept as history; nothing below describes the code any more.

## Context

Paid plans are a commercial decision that is not finished, but the machinery has to be proven in production without changing anything for existing accounts.

## Decision

- `BILLING_ENABLED`, `BILLING_CHECKOUT_ENABLED`, `BILLING_QUOTAS_ENABLED` and `PLAN_FEATURE_GATES_ENABLED` all default to false. With billing off, checkout, the portal and the Stripe webhook answer 404 (the read routes stay live and report `enabled: false`); with the gates off entitlement checks are skipped.
- The plan catalog is versioned and immutable once published; a billing contract binds to one revision and is immutable by trigger.
- A Stripe webhook only triggers a reconciliation that re-reads subscriptions and invoice lines; the event payload is never the source of an allowance. Events are checked for signature, API version, mode and, when the event names one, account.
- A paid checkout persists its contract and idempotency key before calling Stripe; a redirect never grants an allowance. Payment never approves an account.

## Evidence

- `184ba3a` (2026-10-02) merged the billing, count-quota and storage foundations; `1cbeb90` (2026-10-03, merged `0a9fab5`) pinned the Stripe API version and restricted keys.
- `packages/server/src/services/billing.ts`, `packages/server/src/services/billing-contracts.ts`, `packages/server/src/services/billing.test.ts`, `packages/server/src/env.ts`.
- Refund, credit-note and dispute reconciliation was built and then removed (`5a482c9`, 2026-10-06); those events are now stored and ignored, and refunds are made by hand in Stripe.

## Consequences

- Good: the production code path exists and is exercised without effect.
- Cost: the `billing_financial_observations` table, a `financial_attention` column and their triggers remain with no writer. `ORDINARY_PLAN_TEMPLATES` excludes `architecture` and `helpdesk`, so enabling the gates with explicit terms would stop anyone creating those templates.
