# Contract: Agent harness workspaces (checkout pointer files)

Status: Draft · Version 1.0 · Owner (OMR side): M21 Agents · Owner (other side): Agent harness workspaces (a developer's checkout read by Claude Code, Codex, Cursor, Gemini CLI, Copilot and others) · Provider ref verified against: `packages/contract/src/checkout.ts` and `agent-checkout.test.ts` at `2c4905d`

## 1. Scope

The files that `checkout_agent` tells a harness to write into a workspace so that the harness calls `load_agent` at session start. The pointer files carry a slug, an id and the MCP URL, never a credential. When the caller asks for `snapshot: true`, the checkout also writes the prompt, memories and briefs into a gitignored `.omr/snapshot/<slug>/` for offline reading.

## 2. Auth

None: the contract is files. The harness reaches OMR through its own MCP connection (`contracts/mcp-tools.md`).

## 3. Operations

| Operation             | Shape                                                                                  | Effect      | Notes                                             |
| --------------------- | -------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------- |
| claude-code           | `.omr/agent.json`, `.omr/AGENT.md`, and an ensure-line `@.omr/AGENT.md` in `CLAUDE.md` | file writes | Every operation that carries content has a sha256 |
| gemini-cli            | the same pattern with `GEMINI.md`                                                      | file writes |                                                   |
| codex, copilot, other | an upsert block in `AGENTS.md`                                                         | file writes |                                                   |
| cursor                | `.cursor/rules/omr-agent.mdc`                                                          | file writes |                                                   |

## 4. Errors and refusals

- A non-owner's checkout has widening values stripped (in `services/repo-agents.ts`, not in the pure generator). An unsafe slug or id is refused (`assertSafeIdentity`).

## 5. Idempotency, versioning and limits

- Output is deterministic and idempotent; `agent-checkout.test.ts` holds a golden file per harness and asserts that no credential pattern appears, and that primary-mode pointer files carry the description but no prompt body. Its separate snapshot test confirms that the prompt and memory files are written when asked.

## 6. Known gaps and unverified facts

- Memories are not written to disk unless the caller asks for a snapshot; the pointer file says to call `load_agent` and pass the returned `session` to every write.
