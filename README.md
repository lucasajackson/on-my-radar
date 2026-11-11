# On My Radar

Drop your thoughts somewhere. Sort them out later.

On My Radar is a capture tool. A **blip** is anything you want out of your head: a sentence, a link, a photo, a half-formed idea, a whole essay. A **radar** is a container for blips about one thing. An **array** groups related radars. A **dashboard** is a tab holding several radars side by side.

It also speaks **MCP**, so you can point an AI agent at a radar and say _"read this and start building what's in it."_

## Features

- **Capture**: one always-focused box. `#hashtags` become tags, a bare URL becomes a link with a preview, a long body becomes an essay, dropped or pasted files become attachments.
- **Triage**: every blip starts in _Inbox_; move it to _Active_, _Later_, _Done_ or _Dropped_. Filter by state, tag or full-text search.
- **Radars and templates**: a stream, a Kanban board, a microblog, a reading list or a decision log. Smart radars are saved tag searches that gather from everywhere.
- **Drop box**: one radar per account for things with no home yet.
- **Sharing**: share a radar by email (viewer or editor) or publish it at an unguessable read-only URL.
- **Dashboards**: tabs of radars you drag and resize.
- **Webhooks, RSS and email capture**: anything that can POST, publish a feed or send an email becomes a blip. Outbound webhooks tell your own systems what changed.
- **Agents**: an MCP server at `/mcp` with OAuth for remote clients and personal access tokens for local ones. The Agent Repo keeps each agent's prompt, memory and briefs in On My Radar, so it follows you to any device and tool.
- **Sign-in**: a six-digit code by email, or any OpenID Connect provider.

## Self-host

### Docker Compose

```bash
git clone https://github.com/lucasajackson/on-my-radar.git && cd on-my-radar
export SESSION_SECRET=$(openssl rand -hex 32)
docker compose up --build
```

Open <http://localhost:3500>. Enter any email address, then read the six-digit sign-in code in the bundled Mailpit inbox at <http://localhost:8025>; no mail account is needed. Set `ADMIN_EMAILS=you@example.com` first to get the admin screen. The compose file is for trying it out on one machine; read its header before exposing it to a network.

### From source

You need Node 22, pnpm 9 and Postgres 16.

```bash
pnpm install
cp .env.example .env     # set DATABASE_URL and SESSION_SECRET
pnpm migrate
pnpm dev                 # API on :3500, UI on :5273
```

In development, with no mail provider set, the sign-in code is shown on the login screen.

### Configuration

Every environment variable is documented in [`.env.example`](.env.example) and validated at boot by `packages/server/src/env.ts`. The ones you will reach for first: `DATABASE_URL`, `SESSION_SECRET`, `PUBLIC_URL`, `MAIL_PROVIDER` (`resend`, `smtp` or `console`), `SIGNUP_MODE`, `ADMIN_EMAILS`, the `S3_*` group for attachments (any S3-compatible store) and the `OIDC_*` group for single sign-on.

## Documentation

- [`docs/DESIGN.md`](docs/DESIGN.md): why the pieces are arranged the way they are.
- [`docs/MCP.md`](docs/MCP.md): connecting an agent.
- [`docs/TEMPLATES.md`](docs/TEMPLATES.md): radar templates, and what it costs to add one.
- [`docs/AGENT_REPO.md`](docs/AGENT_REPO.md) and [`docs/PERSONA.md`](docs/PERSONA.md): agents, memory and how they act on your behalf.
- [`docs/architecture/`](docs/architecture): the architecture pack.

## Stack

TypeScript throughout. Node 22 and a pnpm workspace: `packages/contract` (shared schemas and text helpers), `packages/server` (Hono, Drizzle, Postgres, MCP, OAuth), `packages/ui` (React 19, TanStack Router and Query, Tailwind 4, Vite), `packages/email-worker` (inbound email) and `packages/phone` (a phone-viewport layout suite).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## Licence

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
