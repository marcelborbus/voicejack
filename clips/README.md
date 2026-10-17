# Clip library

`manifest.json` is committed; the media (`*.mp4`, `*.jpg` posters) is gitignored and rebuilt with:

```sh
node scripts/fetch-clips.mjs            # fetch + encode everything missing (~35 MB output)
node scripts/fetch-clips.mjs --dry-run  # print the plan only
node scripts/fetch-clips.mjs --only tos-breakup --force   # redo one clip
```

Needs `ffmpeg`/`ffprobe` and HTTPS access to download.blender.org and archive.org. Only the
needed segment of each source is downloaded (ffmpeg seeks over HTTP range requests) into
`.cache/clip-sources/`, so a full run transfers roughly 150 MB. Sources, cut points and attribution
live in `scripts/clips.sources.json`.

Encoding: H.264 CRF 26 + AAC 96k, fit inside 1280x720 (never upscaled), `+faststart`, every clip at most 60 s.
The poster is a JPEG of at most 640x360.

## Bot sounds (dev test mode, V01)

`node scripts/make-bot-sounds.mjs` cuts 4 random 0.5–3 s pieces from each clip's audio (near-silent
pieces skipped) into `clips/bot-sounds/*.webm` + `manifest.json` (gitignored, ~0.5 MB). Bots
(`DEV_BOTS=1`) "record" these. Without the pool the server synthesizes a few tones with ffmpeg at
startup, or bots submit empty dubs if ffmpeg is missing.

## Licences

Only redistributable material goes in: Blender open movies (CC BY) and public-domain films on
archive.org. Each manifest entry carries `attribution` (author, source, licence, licence URL), and the
UI must show it.

| id | source | licence |
|---|---|---|
| tos-breakup, tos-adlib | Tears of Steel (Blender Foundation) | CC BY 3.0 |
| cosmos-half-a-minute | Cosmos Laundromat (Blender Institute) | CC BY 4.0 |
| sintel-shaman | Sintel (Blender Foundation) | CC BY 3.0 |
| ed-at-the-left | Elephants Dream (Blender Foundation / NIMk) | CC BY 2.5 |
| bbb-bullies | Big Buck Bunny (Blender Foundation) | CC BY 3.0 |
| hgf-water-buffalo | His Girl Friday (1940) | Public domain |
| charade-ski-lodge | Charade (1963) | Public domain |
| notld-barbara | Night of the Living Dead (1968) | Public domain |
| plan9-greetings, plan9-stupid-minds | Plan 9 from Outer Space (1959) | Public domain |
| popeye-sindbad-song | Popeye the Sailor Meets Sindbad the Sailor (1936) | Public domain |

## Owner clips

You can add your own (non-redistributable) clips: drop the mp4 here and add a manifest entry with
`"local": true`. `fetch-clips.mjs` keeps those entries when it rewrites the manifest. They are
gitignored and are never baked into the Docker image, because `clips/` is mounted as a volume.
