# ADR-0018: Application secrets reach the pods through a secret store and ExternalSecret, and CI holds only registry credentials

Status: Accepted · Date: 2026-10-01

## Context

Secrets must not live in git, images or CI variables, and rotation should not need a code change.

## Decision

- New application credentials (GitLab read and mirror tokens, Stripe settings) are provisioned secret store to ExternalSecret to a Kubernetes secret, read by the pods as environment through `envFrom`. Never git, never GitLab CI/CD variables; the registry username and password are the only CI variables.
- The pods expect these secrets, by name: `onmyradar-postgres`, `onmyradar-app`, `onmyradar-minio`, `onmyradar-oidc`, `onmyradar-push`, `onmyradar-gitlab`, plus the registry pull secret.
- Every issued credential and token is stored as a hash, and outbound-webhook secrets are encrypted with a key derived from `SESSION_SECRET`.

## Evidence

- `8144402` (2026-10-01, merged `e3a4116`) states the rule in `docs/DEPLOY.md` for the GitLab tokens; `9f3b02c` (2026-10-02) repeats it for billing.
- `docs/DEPLOY.md` (the GitLab token section and the billing foundation section), `.gitlab-ci.yml` (variables).
- The first-install procedure in `docs/DEPLOY.md` section 5 still shows `kubectl create secret` literals for the older secrets. How production's older secrets are sourced today cannot be established from this repository.

## Consequences

- Good: a secret's lifecycle is the estate's, not the app's.
- Cost: this repository cannot prove which store a given secret comes from; the chart that mounts them is in the GitOps repository.
