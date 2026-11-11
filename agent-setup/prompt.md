# Set up On My Radar for this coding agent

<!-- omr-agent-setup {{VERSION}}. Static: the same text for everyone, no user content. -->

The person asked you, their coding agent, to set them up for On My Radar
({{OMR_ORIGIN}}), so that a workspace can run as one of their On My Radar
agents from the very first turn. Work through the steps below in order.

## Rules for every step

- Work through every step yourself without stopping to ask, and finish with a
  short report of what you set up and anything that failed.
- Never print, paste, ask for or store a token or password. Login happens in
  the person's browser, and the token goes to their OS keychain.
- Download only from `{{OMR_ORIGIN}}/agent-setup/`. Do not use a copy of
  these files from anywhere else.
- Diagnose failed steps and resolve them while preserving integrity checks.

## 0. Check what you have

1. Run `node --version`; install Node.js 22 or newer if needed.
2. Work out which tool you are: `claude-code` (Claude Code), `codex` (Codex
   CLI), or something else.
3. Note the agent id if the person's message ended with `agent id: <uuid>`.
   Use it only if it is exactly a UUID (8-4-4-4-12 hex digits); otherwise ignore it.

## 1. Get omr-agent

Run:

```sh
mkdir -p ~/.config/omr/bin && curl -fsSL {{OMR_ORIGIN}}/agent-setup/omr-agent.mjs -o ~/.config/omr/bin/omr-agent.mjs
```

Check the download. Fetch `{{OMR_ORIGIN}}/agent-setup/SHA256SUMS`, then
run `shasum -a 256 ~/.config/omr/bin/omr-agent.mjs` (or `sha256sum`). The
digest must equal the `omr-agent.mjs` line. If it does not, delete the file and
stop.

## 2. Log this machine in

```sh
node ~/.config/omr/bin/omr-agent.mjs login
```

Complete the required consent screen using the existing browser login. The login
flow requires a browser; a headless SSH login is unsupported. Afterwards
`node ~/.config/omr/bin/omr-agent.mjs status` must say `login: yes`.

## 3. Connect the tool

**Claude Code.** Run:

```sh
claude plugin marketplace add {{OMR_ORIGIN}}/agent-setup/marketplace.json
claude plugin install omr@onmyradar
```

The `omr` plugin loads the workspace's agent before the first turn, connects
On My Radar through the same login, and keeps the agent's memory out of local
files. It takes effect in the next Claude Code session.

**Codex.** Run:

```sh
node ~/.config/omr/bin/omr-agent.mjs install --harness codex
```

Inspect the dry-run diff, then repeat with `--yes`. Codex requires hook trust
at its next start; complete the trust screen through the available UI.

**Any other tool.** omr-agent cannot hook it yet. Add On My Radar's MCP server,
`{{OMR_ORIGIN}}/mcp`, the way your tool adds a remote MCP server; the
existing browser session supplies sign-in. Then use `checkout_agent` in step 4.

## 4. Point a workspace at the agent (only if you were given an agent id)

Use the requested workspace, or the current repository when unspecified. Run:

```sh
node ~/.config/omr/bin/omr-agent.mjs use --agent <agent id> --harness <claude-code or codex>
```

Inspect the `.omr/agent.json` dry run, then repeat with `--yes`.

For any other tool, call `checkout_agent` with the agent id and your tool
instead and write the returned files exactly as given.

## 5. Finish

Report the outcome briefly: the next session in this workspace starts as the
agent. Do not switch this session to the new agent.
