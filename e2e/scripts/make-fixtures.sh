#!/usr/bin/env bash
# E2E clip library: Playwright's bundled Chromium has no H.264/AAC, so the clips are
# VP9/Opus webm (8 s testsrc2 + 440 Hz sine, 320x180).
#   bash e2e/scripts/make-fixtures.sh <outdir>
# Writes test-{a,b,c,d}.webm, a poster each and <outdir>/manifest.json (ClipManifestSchema).
# Skips the work when the manifest already exists.
set -euo pipefail

out=${1:?usage: make-fixtures.sh <outdir>}
if [[ -f "$out/manifest.json" && -f "$out/test-d.webm" ]]; then
  echo "fixtures already in $out"
  exit 0
fi
mkdir -p "$out"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=320x180:rate=25:duration=8" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=8" \
  -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -b:v 300k -pix_fmt yuv420p \
  -c:a libopus -b:a 64k -ac 2 -shortest \
  "$out/test-a.webm"
cp "$out/test-a.webm" "$out/test-b.webm"
cp "$out/test-a.webm" "$out/test-c.webm"
cp "$out/test-a.webm" "$out/test-d.webm" # 4 clips: admin test room with 3 bots (v1.2 #46)
ffmpeg -hide_banner -loglevel error -y -ss 2 -i "$out/test-a.webm" -frames:v 1 -q:v 5 "$out/test-a.jpg"
cp "$out/test-a.jpg" "$out/test-b.jpg"
cp "$out/test-a.jpg" "$out/test-c.jpg"
cp "$out/test-a.jpg" "$out/test-d.jpg"

dur=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$out/test-a.webm")
dur_ms=$(awk -v d="$dur" 'BEGIN { printf "%d", d * 1000 }')

entry() { # id title
  cat <<JSON
    {
      "id": "test-$1",
      "title": "$2",
      "file": "test-$1.webm",
      "durationMs": $dur_ms,
      "width": 320,
      "height": 180,
      "poster": "test-$1.jpg",
      "tags": ["test"],
      "attribution": {
        "author": "Voicejack test fixture (ffmpeg testsrc2)",
        "source": "e2e/scripts/make-fixtures.sh",
        "license": "CC0 1.0",
        "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/"
      }
    }
JSON
}

{
  echo '{ "clips": ['
  entry a 'Test Clip A'
  echo ','
  entry b 'Test Clip B'
  echo ','
  entry c 'Test Clip C'
  echo ','
  entry d 'Test Clip D'
  echo '] }'
} >"$out/manifest.tmp.json"
mv "$out/manifest.tmp.json" "$out/manifest.json"
echo "wrote $out/manifest.json (4 clips, ${dur_ms} ms each)"
