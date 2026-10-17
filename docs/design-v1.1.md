# Voicejack v1.1: design pass (V02, #25)

Owner brief: "Make it more virally compatible, playfully inspired by games like skribbl.io but
not their style explicitly. I like the buttons for now."

Screenshots of v1 (the starting point) were taken at 390 px and 1280 px with headless Chromium.
What v1 already gets right: a confident fuchsia → orange brand gradient, chunky buttons, a dark
theme that suits video, good AA contrast, and reduced-motion support. What it lacks is
**personality**. v1 looks like a polished SaaS dashboard (glass cards, a faint grid, initials in
gradient squares). Nothing in it is worth screenshotting or sending to a group chat.

skribbl.io's virality comes from four things we borrow *as ideas* only: (1) every player has a
silly face, (2) the UI feels hand-made and low-stakes, (3) every moment has a sound or a wiggle,
(4) getting a friend in takes one click. We do not copy its look: no blue doodle wallpaper, no
pixel font, no light theme.

---

## 1. Brand personality

**Voicejack is a pirate radio crew that hijacks the movies.** You jack into a famous scene, steal
the voices, and broadcast your terrible version to your friends.

- **Cheeky, not mean.** It roasts the dubs, never the people. ("That was… a choice.")
- **Homemade.** It has the energy of tape, marker and a mic duct-taped to a broom. It should feel
  like your friends made it, not a studio.
- **Loud on the outside, calm in the tool.** Lobby, reveal and final get confetti and noise. The
  editor stays a quiet, precise tool.
