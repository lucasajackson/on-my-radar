# ADR-0017: Client-facing radars are never public, and a staff or agent reply reaches the client only when the owner releases it

Status: Accepted · Date: 2026-10-02

## Context

The helpdesk template is the first radar a customer's request lives in. An agent or a teammate can draft an answer that must not leak by mistake.

## Decision

- A helpdesk radar can never be public, and once a radar has been client-facing it can never be public (CHECKs `radars_helpdesk_is_never_public` and `radars_once_client_facing_never_public`).
- Comment visibility is `internal`, `client_pending` or `client`. A comment written by staff, an agent or a collaborator reaches `client` only in one of two ways: the radar owner in person writes it as `client`, or the owner later releases a `client_pending` one with a signed-in `user` actor (the check is `assertHumanDecision` plus owner, not a browser-only check, so an `omr_s_` bearer also qualifies) with the SHA-256 of the body they saw (`decideVisibility`, `releaseComment`). SQL then refuses to change a released body, and requires a `client` comment to carry either a release record or an external author (`blip_comments_client_was_released`).
- The portal's own replies are the exception: `createHelpdeskReply` inserts `visibility = 'client'` at once with `author_id` NULL and an `external_author`, because they are the client's words, not staff text.
- The portal's credential reaches `/api/v1/helpdesk` only and sees a whitelisted projection; a cross-account request is a 404 identical to a missing one.
- Client-supplied text is fenced at MCP result boundaries as data. The fence is a hint; the control is that staff and agent text does not become client-visible without the owner.

## Evidence

- `ef935b3` and `db52b3f` (2026-10-02, merged `2c569cf`); integration credentials and the portal API followed in the same series (merged `39508f1`, `461b0f4`).
- `packages/server/src/services/comments.ts` (`decideVisibility`, `releaseComment`), `packages/server/src/services/helpdesk-projection.ts`, `packages/server/src/services/comment-visibility.test.ts`, `packages/server/src/services/helpdesk-integration.test.ts`.
- `docs/HELPDESK.md` is the engineer reference. It states the portal side is not built.

## Consequences

- Good: a mistake by a teammate or a PAT or OAuth agent cannot publish to a customer. The owner's own session, used through `/mcp`, publishes at once.
- Cost: every client-visible reply needs a human step.
