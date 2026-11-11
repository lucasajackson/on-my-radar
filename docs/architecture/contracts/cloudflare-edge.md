# Contract: Cloudflare edge (DNS, tunnel, TLS)

Status: Draft · Version 1.0 · Owner (OMR side): M28 Release and deploy · Owner (other side): Cloudflare (the public hostname, a cloudflared tunnel to Traefik) · Provider ref verified against: `docs/ARCHITECTURE.md` at `2c4905d`

## 1. Scope

Cloudflare terminates the public hostname and forwards through a `cloudflared` tunnel to Traefik in the cluster. Both app origins answer `no-cache` and Cloudflare treats them as dynamic; `docs/ARCHITECTURE.md` says the chart sets `Vary: Cookie` on both `/` routes; that chart is outside this repository and was not verified. The UI image defaults to `no-cache` (`packages/ui/deploy/nginx.conf`) and the API sends `no-cache` for `index.html`.

## 2. Auth

The tunnel credential is the platform's. The app trusts the client address from `TRUSTED_IP_HEADER` (default `cf-connecting-ip`) for rate limits and request ids use `cf-ray`.

## 3. Operations

| Operation | Shape                         | Effect | Notes                                                                                       |
| --------- | ----------------------------- | ------ | ------------------------------------------------------------------------------------------- |
| Route     | hostname to tunnel to Traefik | —      | Path rules at Traefik split the marketing site, the API and the UI (`02-system-context.md`) |

## 4. Errors and refusals

- None recorded in this repository.

## 5. Idempotency, versioning and limits

- Pages `/r/<slug>` are served by the API so their metadata can come from the database.

## 6. Known gaps and unverified facts

- The tunnel and DNS configuration are outside this repository.
