# ADR-0019: Code that is flag-off and unused is deleted; its tables and triggers stay

Status: Accepted · Date: 2026-10-06

## Context

Storage ledger and lifecycle tooling, billing sandbox attestation, account closure requests and refund reconciliation were built behind flags and never enabled. They were carrying review and test cost with no users.

## Decision

- The application code, routes, MCP tools and tests for those features were removed. The tables, constraints and triggers from applied migrations remain, because migrations are forward-only.
- What remains is not dead: `storage_objects` is still read by the account export and by the `omr_storage_reference_fence` trigger on `attachments`, `blip_emails` and `email_capture_receipts`; the account-closure fence functions are enforced across about 50 tables.
- Nothing writes `storage_objects`, `storage_protocols`, `storage_inventory_*`, `storage_migration_bindings`, `account_closure_requests`, `account_closure_challenges` or `billing_financial_observations`, so their guards cannot currently fire. No application path closes an account today.

## Evidence

- `2596b1d` (storage ledger and lifecycle), `b33f1d4` (storage migration and verification), `b86c834` (account closure requests), `3615b3e` (sandbox attestation), `5a482c9` (refund, credit-note and dispute reconciliation), all 2026-10-06.
- `docs/DESIGN.md` sections "Account access closure is a lifecycle fence" and "Billing foundation" record what remained.

## Consequences

- Good: the code base only carries what runs.
- Cost: the schema carries tables with no writer, and anyone adding a writer must first read the triggers that already guard them.
