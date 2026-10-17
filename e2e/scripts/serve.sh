#!/usr/bin/env bash
# Playwright webServer: fixtures → client build (into E2E_TMP, not client/dist) → server.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
tmp=${E2E_TMP:?E2E_TMP not set}
mkdir -p "$tmp"
bash "$root/e2e/scripts/make-fixtures.sh" "$tmp/clips"
(cd "$root/client" && pnpm exec vite build --logLevel warn --outDir "$tmp/dist" --emptyOutDir)
rm -rf "$tmp/data"
mkdir -p "$tmp/data"
cd "$root/server"
export TIMINGS=fast ALLOW_SHORT_DUBBING=1 DEV_BOTS=1 CLIPS_DIR="$tmp/clips" DATA_DIR="$tmp/data" \
  CLIENT_DIST="$tmp/dist" HOST=127.0.0.1 LOG_LEVEL=${LOG_LEVEL:-warn}
exec pnpm exec tsx src/main.ts
