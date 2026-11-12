# syntax=docker/dockerfile:1.7
# On My Radar — API/worker and static UI images from one release build. Secrets are never baked in; they arrive via envFrom at runtime.

# A release keeps the preceding release's assets, so rolling updates cannot strand an
# old shell. A deployment that has a running UI image passes it as PREVIOUS_UI_IMAGE (an
# empty or unreadable value fails the build rather than dropping the predecessor); a
# first or local build gets this empty stage and starts from the current bundle alone.
ARG PREVIOUS_UI_IMAGE=no-previous-ui
FROM scratch AS no-previous-ui
WORKDIR /usr/share/nginx/html
FROM ${PREVIOUS_UI_IMAGE} AS previous-ui

FROM mirror.gcr.io/library/node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# ---- deps ------------------------------------------------------------------
# Manifests only, so a source-only change reuses the install layer.
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/contract/package.json packages/contract/
COPY packages/server/package.json packages/server/
COPY packages/ui/package.json packages/ui/
# The phone suite is never in the runtime image, but it IS a workspace
# package: omit its manifest and `--frozen-lockfile` rejects the install,
# because the lockfile then carries an importer that is not on disk.
COPY packages/phone/package.json packages/phone/
# Same reason for the load test: a workspace importer the lockfile names must be on disk.
COPY packages/loadtest/package.json packages/loadtest/
COPY packages/email-worker/package.json packages/email-worker/
# An enterprise-edition workspace manifest, when that directory exists. The glob's parent is
# itself a wildcard, so it matches nothing (and copies nothing) in a community checkout, which
# installs without it.
COPY ee*/server/package.json /tmp/ee-manifest/
RUN if [ -f /tmp/ee-manifest/package.json ]; then mkdir -p ee/server && mv /tmp/ee-manifest/package.json ee/server/; fi
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# ---- build -----------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages ./packages
# The UI build also builds <OMR_PUBLIC_URL>/agent-setup/ (plugin zip, marketplace.json,
# omr-agent.mjs, prompt.md) from here, stamped with that origin, for the nginx image; none of
# it is committed. The runtime image ignores that copy and stamps from PUBLIC_URL at runtime.
COPY agent-setup ./agent-setup
ARG OMR_PUBLIC_URL=http://localhost:3500
RUN pnpm --filter @onmyradar/contract build \
 && pnpm --filter @onmyradar/server build \
 && pnpm --filter @onmyradar/ui build \
 # Sourcemaps stay a local-build artifact. Shipped, they sit under /assets/*
 # with a year-long immutable cache and hand the un-minified client source to
 # anyone who asks — a size and disclosure cost with no production benefit.
 && find packages/ui/dist -name '*.map' -delete \
 && pnpm --filter @onmyradar/server --prod deploy /out/server \
 && ([ -d /out/server/dist ] || cp -r packages/server/dist /out/server/dist) \
 && rm -rf /out/server/drizzle \
 && cp -r packages/server/drizzle /out/server/drizzle \
 && rm -rf /out/server/src

# The API public shell and nginx receive the same current bundle, together with
# the preceding release's assets so rolling updates cannot strand an old shell.
FROM build AS release-ui
COPY scripts/prepare-ui-release.mjs /app/prepare-ui-release.mjs
COPY --from=previous-ui /usr/share/nginx/html /previous-ui
ARG ONMYRADAR_BUILD_SHA=""
RUN node /app/prepare-ui-release.mjs packages/ui/dist /previous-ui /release-ui "$ONMYRADAR_BUILD_SHA" /transition-ui

# ---- runtime ---------------------------------------------------------------
FROM mirror.gcr.io/library/node:22-alpine AS runtime
RUN apk add --no-cache dumb-init curl \
 && addgroup -S -g 10001 onmyradar \
 && adduser -S -u 10001 -G onmyradar -h /app onmyradar
WORKDIR /app
ENV NODE_ENV=production PORT=3500 UI_DIST_DIR=/app/packages/ui/dist
# The server with its production node_modules, its migrations, and the SPA bundle.
COPY --from=build --chown=onmyradar:onmyradar /out/server /app/packages/server
COPY --from=release-ui --chown=onmyradar:onmyradar /release-ui /app/packages/ui/dist
# The agent-setup source: the server stamps /agent-setup/ from the runtime PUBLIC_URL (the
# bundle's copy above is stamped for OMR_PUBLIC_URL, which a shared image cannot know).
COPY --from=build --chown=onmyradar:onmyradar /app/agent-setup /app/agent-setup
ENV AGENT_SETUP_SRC=/app/agent-setup
USER onmyradar
EXPOSE 3500
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/health/live || exit 1

# ---- build identity: below every layer, and it must stay there -------------
# The git SHA this image was built from, reported verbatim on /health/live so an
# unauthenticated prober can prove which build is running.
#
# It is declared after the expensive build/COPY layers deliberately: an ARG joins the cache
# key of every instruction below it, so a per-commit value declared earlier would
# miss the Kaniko cache on every single build.
#
# It is never supplied by the chart either — a version injected at deploy time
# reports what the deployer intended, not what is actually running.
ARG ONMYRADAR_BUILD_SHA=""
ENV ONMYRADAR_BUILD_SHA=$ONMYRADAR_BUILD_SHA
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "packages/server/dist/index.js"]

# ---- ui --------------------------------------------------------------------
# The web client as a static image of its own -- SCALE.md's split by runtime
# shape reaching the front end. Same build stage, so the bundle in this image
# is byte-identical to the one the API image carries as its fallback.
FROM mirror.gcr.io/library/nginx:1.30.5-alpine AS ui-base
# The full config, replacing stock: the container runs non-root, so pid and
# temp paths live in /tmp (see the conf's header).
COPY --chmod=644 packages/ui/deploy/nginx.conf /etc/nginx/nginx.conf
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/health/live || exit 1

# Phase one publishes old documents with both asset generations. Phase two may
# then expose new documents even while nginx pods overlap during the rollout.
FROM ui-base AS ui-transition
COPY --from=release-ui --chown=nginx:nginx /transition-ui /usr/share/nginx/html

FROM ui-base AS ui
COPY --from=release-ui --chown=nginx:nginx /release-ui /usr/share/nginx/html
