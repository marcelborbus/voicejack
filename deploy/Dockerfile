# syntax=docker/dockerfile:1
# DubParty production image (PLAN T20). Build from the repo root:
#   docker build -f deploy/Dockerfile -t dubparty .
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
# image is the base (~167 MB) plus ~5 MB.
RUN apk add --no-cache tini \
 && mkdir -p /app/clips /app/data \
 && chown node:node /app/data
WORKDIR /app
COPY --from=build --chown=root:root /out/server.mjs /app/server.mjs
COPY --from=build --chown=root:root /out/public /app/public

# TRUST_PROXY: nginx reaches the container from the Docker bridge gateway (172.x), not
# 127.0.0.1, so trust private ranges; X-Forwarded-For is then read right-to-left and the
# client cannot spoof its rate-limit key. The port is bound to loopback, so only nginx
# can talk to us at all.
# DATA_DIR is a subdirectory of the /app/data volume on purpose: the server wipes DATA_DIR
# with rm -r on startup, which cannot remove a mount point itself.
ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=192 \
    PORT=3000 \
    HOST=0.0.0.0 \
    CLIPS_DIR=/app/clips \
    DATA_DIR=/app/data/uploads \
    CLIENT_DIST=/app/public \
    TRUST_PROXY=loopback,uniquelocal

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/api/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/server.mjs"]
