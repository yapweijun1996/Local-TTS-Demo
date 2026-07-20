# Multi-stage build for @local-tts/api (PRD Phase 3).
#
# Build context is the REPO ROOT (see docker-compose.yml `context: .`), not
# apps/api — the workspace needs pnpm-workspace.yaml and packages/core's
# source to build the shared package before the API can import it.
#
# node:20-slim (Debian, glibc) — NOT alpine: onnxruntime-node ships prebuilt
# native bindings for glibc; musl (alpine) has no matching binary and falls
# back to a slow/broken build-from-source path.

FROM node:20-slim AS base
RUN corepack enable && corepack prepare pnpm@10.14.0 --activate
WORKDIR /repo

# ── Dependency layer (cached until lockfile/package.json changes) ─────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/package.json
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile

# ── Build ───────────────────────────────────────────────────────────────
FROM deps AS build
COPY packages/core packages/core
COPY apps/api apps/api
RUN pnpm --filter @local-tts/core build && pnpm --filter @local-tts/api build

# `pnpm deploy` produces a self-contained prod-only install for one workspace
# package (workspace deps like @local-tts/core are copied in, not symlinked) —
# the standard pattern for slim pnpm-monorepo Docker images.
RUN pnpm --filter @local-tts/api deploy --prod /prod/api

# ── Runtime ─────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /prod/api .

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
