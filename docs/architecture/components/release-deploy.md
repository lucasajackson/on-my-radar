# Component: M28 Release and deploy

Status: Draft · Version 0.1 · As built at `origin/main` 2c4905d

## 1. Responsibility

How a merge to `main` becomes running software: the Dockerfile (targets `runtime` and `ui`), the GitLab CI gate, the release child pipeline that builds digest-pinned images and rolls them out, and the secrets and routing the chart expects. The chart itself lives in the chart directory of the GitOps repository, outside this repository.

**Depends on:** a container registry, Rancher Fleet, a secret store with External Secrets, Cloudflare, M26 (the UI image), M25 (built first).

**Used by:** Every deployment of OMR.

**Invariants (and what enforces each):**

- Four jobs gate a release and all must pass: `verify` (PostgreSQL 16: script tests, contract build, typecheck, lint with no warnings, format check, all tests, helpdesk suites again in America/New_York, build, email-worker build and runtime test, migrate twice, `pnpm audit --prod --audit-level=high`), `phone`, `ui-serving` (nginx 1.30.5) and `server-pg18` (migration-sensitive suites on PostgreSQL 18). `production-release` is a trigger that needs all four, runs on `main` when listed runtime paths change (the list does not include `scripts/prepare-ui-release.mjs` or `scripts/check-ui-serving.sh`), and uses `resource_group onmyradar-production` (`.gitlab-ci.yml`).
- The audit gate is meant to be fixed by bumping a dependency; one advisory (`GHSA-mrhx-c7xc-m3w5`) is already ignored in the root `package.json` `pnpm.auditConfig`.
- The release child pipeline (`.gitlab/release.yml`) has stages prepare, build, deploy, smoke. `prepare-release` refuses a stale main head and resolves the running UI digest; Kaniko builds `app` (`--target runtime`), `ui` and `ui-transition`; `deploy-release.sh` rolls the UI transition image, then the UI final image, then the API and worker, all pinned by digest; `check-release.mjs` smoke-tests.
- Fleet's `comparePatches` ignore the three image fields, which CI owns; nothing else in the chart is written by CI.
- The only secret CI variables are the registry credentials; the release scripts also read an optional non-secret `PREVIOUS_UI_IMAGE` (`.gitlab-ci.yml`, `prepare-release.sh`).
- The pods read these Kubernetes secrets as environment: `onmyradar-postgres` (`DATABASE_URL`), `onmyradar-app` (`SESSION_SECRET`, `RESEND_API_KEY`), `onmyradar-minio` (`S3_ACCESS_KEY`, `S3_SECRET_KEY`), `onmyradar-oidc`, `onmyradar-push` (VAPID), `onmyradar-gitlab` (`GITLAB_READ_TOKENS`, `GITLAB_MIRROR_TOKENS`) and the registry pull secret.
- Route split at Traefik, with explicit IngressRoute priorities, is described in `02-system-context.md`; the marketing site shares the hostname by path.

## 2. Owned data

| Owned                            | Kind      | Notes                                                                             |
| -------------------------------- | --------- | --------------------------------------------------------------------------------- |
| `Dockerfile`                     | file      | Image targets: base, deps, build, release-ui, runtime, ui-base, ui-transition, ui |
| `scripts/prepare-ui-release.mjs` | file      | UI asset retention merge                                                          |
| `scripts/check-ui-serving.sh`    | file      | nginx policy check                                                                |
| `chart (GitOps repository)`      | elsewhere | The chart (Fleet), in another repository                                          |

The release pipeline definitions, the release scripts and the deployment guide are private to the operator and are not part of this repository.

## 3. Interface

- **Runtime:** namespace `onmyradar` in the cluster; deployments `onmyradar` (port 3500), `onmyradar-ui` (port 8080) and `onmyradar-worker`; images `<registry>/on-my-radar/{app,ui}`; the database name, role and bucket are hyphenated `on-my-radar` outside Kubernetes and `onmyradar` inside it.
- **Health:** API `/health/live` and `/health/ready`, UI `/health/live`, worker `GET /health/live`.

## 4. Failure and degradation

- A feature-branch push pipeline is suppressed once a merge request exists; open one to run the full matrix.

## 5. Known gaps and unverified facts

- **The release scripts call `kubectl` under the runner's service account** (`prepare-release.sh` reads pods; `deploy-release.sh` runs `set image` and `rollout status`). The company standard says CI has no cluster access, and `docs/DEPLOY.md` says there is no cluster credential. The header of `.gitlab-ci.yml` says there is no git credential and describes the runner's service account Role as the intended pattern, so the contradiction is with the standard and `docs/DEPLOY.md`.
- The deployment guide predates the secret-store standard for some of its secrets; how production's older secrets are sourced is not established here (ADR-0018).
- Not verifiable from this repository: the chart's contents, the worker's argv, the API replica count, which secrets come from the secret store, and the Cloudflare tunnel and Email Routing configuration.
