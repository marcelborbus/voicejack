# Clip library

`manifest.json` is committed; the media (`*.mp4`, `*.jpg` posters) is gitignored and rebuilt with:

```sh
node scripts/fetch-clips.mjs            # fetch + encode everything missing (~73 MB output)
node scripts/fetch-clips.mjs --dry-run  # print the plan only
node scripts/fetch-clips.mjs --only tos-breakup --force   # redo one clip
```

Needs `ffmpeg`/`ffprobe` and HTTPS access to download.blender.org, video.blender.org and archive.org. Only the
needed segment of each source is downloaded (ffmpeg seeks over HTTP range requests) into
`.cache/clip-sources/`, so a full run transfers roughly 250 MB. Sources, cut points and attribution
live in `scripts/clips.sources.json`.

Encoding: H.264 CRF 26 + AAC 96k, fit inside 1280x720 (never upscaled), `+faststart`, every clip at most 60 s.
The poster is a JPEG of at most 640x360.

## Bot sounds (dev test mode, V01)

`node scripts/make-bot-sounds.mjs` cuts up to 6 pieces of 3–8 s from each clip's audio into
`clips/bot-sounds/*.webm` + `manifest.json` (gitignored). Same recipe as the server's runtime pool
(`server/src/bots/snippets.ts`, v1.2 #47): windows at least 70 % voiced (`silencedetect` at −40 dB),
trimmed to their voice, source mean volume above −35 dBFS, normalised with `loudnorm`. Bots (`DEV_BOTS=1`)
"record" these and "say" them in voice phases (`botVoice`). Without the pool the server synthesizes a few tones with ffmpeg at
startup, or bots submit empty dubs if ffmpeg is missing.

## Licences

Only redistributable material goes in: Blender open movies (CC BY) and public-domain films on
archive.org. Each manifest entry carries `attribution` (author, source, licence, licence URL), and the
UI must show it. In `scripts/clips.sources.json`, `attribution.rightsNote` records *why* a source is
redistributable; it stays in the sources file and is not copied into the manifest.

Rejected on rights grounds (don't re-add): *Falling Hare* (1943) and the Fleischer *Superman* shorts
(1941–43) are public domain as films but derivative of characters still under copyright (Bugs Bunny from
*A Wild Hare*, 1940; Superman from *Action Comics* #1, 1938); *Robot Monster* (1953) has no reliable
public-domain source, only uploader labels.

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
| duck-bert, duck-drill | Duck and Cover (1951) | Public domain (US government work, Federal Civil Defense Administration) |
| shyguy-pep-talk, shyguy-who-me | Shy Guy (1947, Coronet) | Public domain (copyright not renewed, per Prelinger Archives) |
| date-family-dinner | A Date with Your Family (1950, EB Films) | Public domain (copyright not renewed, per Prelinger Archives) |
| dating-phone-call | Dating: Do's and Don'ts (1949, Coronet) | Public domain (copyright not renewed, per Prelinger Archives) |
| llama-stare, llama-road | Caminandes 1: Llama Drama (Blender Foundation) | CC BY 3.0 |
| gran-dillama-fence | Caminandes 2: Gran Dillama (Blender Foundation) | CC BY 3.0 |
| llamigos-ice | Caminandes 3: Llamigos (Blender Foundation) | CC BY 3.0 |
| sprite-fright-aww | Sprite Fright (Blender Studio) | CC BY 1.0 (as stated on studio.blender.org; the archive.org mirror says 4.0) |
| stooges-swear-in | Disorder in the Court (1936) | Public domain (copyright not renewed) |
| shop-dentist | The Little Shop of Horrors (1960) | Public domain (copyright not renewed) |
| reefer-grin | Reefer Madness (1936) | Public domain (improper copyright notice) |
| teen-ray-gun | Teenagers from Outer Space (1959) | Public domain (copyright not renewed) |
| terror-karloff, terror-stare | The Terror (1963) | Public domain (copyright never registered) |

## Owner clips

You can add your own (non-redistributable) clips: drop the mp4 here and add a manifest entry with
`"local": true`. `fetch-clips.mjs` keeps those entries when it rewrites the manifest. They are
gitignored and are never baked into the Docker image, because `clips/` is mounted as a volume.
