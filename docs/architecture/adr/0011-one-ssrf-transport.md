# ADR-0011: Every fetch of a user-chosen URL goes through one vetted transport

Status: Accepted · Date: 2026-09-19

## Context

Link previews, feeds, webhooks and push endpoints all make the server request an address someone else chose. Each is a server-side request forgery surface.

## Decision

- `services/public-request.ts` (`publicRequest`, `vetPublicUrl`) resolves DNS once, rejects private, loopback, link-local, carrier-grade and translation ranges (IPv4 and IPv6), connects to the vetted address through a pinned lookup and makes one request per call. It never follows redirects: `unfurl` and the feed fetcher walk them (at most 3 hops) and re-vet each hop. NAT64 and 6to4 addresses are accepted only when the embedded IPv4 address is public; `64:ff9b:1::/48` and Teredo are refused outright.
- Callers: link preview (`unfurl.ts`), Web Push (`push.ts`), outbound subscriptions, integration delivery and feeds. Subscriptions, integration receivers and feeds are also vetted when saved.
- Outbound subscriptions and Web Push send only over HTTPS and follow no redirects; feeds follow at most three hops, each re-vetted.
- Calls to fixed or configured hosts (the OIDC issuer, Stripe, GitLab, Resend) use plain `fetch` and are out of scope.

## Evidence

- Address pinning first landed for link previews in `2e248a0` (2026-08-27). `da70f2e` (2026-09-19) created the shared `public-request.ts`; `88cdbc3` and `4d6c29f` (2026-09-26) tightened vetting and refuse private URLs at save time.
- `packages/server/src/services/unfurl.test.ts` (pinning and redirect re-vetting), `packages/server/src/services/rss.test.ts`.
- Older internal briefs say `unfurl.ts` is the only outbound fetch of a user URL. That is not true of the code.

## Consequences

- Good: one place to harden.
- Cost: unfurl allows plain HTTP and any port; that is a deliberate looseness of the preview path, not of the transport.
