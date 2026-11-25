# syntax=docker/dockerfile:1
# Production image of the Studio web app (Issue #132; docs/engineering/deployment.md). Build from
# the repository root:
#   docker build -f apps/web/Dockerfile -t <registry>/agentic-studio-web:<tag> .
#
# - Base image pinned by digest (Node.js = the version CI uses).
# - `pnpm install --frozen-lockfile` with dependency install scripts limited as in CI
#   (pnpm-workspace.yaml `allowBuilds`).
# - Next.js's standalone output: the final stage holds only the server bundle and the production
#   dependencies it traced, runs as the fixed non-root uid 10001 (never the agent user's uid) and
#   gets no secret, at build or run time.
# - No /api rewrite in this build (STUDIO_WEB_API_PROXY unset): the reverse proxy routes /api to
#   the API itself (deploy/Caddyfile), so the API sees the proxy as the client's only hop.

ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm \
  PATH=/pnpm:$PATH \
  CI=true \
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --store-dir /pnpm/store --filter "@agentic-studio/web..."
RUN pnpm --filter "@agentic-studio/agent-definitions..." run build \
  && STUDIO_WEB_STANDALONE=true pnpm --filter @agentic-studio/web run build

FROM ${NODE_IMAGE} AS runtime
RUN groupadd --gid 10001 studio \
  && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin studio
# HOSTNAME: the standalone server binds to it, and Docker sets it to the container's name.
ENV NODE_ENV=production \
  NEXT_TELEMETRY_DISABLED=1 \
  HOSTNAME=0.0.0.0 \
  PORT=3000
WORKDIR /app
# Root-owned and read-only for the web app's uid; only Next.js's cache directory is writable
# (a tmpfs in deploy/compose.server.app.yaml, as the root filesystem is read-only there).
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
RUN install -d -o 10001 -g 10001 -m 0700 /app/apps/web/.next/cache
USER 10001:10001
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
