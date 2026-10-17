#!/usr/bin/env bash
# Generates a tiny clip library for e2e/integration tests:
#   bash scripts/make-test-clip.sh <outdir>
# Writes test-a.mp4 (8 s testsrc2 + 440 Hz sine, 640x360), copies test-b.mp4 and
# test-c.mp4, a poster per clip and <outdir>/manifest.json with 3 entries.
set -euo pipefail

out=${1:?usage: make-test-clip.sh <outdir>}
mkdir -p "$out"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=640x360:rate=25:duration=8" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=8" \
  -c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p \
  -c:a aac -b:a 64k -ac 2 -shortest -movflags +faststart \
  "$out/test-a.mp4"
cp "$out/test-a.mp4" "$out/test-b.mp4"
cp "$out/test-a.mp4" "$out/test-c.mp4"

for id in a b c; do
  ffmpeg -hide_banner -loglevel error -y -ss 2 -i "$out/test-$id.mp4" -frames:v 1 -q:v 5 \
    "$out/test-$id.jpg"
done

dur=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$out/test-a.mp4")
dur_ms=$(awk -v d="$dur" 'BEGIN { printf "%d", d * 1000 + 0.5 }')

entry() { # id title tags-json
  cat <<EOF
    {
      "id": "test-$1",
      "title": "$2",
      "file": "test-$1.mp4",
      "durationMs": $dur_ms,
      "width": 640,
      "height": 360,
      "poster": "test-$1.jpg",
      "tags": $3,
      "attribution": {
        "author": "Voicejack test fixture (ffmpeg testsrc2)",
        "source": "scripts/make-test-clip.sh",
        "license": "CC0 1.0",
        "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/"
      }
    }
EOF
}

{
  echo '{'
  echo '  "clips": ['
  entry a 'Test Clip A' '["test", "alpha"]'
  echo '    ,'
  entry b 'Test Clip B' '["test", "beta"]'
  echo '    ,'
  entry c 'Test Clip C' '["test"]'
  echo '  ]'
  echo '}'
} >"$out/manifest.json"

echo "wrote $out/manifest.json (3 clips, ${dur_ms} ms each)"
