# Voicejack — product spec (formerly "DubParty"; renamed 2026-10-17 because "Dub Party" exists on Steam)

Source: the owner's voice brief (2026-10-16), tidied up. Where the brief left a gap, the
decision taken is marked **(decision)**.

## Concept
A browser multiplayer party game. Friends join a lobby, chat by voice, then every player
dubs the same short, well-known clip (movie scene / meme, ≤ 60 s) alone against a timer.
Afterwards all dubs are played back anonymously, everyone rates each one 0–10, and points
add up over the rounds.

## Flow
1. **Lobby** — the host creates a room and gets an invite link / code. Players join with a
   name. Everyone in the lobby hears everyone else (voice chat).
   - Every player must have a working mic (permission granted and signal detected) and be
     marked ready. The host can only start when all players pass the mic check.
   - Normal mode: **3 rounds**. Extended mode (host setting): number of rounds, dubbing
     time, and similar knobs.
2. **Dubbing phase** (per round) — everyone gets the same clip. Voice chat is cut: you do
   not hear the others. Time limit 3–4 min (default 3:30 **(decision)**, configurable in
   extended mode).
   - Editor: play/pause, seek (move the cursor), scroll back and forward, preview at faster
     (or slower) speed.
   - The original clip cannot be edited. Only the user's own audio is edited.
   - Recording always runs at 1× speed, starting at the cursor, laid under the video at that
     position. Recorded chunks cannot be moved in time.
   - Multiple chunks may overlap (layers), e.g. a voice-made sound effect under dialogue.
   - A chunk can be overwritten (re-recorded) or deleted, one chunk at a time.
   - Voice only — no uploading sound files.
   - When time runs out, whatever exists is submitted automatically.
3. **Showcase & voting** — dubs are played one after another, author hidden. While a dub
   plays, every player sets a 0–10 score; it can be changed until that dub ends, then it is
   locked in. Players cannot rate their own dub **(decision)**. Then the next dub.
   Voice chat is back on during the showcase (also while dubs play) — only DUBBING is silent.
4. **Round results** — scores for the round are announced, then the next round starts.
5. **Final** — after the last round the overall winner is announced, their winning dub is
   replayed and can be saved (downloaded as a video).

## Non-functional
- Runs in the browser (desktop Chrome/Firefox first; mobile nice to have).
- Modern UI, built on a design framework.
- Hosted on the owner's Hetzner server (see ARCHITECTURE.md on the box).
- Clips: we can only ship clips we may redistribute (public domain / CC). The library is a
  folder + manifest, so the owner can drop in their own meme clips for private games.