- **Copy voice:** short, punchy and a little filmic. Use the words *hijack, jack in, on air,
  take, cut, mic drop, the cast.* Parody movie trailers sparingly ("In a world… where Dave voices
  a rabbit").

Tagline: **"Hijack the voices of famous movie clips."** Short form: **"Steal the scene."**

## 2. Palette

The buttons stay **exactly** as they are: `bg-brand` (fuchsia-500 → pink-500 → orange-500), the
zinc secondaries, and the emerald success button. Everything *around* them changes.

| Token | Value | Use |
|---|---|---|
| `ink-950` | `#0d0818` | page background (warmer, grape-black instead of neutral zinc) |
| `ink-900` | `#170f28` | card surface (solid, no more glass) |
| `ink-850` | `#1e1533` | inset wells: inputs, tab bars, stat tiles |
| `ink-800` | `#2a1e45` | raised chips, dividers on cards |
| `ink-line` | `rgb(255 255 255 / 0.10)` | card borders |
| brand gradient | fuchsia-500 → pink-500 → orange-500 | buttons, logo, key words (unchanged) |
| `sun` | `#ffd23f` | stars, crowns, highlights, "you" stickers |
| `jack` | `#2de2e6` | the cable/jack motif, voice-on, links to "connect" |
| `lime` | `#a3e635` | doodle accent for success moments (ready stamps) |
| rose-500 | (stock) | REC, destructive (unchanged) |

Contrast checks (WCAG AA, computed): zinc-400 `#9f9fa9` on ink-900 is ≈ 6.9:1. The lifted
zinc-500 `#8a8a93` on ink-900 is ≈ 5.2:1. `sun` on ink-900 is ≈ 13:1. `jack` on ink-900 is ≈ 11:1.
White on the brand gradient is unchanged from v1. Small text never uses a gradient.

## 3. Typography

- **Display:** Bricolage Grotesque (kept). It is already quirky. Use it heavier (800) and tighter
  for headlines, and set hero words at a −2° tilt.
- **UI/body:** Inter (kept).
- **Scribble:** **Caveat** 600–700, self-hosted via `@fontsource-variable/caveat`. Use it only
  for handwritten *annotations* ("that's you!", "pick a silly name", arrows on the hero) and the
  share card. It is always ≥ 18 px, always high contrast, and never the only carrier of essential
  information.
- **Mono:** room codes, time readouts (kept).

## 4. Identity: doodles + the mic/jack motif

- **Logo:** the gradient tile stays. Its glyph becomes a mic whose cable curls down into a
  3.5 mm **jack plug** (tip, ring, sleeve). The wordmark stays "Voice**jack**" and the mark
  wiggles on hover.
- **Doodle kit** (`components/doodles.tsx`, inline SVG, `aria-hidden`): a squiggle underline,
  sparkle star, curly arrow, sound-wave scribble, jack-cable swoosh, and speech bubble. Strokes
  are 2.5 px with round caps, deliberately a little wobbly.
- **Backdrop:** the faint grid is replaced by a sparse, tiled **doodle wallpaper** (mics, jacks,
  clappers, waves, stars, speech bubbles) at ~5 % opacity, plus the existing brand glows, toned
  down. It reads like scribbles on a studio wall, not a pattern sheet.
- **Sticker cards:** cards become solid `ink-900` with a 1.5 px light border and a hard
  **offset shadow** (`0 6px 0 rgb(0 0 0 / .45)`), like cut-out stickers stuck to the wall. The
  radius is unchanged. Hero cards may tilt ±0.6°. Glass blur is gone, which also helps
  performance on phones.
- **Tape labels:** small section eyebrows ("THE CAST", "ON AIR") sit on a skewed tape chip
  (`.tape`).

## 5. Avatars ("mugs")

Players get deterministic doodle faces instead of initials. No uploads, no network, no
protocol change.

- **Generator:** `lib/avatar.ts`, a pure function `avatarSvg(seed) → string`. Its parts are
  10 background colours × 3 head shapes × 7 eyes × 7 mouths × 9 accessories (headphones, beanie,
  cap, glasses, a mic at the mouth, bow, mustache, party hat, none), about 13 000 combinations.
  The output is plain SVG, so the same face can be drawn into the results share card on a canvas.
- **Seed = the player's name** (trimmed, lowercased). This is the "picker": your face follows your
  name, and the Home page shows a live preview while you type, so you can pick a name for the
  face. A 🎲 button suggests a random silly name ("Captain Mumble", "Sir Reverb") and gives you a
  new face with it. Two players with the same name share a face, which is acceptable.
  - *Why not a real picker?* A picker would need an `avatar` field in `PlayerPublic` and in the
    hello message (`shared/**`, a protocol bump). It is a follow-up candidate once accounts (V04)
    exist, because the choice could then live on the profile.
- `PlayerAvatar` keeps its API (`name`, `seed`, `size`, `dimmed`). `seed` is now ignored so the
  preview on Home matches what everybody else sees.
- Player cards leave a free slot in the name row for V01's bot badge.

## 6. Motion and juice

Existing animations stay (`fade-up`, `pop`, `float`, confetti). New ones:

| Name | Where |
|---|---|
| `wiggle` | logo mark and avatars on hover, the room code when copied |
| `stamp` | the "ready" check pops in at a tilt like a rubber stamp |
| `bob` | the doodle mic on loading screens |
| `jiggle` | the score number when you pick a vote |
| `draw` | the squiggle underline draws itself (`stroke-dashoffset`) |

**UI sounds** (`lib/sfx.ts`) are synthesised with WebAudio, so there are no audio files and the
bundle cost is about 2 KB. They are `pop` (someone joins), `ding` (someone gets ready), `tick`
(vote pick), `whoosh` (phase change) and `tada` (results/final).
- A **mute toggle** sits in the header for everyone (Home included) and is stored in
  `localStorage` (`vj.sfx`). It defaults to **on** at a low volume.
- **Sounds are hard-suppressed during DUBBING**, because they would leak into recordings.
- All animation is still killed by the global `prefers-reduced-motion` rule. Sounds are not
  motion, so they keep their own toggle.

## 7. Virality

1. **OG/Twitter cards:** `index.html` gets `og:title`, `og:description`, `og:image`
   (absolute: `https://voicejack.borbus.eu/og.png`, 1200×630), `og:url`, `og:type`,
   `twitter:card=summary_large_image`, and an `apple-touch-icon`. The **`og.png` is generated** by
   `scripts/make-og.mjs`, which uses Playwright to render `scripts/og/og.html` with the
   self-hosted fonts. The result is committed to `client/public/og.png`, so the build has no
   Playwright dependency. Re-run the script when the brand changes.
2. **Invite moment:** the lobby invite card shows a speech-bubble **preview of the message**
   your friends will get:
   > 🎙️ Alice hijacked a movie scene on Voicejack. Come do terrible voices with us → https://voicejack.borbus.eu/r/ABC123

   The **Copy invite** button copies that text with the link. The small Copy button on the link
   field still copies the bare URL. On phones with `navigator.share` there is also a **Share**
   button that opens the native share sheet.
3. **QR for the couch:** a **QR** button in the invite card opens a dialog with a large QR code
   for `/r/CODE`, so people on the same sofa can scan it from the laptop or TV. It uses `uqr`
   (≈ 10 KB, zero dependencies, renders SVG locally, no CDN).
4. **Results share card:** the Final screen gets a **Share results** button. It draws a
   1080×1350 PNG on a canvas: the logo, the winner's mug with a crown, the standings, the room's
   round count, and a footer with "voicejack.borbus.eu — steal the scene". It is shared through
   `navigator.share({files})` where supported, otherwise downloaded as `voicejack-results.png`.
   No server round-trip is involved.

## 8. Empty states and loading personality

- **Loading** (`components/LoadingQuip.tsx`): a bobbing doodle mic plus a rotating quip:
  "Untangling the cables…", "Warming up the vocal cords…", "Bribing the sound guy…", "Finding
  the jack…". It is used for connecting, the dubbing preload, and "waiting for others".
- **Empty lobby seats:** a dashed silhouette mug reading "Seat for a friend", with the first one
  pointing (Caveat arrow) to the invite.
- **Editor, no takes yet:** the existing hint stays and gets a scribbled arrow.
- **404 / fatal:** "This scene got cut." with the doodle style.

## 9. Page-by-page

- **Shell:** new logo, sound toggle in the header, and a doodle backdrop. The footer copy stays.
- **Home:** the headline becomes "Hijack the voices of **famous movie clips.**" with a squiggle
  under the brand words, a scribbled "it's free, no sign-up" note, and three "how it works" steps
  as numbered sticker chips (Jack in → Dub → Vote). The form card gets the **live mug preview**
  next to the name and the 🎲 name roller. The tabs keep their testids.
- **Invite (name prompt):** the room code sits on a big tape label, with "the cast so far" as a
  player count.
- **Lobby:** "The cast" header on tape, mugs in the player cards, and the invite card with
  message preview, Copy invite, Share and QR. Ready gets the stamp animation. The settings panel
  restyles through tokens only.
- **Dubbing:** restyle the chrome only. That means the header (round on a tape chip, an "ON AIR"
  pill while recording) and the cards via tokens. The timeline, transport and chunk mechanics are
  untouched.
- **Showcase:** a "Mystery dubber" mug (a ? face), a tape eyebrow, and a jiggle on vote pick. The
  `Dub N of M` h2 text stays.
- **Round results / Final:** mugs in the reveal rows and standings, a sun-coloured crown, a
  `tada` sound, and the **Share results** card on Final.

## 10. Accessibility checklist

- AA contrast for all text (see §2). Gradient text only at ≥ 24 px bold.
- `prefers-reduced-motion`: the global kill switch is kept, and new animations are CSS-only so
  it covers them.
- Every decorative SVG is `aria-hidden`. The QR dialog shows the link as text too. The sound
  toggle has `aria-pressed` and a label.
- **All existing `data-testid`s are preserved.** New ones: `sfx-toggle`, `invite-share`,
  `invite-qr`, `invite-qr-dialog`, `invite-message`, `name-dice`, `avatar-preview`,
  `share-results`.

## 11. Decisions for the owner to review

1. **Avatar = f(name)** instead of a stored pick (no protocol change). A real picker can follow
   with accounts.
2. **Sounds default ON** (quiet). Flip to off if you think that is rude.
3. The background goes from neutral zinc to **grape-ink**. The buttons are pixel-identical.
4. The invite copy text and the share-card wording are first drafts. They live in
   `lib/share.ts` and are easy to change.
