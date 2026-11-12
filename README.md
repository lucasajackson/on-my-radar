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
- **Sign-in**: no sign-in at all on your own machine, or a password, a six-digit code by email, or any OpenID Connect provider on a real host.

## Self-host

### Docker Compose, on your own machine

```bash
git clone https://github.com/lucasajackson/on-my-radar.git && cd on-my-radar
export SESSION_SECRET=$(openssl rand -hex 32)
docker compose up --build
```

Open <http://localhost:3500> and you are in: this is **single-user mode**, signed in as `SINGLE_USER_EMAIL` (default `me@example.com`, set it to your own) with no sign-in step. It is only allowed where the instance's own address is local (`localhost`, a private network address, `.local`, `.lan`, `.internal`); the app refuses to start otherwise, and answers any other `Host` with 421 so a hostile web page cannot reach it by DNS trickery. Use that address exactly: `http://127.0.0.1:3500` is a different name and gets 421, so to reach it another way set `PUBLIC_URL` to that address. Mail goes to the bundled Mailpit inbox at <http://localhost:8025>.

Two things to know. Any local process that can reach the port is you, including a coding agent with a shell, so keep the port on `127.0.0.1`. And `/mcp` is not open to the browser session: agents connect with a personal access token (Settings, Connections) or OAuth, as everywhere else.

### Docker Compose, on a real host

Put TLS in front (Caddy, nginx, a tunnel) and set, in the environment or an `.env` file next to `docker-compose.yml`:

- `SINGLE_USER_EMAIL=` (empty), which turns single-user mode off.
- `PUBLIC_URL=https://notes.example.com`.
- Mail, because sign-in codes and password resets are emailed: `MAIL_PROVIDER=smtp` and `SMTP_URL=smtp://user:password@smtp.example.com:587` (STARTTLS is required; `smtps://` works too). Also `MAIL_FROM`, an address your relay may send from: most reject the default `noreply@<your host>`. A relay with a private CA needs `NODE_EXTRA_CA_CERTS=/path/ca.pem` in the container.
- How people sign in: `PASSWORD_LOGIN_ENABLED=true` for email and password (12+ characters, reset by an emailed code; people with no password yet set one in Settings), and/or the `OIDC_*` group for a single sign-on provider. The emailed code always works too.
- `TRUSTED_IP_HEADER=x-real-ip`, with your proxy setting that header to the client's address. Sign-in limits are per network, and the default header (`cf-connecting-ip`) can be forged by anyone when you are not behind Cloudflare.
- `ADMIN_EMAILS` for the admin screen, and `SIGNUP_MODE=waitlist` if you do not want strangers creating accounts.

Password sign-in never creates an account; the first sign-in of a new person is the emailed code. Anyone can lock an address's password sign-in for a day by guessing wrongly 20 times; the code and SSO still work.

### Kubernetes (Helm)

A multi-arch (amd64 and arm64) image is published to `ghcr.io/lucasajackson/on-my-radar`: `edge` and `sha-<commit>` follow `main`, and each release tag publishes its version (`1.2.3`), `1.2` and `latest`. The Helm chart in [`charts/on-my-radar`](charts/on-my-radar) runs the app and the outbox worker, with an optional Ingress, and takes your own Postgres 16 (or a throwaway one with `postgres.enabled=true`, for trying it out):

```bash
helm install on-my-radar oci://ghcr.io/lucasajackson/charts/on-my-radar \
  --namespace on-my-radar --create-namespace \
  --set publicUrl=https://notes.example.com \
  --set secrets.sessionSecret=$(openssl rand -hex 32) \
  --set postgres.enabled=true --set postgres.password=$(openssl rand -hex 16) \
  --set ingress.enabled=true
```

`publicUrl` is required and cannot move later. The chart does not offer single-user mode, so set up sign-in as for a real host above: mail, and optionally passwords or SSO. Your ingress has to set the client-address header (`trustedIpHeader`, default `x-real-ip`) and overwrite whatever the client sent. For real use, keep secrets in a Secret of your own (`existingSecret`) rather than in values. Every value is in the chart's [README](charts/on-my-radar/README.md).

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

Every environment variable is documented in [`.env.example`](.env.example) and validated at boot by `packages/server/src/env.ts`. The ones you will reach for first: `DATABASE_URL`, `SESSION_SECRET`, `PUBLIC_URL`, `MAIL_PROVIDER` (`resend`, `smtp` or `console`), `SIGNUP_MODE`, `ADMIN_EMAILS`, `SINGLE_USER_EMAIL`, `PASSWORD_LOGIN_ENABLED`, the `S3_*` group for attachments (any S3-compatible store) and the `OIDC_*` group for single sign-on.

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
