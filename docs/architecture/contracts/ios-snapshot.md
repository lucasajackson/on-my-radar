# Contract: iOS contract snapshot

Status: Draft · Version 1.0 · Owner (OMR side): M25 Contract package · Owner (other side): M27 iOS client · Provider ref verified against: `packages/contract/src/snapshot.ts` at `2c4905d`; the iOS repository HEAD `9ca337f` (2026-10-29)

## 1. Scope

A deterministic JSON file of the contract's registries and behaviour vectors, generated here and vendored by the iOS repository as `contract/contract-snapshot.json`, so Swift can test that its mirror has not drifted.

## 2. Auth

None.

## 3. Operations

| Operation | Shape                                                                  | Effect                                                              | Notes                      |
| --------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------- |
| Generate  | `pnpm --filter @onmyradar/contract snapshot`                           | prints JSON to stdout (redirect it into the iOS repo's vendor file) | Sorted and deterministic   |
| Verify    | `swift test --package-path Packages/OMRContract` in the iOS repository | —                                                                   | The drift test lives there |

## 4. Errors and refusals

- The server-side test (`packages/contract/test/snapshot.test.mjs`) asserts the snapshot format version, that `blipKinds` includes `link`, non-empty inference, triage, availability and normalisation vectors, and byte-identical output across two runs.

## 5. Idempotency, versioning and limits

- The iOS copy changes when a developer regenerates and commits it; nothing in this repository fails when it is stale.

## 6. Known gaps and unverified facts

- Whether the vendored copy matches `2c4905d` was not checked.
