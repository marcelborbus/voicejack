# syntax=docker/dockerfile:1
# Voicejack production image (PLAN T20). Build from the repo root:
#   docker build -f deploy/Dockerfile -t voicejack .
# Clips are NOT baked in: mount them read-only at /app/clips (see compose.yaml).

# ---------- build ----------
FROM node:24-alpine AS build
WORKDIR /src
RUN npm install -g pnpm@11.0.9 && pnpm --version
# Cap the Vite build's heap so building on the 4 GB host stays polite.
ENV NODE_OPTIONS=--max-old-space-size=1024 \
    CI=true

# Manifests first so the dependency layer is cached across source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN pnpm install --frozen-lockfile --filter server... --filter client...

COPY shared shared
COPY server server
COPY client client
COPY deploy/bundle-server.mjs deploy/
# `pnpm -r build` only builds the client (shared has no build step, the server has no
# build script); the server is bundled with esbuild below so @dub/shared's .ts sources and
# every npm dependency end up in one file and the runtime image needs no node_modules.
RUN pnpm -r --if-present build \
 && node deploy/bundle-server.mjs /out/server.mjs \
 && cp -r client/dist /out/public \
 && find /out/public -name "*.map" -delete

# ---------- runtime ----------
FROM node:24-alpine
# tini as PID 1 (signal forwarding, zombie reaping). The app is one bundled file, so the
# image is the base (~167 MB) plus ~5 MB, plus ffmpeg for admin clip uploads (V05, see
# README-deploy "Clip libraries" for the measured size).
RUN apk add --no-cache tini ffmpeg \
 && mkdir -p /app/clips /app/data \
 && chown node:node /app/data
WORKDIR /app
COPY --from=build --chown=root:root /out/server.mjs /app/server.mjs
COPY --from=build --chown=root:root /out/migrations /app/migrations
COPY --from=build --chown=root:root /out/public /app/public

# TRUST_PROXY: nginx reaches the container from the Docker bridge gateway (172.x), not
# 127.0.0.1, so trust private ranges; X-Forwarded-For is then read right-to-left and the
# client cannot spoof its rate-limit key. The port is bound to loopback, so only nginx
# can talk to us at all.
# DATA_DIR is a subdirectory of the /app/data volume on purpose: the server wipes DATA_DIR
# with rm -r on startup, which cannot remove a mount point itself.
# DB_PATH (SQLite, V03) is a sibling of DATA_DIR in the same volume, so it survives the wipe;
# the server creates /app/data/db itself. LIBRARY_DIR (V05 admin clip uploads, normalized by
# ffmpeg) is another sibling that survives the wipe; upload temp files go to LIBRARY_DIR/.tmp
# (the /tmp tmpfs is only 16 MB). node:sqlite needs no flag on Node 24; we only
# silence its ExperimentalWarning.
ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=192 --disable-warning=ExperimentalWarning" \
    PORT=3000 \
    HOST=0.0.0.0 \
    CLIPS_DIR=/app/clips \
    DATA_DIR=/app/data/uploads \
    DB_PATH=/app/data/db/voicejack.sqlite \
    LIBRARY_DIR=/app/data/library \
    COSTS_PATH=/app/data/costs.json \
    CLIENT_DIST=/app/public \
    TRUST_PROXY=loopback,uniquelocal

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/api/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/server.mjs"]
