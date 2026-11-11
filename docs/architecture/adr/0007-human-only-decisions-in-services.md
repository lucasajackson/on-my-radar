# ADR-0007: Human-only decisions are enforced in the service layer, and credentials and consent are session-only

Status: Accepted · Date: 2026-08-27

## Context

A ceiling that one call can raise is not a ceiling. Early on, the fences lived in the MCP tool router, which meant REST callers with the same token could cross them.

## Decision

- `assertHumanDecision(actor)` passes only when `actor.kind === 'user'`. It is called from the services for minting and revoking credentials (OAuth consent and invitations use route-level or `assertMayInvite` user-only checks instead), push device registration, billing, integrations, subscriptions, sharing to a new address, co-owners, the topic cascade, email capture settings and repo-agent management.
- OAuth consent, credential endpoints and administration are session-only, and consent is never auto-approved.
- The absence of an MCP tool is not the control: `agent-boundary.test.ts` walks the escalation chain at the service layer, which both transports share.
- Unknown input fails closed (principle P15): an unknown scope string grants nothing.
- What is not fenced: inbound webhook management. An agent holding `radars:manage` can create, update and rotate a radar webhook and is handed the one-time `secretUrl` (`services/webhooks.ts` calls `requireRadar(..., 'manage')` and no `assertHumanDecision`). Helpdesk portal replies are likewise not release-gated (`createHelpdeskReply`); owner release applies to comments written by staff, agents and collaborators.

## Evidence

- `b305512` (2026-08-27): "the fences move out of the tool router and into the services". Scopes enforced in `26ce1ce` the same day.
- `packages/server/src/services/access.ts` (`assertHumanDecision`), `packages/server/src/services/agent-boundary.test.ts`, `packages/server/src/services/scopes.test.ts`.

## Consequences

- Good: the rule holds for every transport added later.
- Cost: one open question is recorded in `components/mcp-server.md`: a session cookie or `omr_s_` bearer accepted on `/mcp` is a `user` and passes these fences.
