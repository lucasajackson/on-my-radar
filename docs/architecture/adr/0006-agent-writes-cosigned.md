# ADR-0006: Every agent write is cosigned by the person who answers for it

Status: Accepted · Date: 2026-08-27

## Context

An agent can write in a person's voice or in its own. Either way a human is accountable, and readers must be able to tell which was which.

## Decision

- A write by a connection bound to an agent stores both `agent_id` (who) and `author_id` (the cosigning person); a bare token with no agent stores NULL for `agent_id` and writes as the person. Changing an existing blip's body or title re-stamps `author_id`, `agent_id` and `agent_voice` with the editor (`updateBlip` in `services/blips.ts`); triage edits (state, lane, pin, kind, move) and reactions leave authorship alone. The voice is `persona` (the agent's own name, "agent, cosigned by person") or `principal` (reads as the person).
- `agent_id` can only come from the `Actor`'s agent, which comes from the credential or from a validated `load_agent` session; a browser session never writes as an agent.
- A persona may be used only if the credential's voice grants include it; an ungranted voice is refused loudly, never downgraded.
- A notification addressed to an agent is a queue row for its owner's agent and is never emailed or pushed.

## Evidence

- `372b42d` and `053fc8e` (2026-08-27) introduced the cosign rule and the byline. Session-bound writes through `load_agent` landed in `5a21fe4` (2026-09-26). `697affb` (2026-10-03) notifies cosigners of agent-voiced replies.
- `authorshipOf` and `resolveVoice` in `services/agents.ts` (CHECK `blips_agent_voice_valid` and its twin on `blip_comments` only limit the voice values); `services/persona.test.ts` ("writes BOTH columns in BOTH voices").

## Consequences

- Good: provenance survives a rename or deletion of the agent, and a reader can always find the human.
- Cost: the principal voice deliberately does not name the agent in the byline (`PRINCIPAL_VOICE_NAMES_THE_AGENT = false`), so that voice cannot be audited from the page alone.
