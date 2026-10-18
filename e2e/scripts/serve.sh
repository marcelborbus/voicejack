#!/usr/bin/env bash
# Playwright webServer: fixtures → client build (into E2E_TMP, not client/dist) → server.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
tmp=${E2E_TMP:?E2E_TMP not set}
mkdir -p "$tmp"
bash "$root/e2e/scripts/make-fixtures.sh" "$tmp/clips"
(cd "$root/client" && pnpm exec vite build --logLevel warn --outDir "$tmp/dist" --emptyOutDir)
# Fresh state every run: uploads, SQLite DB (accounts, friends, libraries), library uploads.
rm -rf "$tmp/data" "$tmp/db" "$tmp/library"
mkdir -p "$tmp/data" "$tmp/db" "$tmp/library"
cd "$root/server"
# ADMIN_DEV: loopback may use /api/admin (no Authelia). MAIL_TRANSPORT=log + TIMINGS=fast: magic
# links land in the test outbox (GET /api/test/outbox). LEGAL_PATH: fixture Impressum.
export TIMINGS=fast ALLOW_SHORT_DUBBING=1 DEV_BOTS=1 CLIPS_DIR="$tmp/clips" DATA_DIR="$tmp/data" \
  CLIENT_DIST="$tmp/dist" HOST=127.0.0.1 LOG_LEVEL=${LOG_LEVEL:-warn} \
  DB_PATH="$tmp/db/voicejack.sqlite" LIBRARY_DIR="$tmp/library" ADMIN_DEV=1 MAIL_TRANSPORT=log READY_CHECK_MS=15000 GUEST_LIMIT_PER_IP=200 \
  PUBLIC_URL="http://127.0.0.1:${PORT:-3000}" LEGAL_PATH="$root/e2e/fixtures/legal.json"
exec pnpm exec tsx src/main.ts
