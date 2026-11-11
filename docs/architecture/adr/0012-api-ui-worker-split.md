# ADR-0012: The API, the static UI and the worker are three deployments from two images behind one origin

Status: Accepted · Date: 2026-09-02

## Context

A native client and a growing worker load need the API to stand alone, with a versioned surface, while the web app stays one origin.

## Decision

- Three deployments: `onmyradar` (API, MCP, OAuth, hooks, the `/r/` page shell), `onmyradar-ui` (nginx serving the built SPA) and `onmyradar-worker` (the API image with a different entry point).
- The API mounts every `/api` router at `/api` and at `/api/v1` from one list; OAuth, MCP, hooks and health are mounted once, and the helpdesk router is `/api/v1` only. Native clients authenticate with a device session sent as a bearer token and receive no cookie.
- Traefik routes by path. `/r/` stays on the API because the public radar shell needs the database for its page metadata and must not confirm a private radar exists.
- Each of storage, mail, SSO, push, the worker and the UI deployment may be absent; `ui.enabled=false` reverts the ingress split with one chart value.

## Evidence

- `9026833` (2026-09-01) added `/api/v1` and device sessions; `9ac2e5d` (2026-09-02) added the UI image; `4ffaf8c` (2026-09-02) the worker.
- `docs/ARCHITECTURE.md` (the shape), `docs/SPLIT.md` (the series), `packages/ui/deploy/nginx.conf`, `Dockerfile` targets `runtime` and `ui`.
- That the worker's entry point is `dist/worker.js` is stated in `docs/ARCHITECTURE.md`; the chart that sets it is outside this repository.

## Consequences

- Good: the client contract is versioned and the UI cannot take the API down.
- Cost: UI and API releases must be ordered (the release pipeline rolls the UI first, then the API and worker).
