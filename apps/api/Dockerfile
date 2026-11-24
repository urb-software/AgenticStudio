# syntax=docker/dockerfile:1
# Production image of the Studio API (Issue #132; docs/engineering/deployment.md). Build from the
# repository root:
#   docker build -f apps/api/Dockerfile -t <registry>/agentic-studio-api:<tag> .
# The same image runs the one-off `migrate` service (`prisma migrate deploy`, what
# `pnpm db:migrate:deploy` runs) before the API starts (deploy/compose.server.app.yaml).
#
# - Base image pinned by digest (Node.js = the version CI uses).
# - `pnpm install --frozen-lockfile` with dependency install scripts limited as in CI: only the
#   packages allowed in pnpm-workspace.yaml (`allowBuilds`: Prisma's engines) run theirs.
# - The final stage has production dependencies only, runs as the fixed non-root uid 10001 (never
#   the agent user's uid) and gets no secret: configuration comes from the environment at run time
#   (.dockerignore keeps every .env file out of the build context).

ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c

FROM ${NODE_IMAGE} AS base
# openssl: Prisma's schema engine (migrations) links against it and its installer detects it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*
# pnpm at the version of package.json's packageManager, through corepack.
ENV PNPM_HOME=/pnpm \
  PATH=/pnpm:$PATH \
  CI=true \
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  CHECKPOINT_DISABLE=1 \
  PRISMA_HIDE_UPDATE_MESSAGE=1
RUN corepack enable
WORKDIR /app

# Build: every dependency of the API and its workspace packages, then the packages and the API.
FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --store-dir /pnpm/store --filter "@agentic-studio/api..."
RUN pnpm --filter @agentic-studio/compose-validation --filter @agentic-studio/contracts --filter @agentic-studio/database --filter @agentic-studio/log-redaction --filter @agentic-studio/api run build

# Production dependencies only, for the API and the workspace packages it uses.
FROM base AS prod-deps
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --prod --store-dir /pnpm/store --filter "@agentic-studio/api..."

FROM ${NODE_IMAGE} AS runtime
# git and an SSH client: Repository features (clone, fetch, verify) run the system git.
# util-linux (already in the base image, named here on purpose) provides prlimit, which bounds
# the memory of every Git and ssh process.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client openssl util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 studio \
  && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin studio
ENV NODE_ENV=production \
  CHECKPOINT_DISABLE=1 \
  PRISMA_HIDE_UPDATE_MESSAGE=1
WORKDIR /app
# Root-owned and read-only for the API's uid: the code cannot be changed at run time.
COPY --from=prod-deps /app/pnpm-workspace.yaml /app/package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/compose-validation/package.json ./packages/compose-validation/
COPY --from=prod-deps /app/packages/compose-validation/node_modules ./packages/compose-validation/node_modules
COPY --from=build /app/packages/compose-validation/dist ./packages/compose-validation/dist
COPY --from=prod-deps /app/packages/log-redaction/package.json ./packages/log-redaction/
COPY --from=build /app/packages/log-redaction/dist ./packages/log-redaction/dist
COPY --from=prod-deps /app/packages/contracts/package.json ./packages/contracts/
COPY --from=prod-deps /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=prod-deps /app/packages/database/package.json /app/packages/database/prisma.config.ts ./packages/database/
COPY --from=prod-deps /app/packages/database/prisma ./packages/database/prisma
COPY --from=prod-deps /app/packages/database/node_modules ./packages/database/node_modules
COPY --from=build /app/packages/database/dist ./packages/database/dist
COPY --from=prod-deps /app/apps/api/package.json ./apps/api/
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
USER 10001:10001
WORKDIR /app/apps/api
EXPOSE 3001
CMD ["node", "dist/main.js"]
