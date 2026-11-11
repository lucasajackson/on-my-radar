# Contributing

Thanks for helping. Bug reports, fixes and small focused features are welcome; for anything larger, open an issue first so we can agree on the shape before you write it.

## Sign your commits (DCO)

Every commit needs a `Signed-off-by` line, which certifies the [Developer Certificate of Origin](https://developercertificate.org/): you wrote the change, or have the right to submit it under the Apache-2.0 licence. Add it with:

```bash
git commit -s -m "Fix the thing"
```

## Dev setup

You need Node 22, pnpm 9 and Postgres 16 (`docker run -d -p 5432:5432 -e POSTGRES_USER=onmyradar -e POSTGRES_PASSWORD=onmyradar -e POSTGRES_DB=on-my-radar postgres:16-alpine` is enough).

```bash
pnpm install
cp .env.example .env          # set DATABASE_URL and SESSION_SECRET
pnpm migrate
pnpm dev                      # API on :3500, UI on :5273
```

With no mail provider set, the sign-in code appears on the login screen.

## Before you open a pull request

CI runs all of these; run them locally first.

```bash
pnpm --filter @onmyradar/contract build   # the server and UI resolve its dist
pnpm typecheck
pnpm lint
pnpm format:check                         # pnpm format fixes it
DATABASE_URL=postgres://onmyradar:onmyradar@localhost:5432/on-my-radar \
  SESSION_SECRET=$(openssl rand -hex 32) pnpm test
pnpm build
```

Database-backed suites run only when `DATABASE_URL` is set, and each creates and drops a database of its own. `pnpm phone` runs the phone-layout suite and needs Chrome (see `docs/PHONE.md`).

## Style

- Keep changes small and tested. A bug fix comes with the test that fails without it.
- Schema changes are forward-only SQL files in `packages/server/drizzle/`, never edits to an old one.
- Shared request and response shapes live in `packages/contract`, not in the server or the UI.

## Conduct

Be kind. This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
