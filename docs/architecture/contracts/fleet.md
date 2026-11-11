# Contract: Rancher Fleet (GitOps rollout)

Status: Draft · Version 1.0 · Owner (OMR side): M28 Release and deploy · Owner (other side): Rancher Fleet in the cluster (reconciling the chart directory of the GitOps repository) · Provider ref verified against: `docs/ARCHITECTURE.md`, `docs/DEPLOY.md` and `scripts/deploy-release.sh` at `2c4905d`

## 1. Scope

The chart in the GitOps repository is reconciled by Fleet. Release CI changes only the three image fields, and Fleet's `comparePatches` (see `docs/DEPLOY.md`) ignore those fields so a release is not reverted.

## 2. Auth

Fleet pulls from Git. The release scripts use the CI runner's own service account to run `kubectl` against the cluster.

## 3. Operations

| Operation  | Shape                                                     | Effect     | Notes                                                           |
| ---------- | --------------------------------------------------------- | ---------- | --------------------------------------------------------------- |
| Set images | `kubectl set image` on the UI, API and worker deployments | reversible | Order: UI transition image, UI final image, then API and worker |
| Wait       | `kubectl rollout status`                                  | read       |                                                                 |
| Smoke      | `scripts/check-release.mjs`                               | read       | Run after rollout                                               |

## 4. Errors and refusals

- A rollout that does not complete fails the pipeline (`kubectl rollout status` is a pipeline step).

## 5. Idempotency, versioning and limits

- UI rollout has two phases (old documents plus both asset generations, then new documents); API and worker follow once every UI pod can serve the new shell's assets.

## 6. Known gaps and unverified facts

- This contradicts the company standard that CI has no cluster access and `docs/DEPLOY.md`; the `.gitlab-ci.yml` header describes the runner's in-cluster service account as the intended pattern (see `components/release-deploy.md`).
- The chart's contents were not read.
