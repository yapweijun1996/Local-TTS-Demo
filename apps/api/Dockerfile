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
COPY tsconfig.base.json tsconfig.base.json
COPY packages/core packages/core
COPY apps/api apps/api
RUN pnpm --filter @local-tts/core build && pnpm --filter @local-tts/api build

# `--legacy` keeps pnpm 10 compatible with the existing non-injected workspace
# dependency layout while still producing a self-contained prod-only install.
RUN pnpm --filter @local-tts/api deploy --prod --legacy /prod/api

# ── Runtime ─────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime
ENV NODE_ENV=production
ENV TTS_JOB_DATA_DIR=/app/data/tts-jobs
WORKDIR /app
COPY --from=build /prod/api .

EXPOSE 6700
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||6700)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
