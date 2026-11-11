# Scale load test

Drives the real app image, constrained like production, against a seeded local
Postgres and reports the pilot SLOs: about 50 humans, each with 1 to 3 agents
using the MCP server.

**It only ever talks to this machine.** The runner refuses any database or app
host that is not `localhost`, `127.0.0.1` or `host.docker.internal`, because it
drops and recreates its database every run. Every host the connection could resolve to
is checked, not only the URL's authority: `?host=`, `?hostaddr=`, `PGHOST`/`PGHOSTADDR`
and a socket directory all count, and a `service=`/`PGSERVICE` is refused outright
(`src/config.test.ts`). Never aim it at onmyradar.io or any shared database.

## What it does

1. Drops and recreates the `omr_loadtest` database; migrates it with the image
   under test (`node packages/server/dist/db/migrate.js`).
2. Seeds it with direct SQL (`src/seed.ts`): 50 users, 150 personal access
   tokens (3 each), 50 browser sessions, 20 radars shared with all 50 users
   (owner plus 49 editors), 50k blips (radar 0 is a 10k-blip kanban board),
   20k comments. Uses only tables on origin/main, so the same seed runs before and
   after a change.
3. Starts the app (and the outbox worker) with `--cpus=0.5 --memory=512m` and
   `DB_POOL_MAX=10`.
4. Runs `k6/scale.js` (see below), samples process RSS and Postgres connections,
   and counts deadlocks and duplicate blips (`nonce:` in the body, grouped).
5. Prints a markdown table and writes `results.md`, `results.json`,
   `k6-summary.json`, `k6.log`, `app.log` (and `fixtures.json`, which holds the
   throwaway tokens and must not be shared) into `--out`.

## k6 scenarios

- 150 agent VUs, one PAT each, looping `list_radars`, `read_radar` x3 pages
  (cursor pagination), `search_blips`, `create_blip` (30% to one hot radar, a
  unique `nonce:` in every body), `update_blip`, `create_comment`, over
  Streamable HTTP `POST /mcp`.
- 50 UI VUs polling `GET /api/notifications/counts` with a session cookie every
  5 s.
- 1 request/s to `/health/ready`, which must always answer 200.

A 429 is counted separately (`rate_limited`) and is not an error. Think time is
the mean pause after each call (`--think`, default 1500 ms, randomised 0.5x to
1.5x), which makes the default load about 100 requests/s.

## SLOs (k6 thresholds and the table)

read_radar p95 < 400 ms, search_blips p95 < 500 ms, list_radars p95 < 300 ms,
create_blip p95 < 300 ms, error rate < 0.5% (429s excluded), `/health/ready`
always 200, no deadlocks, no duplicate blips, peak RSS < 400 MiB.

## Running it

Prerequisites: docker, k6 (`brew install k6`), and a local Postgres 16 with
`max_connections=100` listening on all interfaces with trust auth for the
docker VM (e.g. `initdb -A trust`, `listen_addresses='*'`,
`host all all 0.0.0.0/0 trust` in `pg_hba.conf`; local scratch use only).

```sh
# Build the image under test the same way every time (the previous-UI stage is a
# registry image in the release build; a local stub is enough here).
docker build -t omr-loadtest-ui-stub - <<'DOCKERFILE'
FROM mirror.gcr.io/library/nginx:1.30.5-alpine
RUN mkdir -p /usr/share/nginx/html/assets && echo stub > /usr/share/nginx/html/index.html && echo // > /usr/share/nginx/html/assets/stub.js
DOCKERFILE
docker build --target runtime --build-arg PREVIOUS_UI_IMAGE=omr-loadtest-ui-stub -t omr-loadtest:after .

LOADTEST_PG_URL=postgres://postgres@localhost:55442/postgres \
  pnpm --filter @onmyradar/loadtest start --image omr-loadtest:after --label after --out /tmp/omr-lt-after
```

Flags: `--duration 5m`, `--think 1500`, `--agent-vus 150`, `--ui-vus 50`,
`--idempotency` (send `idempotencyKey` on create_blip/create_comment and replay 5%
of captures; a replay must not create a second blip), `--no-worker`,
`--cpus`, `--memory`, `--pool`, and repeatable `--env KEY=VALUE` for extra app
and worker settings (for example rate-limit tuning).

`pnpm --filter @onmyradar/loadtest seed` seeds an already migrated database by
itself (`LOADTEST_PG_URL`, optional `LOADTEST_OUT`).

## CI

`.gitlab/loadtest.yml` defines a `loadtest` job: manual on any pipeline, or
scheduled when the schedule sets `LOADTEST_SCHEDULE=1`. It is never a merge
gate (`allow_failure: true`, `needs: []`). It needs a runner that allows
docker-in-docker and runs everything inside the job.
