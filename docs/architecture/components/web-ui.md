# Component: M26 Web UI

Status: Draft · Version 0.1 · As built at `origin/main` 2c4905d

## 1. Responsibility

The single-page application: React 19, TanStack Router and Query, Tailwind 4 and Vite, with a Milkdown editor used only on Agent Repo surfaces. It is served by its own nginx deployment and by the API image as a fallback, and talks to `/api` on the same origin. The same component owns the browser verification suite (`packages/phone`), which drives the real app at 390x844 and at desktop widths.

**Depends on:** M24 (the API), M25 (schemas and functions), nginx.

**Used by:** People in browsers; the phone suite.

**Invariants (and what enforces each):**

- Same origin, cookie authentication: `request()` uses `fetch` with `credentials: 'same-origin'` and the base from the `omr-config` block the server injects (`packages/ui/src/lib/api.ts`, `lib/config.ts`). Uploads go straight to the presigned storage URL.
- The root service worker has no `fetch` listener: it handles push and notification clicks only, so it can never stall a request; account downloads use a second registration scoped to `/account-export-download/` (`packages/ui/public/sw.js`; `packages/ui/src/lib/service-worker.test.ts`). A root fetch listener shipped on 2026-10-04 stalled `/api/*` for for 1 to 27 seconds and was removed on 2026-10-06 (`316e18e`).
- The nginx image runs as a non-root user on port 8080: `/assets/` and the `/agent-setup/omr-plugin-*.zip` files are `immutable` for a year, `/favicon.svg` and `/robots.txt` get a day, everything else is `no-cache`; the config sets CSP `default-src 'self'` with `frame-ancestors 'none'`, HSTS, COOP and CORP same-origin, and `check-ui-serving.sh` asserts the CSP, nosniff, X-Frame-Options, Referrer-Policy and Cache-Control headers; `/health/live` reports the ui role (`packages/ui/deploy/nginx.conf`; `scripts/check-ui-serving.sh` in CI).
- A release keeps the previous release's assets and any seen within 30 days so old documents can still load (`scripts/prepare-ui-release.mjs`); sourcemaps are deleted in the Dockerfile.
- Email content renders in a sandboxed iframe with its own CSP (principle P13).
- The phone suite seeds a scratch database through the real API, refuses to touch `on-my-radar`, `onmyradar`, `postgres`, `template0` or `template1` (it refuses to drop them), exits non-zero on any failed check, and gates the production release (`packages/phone`).
- Component CSS is in `@layer components`, because unlayered component CSS beats Tailwind's layered utilities.

## 2. Owned data

| Owned                           | Kind | Notes                       |
| ------------------------------- | ---- | --------------------------- |
| `packages/ui/src`               | file | Application source          |
| `packages/ui/index.html`        | file | Shell                       |
| `packages/ui/public/sw.js`      | file | Service worker              |
| `packages/ui/deploy/nginx.conf` | file | Static server configuration |
| `packages/ui/package.json`      | file | Manifest                    |
| `packages/phone/src`            | file | Browser verification suite  |
| `packages/phone/package.json`   | file | Manifest                    |

## 3. Interface

- **Routing:** `packages/ui/src/router.tsx` (code-based, a pathless layout route guards the shell once; `/r/$slug` and `/login` sit outside it).
- **Phone frame:** a bottom tab bar (Boards, Radars, capture, Drop box, You), no title bar, screens that push and pop (`docs/DESIGN.md` section 16).
- **Commands:** `pnpm --filter @onmyradar/ui build`; `pnpm phone`.

## 4. Failure and degradation

- With the UI deployment absent, the API image serves the SPA as a fallback; `ui.enabled=false` reverts the ingress split with one chart value.

## 5. Known gaps and unverified facts

- `docs/DESIGN.md` section 16 says every route renders its own account guard; `router.tsx` has since moved to a layout route. Which paragraph is current was not settled.
