# Voicejack (formerly DubParty): Architecture & Implementation Plan

> Source of truth for the build. Product spec: `SPEC.md`. Tasks are listed in the **Checklist** below. Each task is one commit and leaves the repo green (`pnpm typecheck && pnpm test`).
> Environment I checked on the dev box: Node 24.14, pnpm 11, ffmpeg 8.1, Docker 29, Playwright browsers already in `~/.cache/ms-playwright`. The repo has no commits yet; only `SPEC.md` exists.

---

## 1. Resuming (read this first in every fresh session)

1. `cat PLAN.md`, then find the first unchecked `- [ ] Txx` whose dependencies are all checked.
2. `git log --oneline | head -30`. Every task commit message starts with its ID (`T07: chunk upload store`). If a task's commit is in the log but its box is unchecked, check the box in your next commit.
3. `git status`. Uncommitted changes are a half-finished task from an interrupted session. Find their task from the file paths. Finish it, or `git stash` them if you can't tell what they are. Never commit somebody else's paths.
4. Before starting, run `pnpm install && pnpm typecheck && pnpm test`. It must be green. If it is red, fix that first in a separate `fix:` commit.

**GitHub issues** (github.com/marcelborbus/voicejack): T01=#1, T02=#2, T03=#3, T04=#4, T05=#6, T06=#7, T07=#8, T08=#9, T09=#5, T10=#10, T11=#11, T12=#12, T13=#13, T14=#14, T15=#15, T16=#16, T17=#17, T18=#18, T19=#19, T20=#20, T21=#21, T22=#22, T23=#37. Put `Closes #N` in the task's commit body; the orchestrator pushes.

**Conventions**
- **One commit per task.** Commit only your own paths: `git commit -m "T07: …" -- <paths> PLAN.md`. Check the task's box in PLAN.md **in that same commit**. Commit message trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Agents running in parallel must not edit files owned by another task. The "Touches" column gives ownership. Shared registration points are created in their final form in an earlier task, so that later tasks only add files.
- If the protocol has to change (`shared/src/protocol/*`), use a dedicated `Txx-proto:` commit that updates both sides' types. Bump `PROTOCOL_VERSION` only if the wire format changes.
- If a task runs out of budget, commit what compiles as `Txx (partial): …`, leave the box unchecked, and add a one-line `> NOTE Txx:` under the task saying what is left.
- Roles: **impl** writes the feature with its own unit tests. **test** writes test harnesses or suites. **verify** runs everything, does manual or browser checks, and fixes small issues.

---

## 2. Architecture

```
dubbing-game/
  package.json            # workspace scripts: dev, build, test, typecheck, e2e
  pnpm-workspace.yaml     # packages: shared, server, client, e2e
  tsconfig.base.json      # strict, ES2023, moduleResolution bundler/nodenext
  vitest.config.ts        # test.projects = shared, server, client (vitest 5 dropped workspace files)
  shared/   src/protocol/{common,c2s,s2c,rest}.ts  src/constants.ts  src/helpers/*.ts  src/index.ts
  server/   src/{main,config}.ts  src/http/app.ts  src/routes/{rooms,chunks,clips}.ts
            src/ws/gateway.ts  src/room/{Room,RoomManager,timers}.ts  src/clips/ClipLibrary.ts
            src/uploads/ChunkStore.ts  src/security/rateLimit.ts  test/**
  client/   src/{main,App}.tsx  src/components/ui/*  src/net/*  src/state/*  src/audio/*
            src/dub/*  src/editor/*  src/voice/*  src/render/*  src/pages/*
  e2e/      playwright.config.ts  tests/*.spec.ts  fixtures/clips/
  scripts/  fetch-clips.mjs  clips.sources.json  make-test-clip.sh
  clips/    manifest.json (+ *.mp4, gitignored)
  deploy/   Dockerfile  compose.yaml  nginx/dub.borbus.eu.conf  README-deploy.md
```

**Libraries (kept small):**
- shared (package name `@dub/shared`, consumed via `"@dub/shared": "workspace:*"`): `zod`. Client-to-server messages and REST bodies are zod schemas, and their types come from `z.infer`.
- server: `fastify@5`, `@fastify/websocket` (ws), `@fastify/static` (Range support for video), `@fastify/rate-limit`, `nanoid`.
- client: `react@19`, `react-router`, `zustand`, `tailwindcss@4`, `@radix-ui/*` primitives for shadcn-style components (`button, card, input, slider, switch, select, badge, dialog, tooltip, progress, toast`), `lucide-react`, `clsx` + `tailwind-merge`.
- tests: `vitest`, `@playwright/test`.

### 2.1 Server
- **Room (pure domain).** `Room` holds all game state and the state machine. It has no I/O. It gets three things injected:
  - `clock.now()`
  - a `Scheduler` (setTimeout wrapper, so vitest fake timers work)
  - an `emit(playerId, S2C)` callback
- After each mutation the room bumps `rev` and pushes a **per-recipient `RoomSnapshot`** to every connected player. Rooms have at most 8 players and snapshots are about 2–5 KB, so full snapshots are simpler and make reconnect trivial.
- **RoomManager.** Room codes are 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`. Caps: `MAX_ROOMS=30` and `MAX_PLAYERS=8`. A room is disposed when it has been empty for 10 min or has existed for 3 h. Disposal deletes its uploads.
- **Gateway** (`/ws`). It parses with zod, enforces a per-socket rate limit (60 msgs/s burst 120, then error + close), caps message size at 32 KB, and maps socket → (room, player).
  - Reconnect: the token is a random 32-byte string stored per room as `localStorage["dub.token.<CODE>"]`. A new socket with the same token replaces the old one.
- **Timings** come from a `Timings` config. Values are `prod` or `fast` (env `TIMINGS=fast` for e2e/integration).

  | Timing | prod | fast |
  |---|---|---|
  | `uploadGraceMs` | 3000 | 500 |
  | `preloadMaxMs` | 8000 | 2000 |
  | `playLeadMs` | 1500 | 300 |
  | `voteGraceMs` | 2000 | 300 |
  | `betweenItemsMs` | 1500 | 200 |
  | `roundResultsMs` | 15000 | 1000 |
  | `lobbyDropMs` | 60000 | – |
  | `hostMigrateMs` | 30000 | – |

  In `fast` mode the dubbing length comes from the settings, and `ALLOW_SHORT_DUBBING` allows values down to 5 s.
- **ClipLibrary** reads `CLIPS_DIR/manifest.json`, validates it with zod, and checks that each file exists. Clips are served at `/clips/<file>` with Range support and `Cache-Control: max-age=3600`.
- **ChunkStore** keeps uploads on disk at `DATA_DIR/<room>/<round>/<submissionId>/<chunkId>`, with the mime type in a sidecar or in memory. The directory is wiped on startup.
- **Static:** serves `client/dist` with SPA fallback for `/` and `/r/*`.
- `config.ts` env vars: `PORT` (3000), `HOST`, `CLIPS_DIR`, `DATA_DIR`, `CLIENT_DIST`, `TIMINGS`, `ALLOW_SOLO` (lets 1 player start), `TRUST_PROXY` (127.0.0.1), `ICE_SERVERS` (JSON, default `[{urls:"stun:stun.l.google.com:19302"}]`).

### 2.2 State machine

```
LOBBY --startGame(host; all ready & micOk; >=2 players or ALLOW_SOLO; enough clips)--> DUBBING(round r)
DUBBING --(phaseEndsAt reached | all connected players dubDone) + uploadGraceMs--> SHOWCASE
SHOWCASE: for each non-empty submission in random order:
     LOADING --(all connected preloaded | preloadMaxMs)--> PLAYING(startAt = now+playLeadMs,
              lockAt = startAt + clip.durationMs + voteGraceMs) --lockAt--> LOCKED --betweenItemsMs--> next item
     (no non-empty submissions → straight to ROUND_RESULTS)
SHOWCASE(done) --> ROUND_RESULTS (phaseEndsAt = now+roundResultsMs; host 'advance' skips)
ROUND_RESULTS --> DUBBING(r+1) | FINAL (after last round)
FINAL --backToLobby(host)--> LOBBY (scores reset; usedClipIds kept so clips don't repeat in the room)
```

**Rules the domain enforces:**
- **Joining.** New players can join only in `LOBBY`; otherwise the join fails with `GAME_IN_PROGRESS`. Reconnecting with a token works in any phase.
- **Ready requires mic.** `setReady(true)` needs `micOk`. If a player reports `micOk:false`, their ready flag is cleared.
- **Settings reset readiness.** Any settings change clears all ready flags.
- **Host migration.** If the host has been disconnected for more than `hostMigrateMs`, the earliest-joined connected player becomes host.
- **Lobby drop.** A player disconnected in LOBBY for more than `lobbyDropMs` is removed. During a game they stay in the room, marked `connected:false`.
- **Clip choice.** Each round picks a random clip from the library filtered by tags (`[]` = all), minus `usedClipIds`. `startGame` is blocked if `available < rounds`. The reason is shown in `you.startBlockers`.
- **Submissions.** Each player gets a fresh random `SubmissionId` per round. During dubbing the server stores the latest `manifest` per player. At finalization: `chunks = manifest ∩ uploaded`, sorted by `startMs`. A submission with no chunks counts as empty: it gets 0 points and is not showcased.
- **Voting.** Only allowed while the item is `PLAYING`. Scores are integers 0–10. Voting on your own item fails with `SELF_VOTE`. The last vote before `lockAt` counts. The slider starts untouched, and no vote means not counted.

**Scoring (chosen: mean of cast votes, scaled to 0–100 points per dub).** `points = round(mean(votes) * 10)`.
- *Why not sum:* how many votes a dub can get changes with player count, abstentions and disconnects, so sums would reward dubs that happened to have more voters present. The mean makes every dub comparable whatever the number of voters.
- If a non-empty dub gets zero votes it receives a neutral 50 points, so the author isn't punished for other people's inactivity. Its average is displayed as "–".
- Game total = sum of round points.
- Winner = highest total. Tie-break: more round wins (highest points in a round). If still tied, there are shared winners.
- `bestDub` is the winner's highest-points submission (later round on tie). With several winners, use the first winner by standings order.
- Per-voter normalization (z-scores) was considered and rejected: too opaque for a party game.

### 2.3 Client
- **`net/socket.ts`.**
  - Opens the WebSocket and reconnects with backoff (0.5 → 5 s).
  - Sends `hello` with the stored token.
  - Clock sync: a `ping` burst on connect (5×), then one every 10 s. `offset = s - (c0 + c1)/2` from the minimum-RTT sample, stored as `serverToPerf(ts)`.
  - Puts the snapshot into a zustand store (`state/room.ts`).
- **`audio/context.ts`.** A single `AudioContext`, unlocked on the first user gesture: the Join/Create button and the mic-check click. If `ctx.state !== 'running'` (for example after a reload), it shows a "Tap to enable sound" overlay.
- **`audio/mic.ts`.**
  - Calls `getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}})` and reuses that one stream for voice chat and recording.
  - Level meter: an `AnalyserNode` measuring RMS. `micOk` = permission granted and RMS above -50 dBFS for at least 300 ms in the last 5 s.
  - If the mic is lost (track `ended`), it reports `micOk:false`.
- **`audio/recorder.ts`.**
  - Picks the mime type with `MediaRecorder.isTypeSupported` from `['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/mp4']`, at 48 kbps.
  - **Latency compensation:** `recorder.start()`. On `onstart`, record `tRec = performance.now()`, then call `video.play()`. On the first `requestVideoFrameCallback`, record `tVid` and `m0 = video.currentTime`. The chunk is stored as `startMs = cursor`, `offsetMs = clamp(tVid - tRec, 0, 1000)`, meaning that much audio is skipped at playback.
- **`dub/DubPlayer.ts` (one engine for editor, showcase, final and render).**
  - Inputs: a `<video>`, the `AudioContext`, an output node, and a map of decoded `AudioBuffer`s with their `ChunkMeta`.
  - On `play / seeked / ratechange / playing`, it stops all sources and asks `planSchedule(chunks, mediaTimeMs, rate)` (pure, in shared) for `{chunkId, whenDelaySec, bufferOffsetSec}[]`. Each source gets `playbackRate = rate`. Pitch shift during previews at other speeds is accepted.
  - On `pause / waiting / seeking` it stops all sources.
  - A drift watchdog runs every 250 ms. It compares the media time implied by the audio clock with `video.currentTime` and reschedules if they differ by more than 60 ms.
  - Showcase mode is driven by the server clock: at `serverToPerf(startAt)` it calls `video.currentTime=0; play()`. While playing, if `|video.currentTime - expected| > 150 ms`, it seeks (the watchdog then resyncs audio). A late joiner seeks straight to `expected`.
- **`dub/chunkLoader.ts`.** `fetch(url, {headers:{'X-Player-Token'}})`, then `decodeAudioData`. If decoding fails, the chunk is skipped and a toast is shown.
- **Editor** (`editor/`):
  - **Store** (`editorStore.ts`): chunks, selection, cursor, speed, reference audio on/off and volume, upload status per chunk.
  - **Upload queue** (`uploadQueue.ts`): POST each chunk right after it stops, 3 retries, then send the full `manifest`.
  - **Restore on reconnect:** take `you.manifest` and re-download own chunks.
  - **Timeline:** DOM-based, with a ruler, playhead, scrub by drag or click, and lanes computed by `layoutLanes(chunks)` (pure, in shared; greedy interval partitioning). Each chunk shows a waveform made from peaks computed at decode time.
  - **Transport:** play/pause, -5 s/+5 s, speed 0.5×/1×/1.5×/2×, record/stop, reference audio toggle with volume (default 0.15, plus a "use headphones" hint), and a countdown taken from `phaseEndsAt`.
  - **Keyboard:** `Space` play/pause · `R` record/stop · `←/→` ±5 s · `Shift+←/→` ±0.1 s · `Home` jump to start · `1–4` speed · `M` reference audio · `Del/Backspace` delete selected chunk · `Shift+R` re-record selected · `Esc` deselect or stop recording. Shortcuts are disabled while focus is in an input.
  - **Recording behaviour.** Recording forces 1× and plays from the cursor. The other chunks keep playing, so layering is possible. Recording stops at clip end or on stop. Chunks shorter than 300 ms are discarded.
  - **Re-record.** It seeks to the selected chunk's `startMs` and records. When recording finishes, a new chunk replaces the old one in the manifest. Cancelling keeps the old one.
  - **Deadline.** At the deadline the client stops any recording and uploads at once; the server allows `uploadGraceMs`.
  - **Done.** A "Done" button sends `dubDone`. The phase ends early when every connected player is done.
- **Voice** (`voice/VoiceMesh.ts`):
  - Full mesh using the "perfect negotiation" pattern. The player with the lower `playerId` is polite. Signaling goes through `{t:'rtc'}`; ICE servers come from `welcome.iceServers`.
  - Remote audio plays in hidden `<audio>` elements.
  - **Muting policy** (`voicePolicy.ts`, pure): the outgoing track's `enabled` flag and the remote elements' `muted` follow `voiceAllowed(phase, showcase.status)`. Voice is allowed in every phase except DUBBING — including while showcase clips play, so friends hear each other while voting (owner request 2026-10-16). Connections stay up; only the audio is gated, which gives instant resume.
  - Each player tile shows connection state (connecting / connected / failed: "no direct route").
- **Render** (`render/renderDub.ts`):
  - Hidden `<video>` (same origin, so the canvas is not tainted) is drawn onto a `<canvas>` every frame (`requestVideoFrameCallback`). `canvas.captureStream(30)` provides the video track, and a DubPlayer outputs into a `MediaStreamAudioDestinationNode`.
  - `MediaRecorder('video/webm;codecs=vp9,opus'` or `vp8,opus`, falling back to `video/mp4` on Safari). Rendering runs in real time with a progress bar, then downloads `dubparty-<clip>-<name>.webm`.
- **Pages:**
  - `/`: create (name) or join (code + name).
  - `/r/:code`: if there is no token it shows a name prompt, then switches on the phase: `Lobby | Dubbing(Editor) | Showcase | RoundResults | Final`.
- **Look:** dark (zinc-950 base), vivid accent gradient (fuchsia → orange), large rounded cards, playful display font (e.g. "Bricolage Grotesque", self-hosted), small motion on transitions.

---

## 3. Protocol (pinned in T01, in `shared/src/protocol/*`)

```ts
// ---------- common.ts ----------
export const PROTOCOL_VERSION = 1;
export type PlayerId = string;       // nanoid(12)
export type RoomCode = string;       // /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/
export type SubmissionId = string;   // nanoid(12), per player per round, unlinkable
export type ChunkId = string;        // client crypto.randomUUID()
export type ServerTime = number;     // epoch ms on the server clock
export type Phase = 'LOBBY' | 'DUBBING' | 'SHOWCASE' | 'ROUND_RESULTS' | 'FINAL';
export type AudioMime = 'audio/webm;codecs=opus' | 'audio/ogg;codecs=opus' | 'audio/mp4';

export interface GameSettings {
  mode: 'normal' | 'extended';
  rounds: number;          // normal: 3 (forced) | extended: 1..10
  dubbingSeconds: number;  // normal: 210 (forced) | extended: 60..360, step 15
  tags: string[];          // extended only; [] = all clips
}

export interface ClipAttribution { author: string; source: string; license: string; licenseUrl?: string }
export interface ClipInfo {
  id: string; title: string; url: string;         // "/clips/<file>"
  durationMs: number; width: number; height: number;
  posterUrl?: string; tags: string[]; attribution: ClipAttribution;
}

export interface PlayerPublic {
  id: PlayerId; name: string; isHost: boolean; connected: boolean;
  micOk: boolean; ready: boolean;
  dubDone: boolean;          // only meaningful in DUBBING
  totalScore: number;
}

export interface ChunkMeta {
  id: ChunkId;
  startMs: number;           // position on the clip timeline (immutable)
  offsetMs: number;          // leading audio to skip (recorder latency compensation)
  durationMs: number;        // audible duration after offset
  mime: AudioMime;
  bytes: number;
}
export interface ChunkRef extends ChunkMeta { url: string } // GET path, see REST

export interface ShowcaseItem {
  submissionId: SubmissionId;
  index: number; total: number;
  chunks: ChunkRef[];
  status: 'LOADING' | 'PLAYING' | 'LOCKED';
  startAt: ServerTime | null;   // set when PLAYING
  lockAt: ServerTime | null;
  votesCast: number; votersExpected: number;
}

export interface RoundResultEntry {
  submissionId: SubmissionId; playerId: PlayerId; name: string;
  avg: number | null; votes: number; points: number; empty: boolean;
}
export interface RoundResult { round: number; clip: ClipInfo; entries: RoundResultEntry[] } // sorted desc

export interface FinalResult {
  winners: PlayerId[];
  standings: { playerId: PlayerId; name: string; total: number; roundWins: number }[];
  bestDub: { round: number; clip: ClipInfo; submissionId: SubmissionId;
             playerId: PlayerId; chunks: ChunkRef[]; points: number } | null;
}

export interface Limits {
  maxPlayers: number; maxChunksPerSubmission: number;   // 8, 40
  maxChunkBytes: number; maxSubmissionBytes: number;    // 2 MiB, 16 MiB
  minChunkMs: number;                                   // 300
}

export interface YouState {
  playerId: PlayerId;
  submissionId: SubmissionId | null;   // own, current round
  manifest: ChunkMeta[];               // server's view of own manifest (restore after reload)
  uploaded: ChunkId[];
  vote: number | null;                 // own vote on current showcase item
  isOwnItem: boolean;                  // current showcase item is mine → slider disabled
  canStart: boolean; startBlockers: string[];   // host UI
}

export interface RoomSnapshot {
  rev: number; code: RoomCode; phase: Phase; hostId: PlayerId;
  settings: GameSettings; availableTags: string[]; clipCount: number;
  players: PlayerPublic[];             // join order
  round: number;                       // 0-based; -1 in LOBBY
  totalRounds: number;
  phaseEndsAt: ServerTime | null;      // DUBBING deadline, ROUND_RESULTS auto-advance
  clip: ClipInfo | null;               // current round clip
  showcase: ShowcaseItem | null;
  roundResult: RoundResult | null;
  final: FinalResult | null;
  you: YouState;
}

// ---------- c2s.ts (zod schemas; types via z.infer) ----------
export type RtcSignal =
  | { kind: 'description'; description: { type: 'offer' | 'answer' | 'rollback'; sdp?: string } }
  | { kind: 'candidate'; candidate: RTCIceCandidateInit | null };

export type C2S =
  | { t: 'hello'; v: number; code: RoomCode; token?: string; name?: string } // name required w/o token
  | { t: 'ping'; c: number }                                  // client performance.now()
  | { t: 'setName'; name: string }                            // 1..20 chars, trimmed, LOBBY
  | { t: 'micStatus'; ok: boolean }
  | { t: 'setReady'; ready: boolean }
  | { t: 'updateSettings'; settings: Partial<GameSettings> }  // host, LOBBY
  | { t: 'kick'; playerId: PlayerId }                         // host, LOBBY
  | { t: 'startGame' }                                        // host, LOBBY
  | { t: 'manifest'; round: number; chunks: ChunkMeta[] }     // DUBBING, full replace
  | { t: 'dubDone'; round: number; done: boolean }            // DUBBING
  | { t: 'preloaded'; submissionId: SubmissionId }            // SHOWCASE/LOADING
  | { t: 'vote'; submissionId: SubmissionId; score: number }  // int 0..10, PLAYING
  | { t: 'advance' }                                          // host, ROUND_RESULTS
  | { t: 'backToLobby' }                                      // host, FINAL
  | { t: 'rtc'; to: PlayerId; data: RtcSignal }               // relayed, ≤16 KB
  | { t: 'leave' };

// ---------- s2c.ts ----------
export type ErrorCode =
  | 'ROOM_NOT_FOUND' | 'ROOM_FULL' | 'GAME_IN_PROGRESS' | 'BAD_TOKEN' | 'VERSION'
  | 'NOT_HOST' | 'BAD_PHASE' | 'INVALID' | 'RATE_LIMITED' | 'START_BLOCKED'
  | 'SELF_VOTE' | 'LIMIT';

export type S2C =
  | { t: 'welcome'; v: number; playerId: PlayerId; token: string; serverNow: ServerTime;
      iceServers: RTCIceServer[]; limits: Limits }
  | { t: 'state'; state: RoomSnapshot; serverNow: ServerTime }
  | { t: 'pong'; c: number; s: ServerTime }
  | { t: 'rtc'; from: PlayerId; data: RtcSignal }
  | { t: 'voteAck'; submissionId: SubmissionId; score: number }
  | { t: 'error'; code: ErrorCode; message: string; fatal?: boolean } // fatal → client stops reconnecting
  | { t: 'kicked' };
```

**REST (`shared/src/protocol/rest.ts`: paths as builder functions plus body/response types).** Errors return `{error: ErrorCode, message}`. Auth is header `X-Player-Token`.

| Method & path | Body → Response | Notes |
|---|---|---|
| `POST /api/rooms` | `{name}` → `201 {code, playerId, token}` | Creates the room with the caller as host. 5/min/IP. `503 ROOM_FULL` when `MAX_ROOMS` is reached |
| `GET /api/rooms/:code` | → `{code, phase, playerCount, maxPlayers, joinable}` | For the join page. 60/min/IP |
| `POST /api/rooms/:code/rounds/:round/chunks/:chunkId` | raw audio, `Content-Type: AudioMime` → `201 {id, bytes}` | DUBBING of `round` only, or within `uploadGraceMs` after it. Idempotent overwrite. `413` over `maxChunkBytes` or submission total, `409 BAD_PHASE`, `401 BAD_TOKEN`, `429`. 120/min/token |
| `GET /api/rooms/:code/rounds/:round/subs/:subId/chunks/:chunkId` | → audio bytes | Owner: always. Room members: after that round's DUBBING has been finalized. Token via header or `?k=` |
| `GET /clips/:file` | → mp4 (Range) | Static from `CLIPS_DIR` |
| `GET /api/health` | → `{ok, rooms, players, uptimeS}` | |
| `WS /ws` | | Origin check (same host) |

---

## 4. Checklist

Legend: **Deps** = tasks that must be checked first. **‖** = groups that can run in parallel because their file sets don't overlap.

### Phase A: foundation
- [x] **T01: Workspace scaffold + pinned protocol** · role: impl · Deps: – · Touches: root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `.gitignore`, `.editorconfig`, `.prettierrc`, `shared/**` (package, `src/protocol/*`, `src/constants.ts`, `src/index.ts`), `server/package.json`+`tsconfig.json`+`src/main.ts` (stub), `client/package.json` (stub), `PLAN.md`, `SPEC.md`
  - Goal: workspace builds. Section 3 is implemented exactly, as zod schemas (`C2SSchema` as a discriminated union on `t`, `GameSettingsSchema`, `ChunkMetaSchema`, `ClipManifestSchema`) plus the TS types. Constants: `NORMAL_SETTINGS`, ranges, `LIMITS`, `ROOM_CODE_ALPHABET`.
  - `.gitignore`: `node_modules`, `dist`, `clips/*.mp4`, `.cache`, `e2e/fixtures/clips/*.mp4`, `test-results`.
  - Accept: `pnpm install && pnpm typecheck && pnpm test` (shared has a schema round-trip test, e.g. a valid and an invalid `vote`).
  > NOTE T01: `@dub/shared` has no build step: its `exports` point at `src/index.ts` (relative imports use `.js` suffixes so nodenext, tsx and Vite all resolve them); the prod server image (T20) must bundle the server with esbuild so shared is inlined. All §2 libraries are pinned in T01 (one lockfile); `vitest.config.ts` with `test.projects` replaces `vitest.workspace.ts`; `allowBuilds: esbuild` is set in `pnpm-workspace.yaml` (pnpm 11).

### Phase B (‖ after T01: T02, T03, T04, T09)
- [x] **T02: Shared pure helpers** · impl · Deps: T01 · Touches: `shared/src/helpers/**`, `shared/test/**`
  - `generateRoomCode(rng)`, `scoreSubmission(votes)` → `{avg, votes, points}`, `buildRoundResult`, `buildFinal` (tie-breaks per §2.2), `pickClip(library, tags, used, rng)`, `availableClipCount`, `layoutLanes(chunks)` → `Map<id, lane>`, `planSchedule(chunks, mediaMs, rate)`, `clockOffset(samples)`, `voiceAllowed(phase, showcaseStatus)`, `validateManifest(chunks, clipDurationMs, limits)`, `formatClock(ms)`.
  - Accept: `pnpm --filter shared test` with ≥30 cases. Must include: zero-vote → 50, empty → 0, tie → roundWins, overlapping lanes, schedule mid-chunk with offsetMs at 2×.
  > NOTE T02: exported from `@dub/shared` via `shared/src/index.ts`. Filter is `pnpm --filter @dub/shared test`. Signatures: `planSchedule(chunks, mediaTimeMs, rate)` → `{chunkId, whenDelaySec, bufferOffsetSec, durationSec}[]`; `layoutLanes(chunks)` → `Map<id, lane>` (+ `laneCount`); `clockOffset([{c0,c1,s}])` → `{offset, rtt} | null` (server ≈ client + offset); `voiceAllowed(phase, showcaseStatus?)`; `validateManifest` → `{ok:true, chunks(sorted)} | {ok:false, reason}`; `buildFinal(players, roundResults, chunksOf)`; `formatClock(ms, 'floor'|'ceil')`.
- [x] **T03: Clip scripts + manifest** · impl · Deps: T01 · Touches: `scripts/fetch-clips.mjs`, `scripts/clips.sources.json`, `scripts/make-test-clip.sh`, `clips/manifest.json`, `clips/README.md`
  - `clips.sources.json` lists sources (direct download URL, cut list `[{id,title,ss,t,tags}]`, and attribution):
    - Blender open movies, CC-BY: Big Buck Bunny, Sintel, Tears of Steel (dialogue-rich, good for dubbing), Elephants Dream (download.blender.org, 720p/480p variants).
    - Public-domain dialogue scenes from archive.org: *His Girl Friday* (1940), *Charade* (1963), *Night of the Living Dead* (1968), *Plan 9 from Outer Space*.
    - Aim for 8–12 clips of 15–45 s.
  - Script: download into `.cache/clip-sources/`, an empty dir of its own (untrusted data; ffmpeg gets explicit paths). Run `ffmpeg -ss … -t … -vf scale=-2:'min(720,ih)' -c:v libx264 -crf 26 -preset veryfast -c:a aac -b:a 96k -movflags +faststart`. `ffprobe` provides durationMs/width/height. The script writes `clips/manifest.json` and merges any owner entries (`"local": true` entries are preserved).
  - `make-test-clip.sh <outdir>`: 8 s `testsrc2` + 440 Hz sine at 640×360, plus a manifest with 3 entries pointing at copies, for e2e.
  - Accept: `bash scripts/make-test-clip.sh e2e/fixtures/clips && ffprobe e2e/fixtures/clips/test-a.mp4`. `node scripts/fetch-clips.mjs --dry-run` prints its plan. A real run produces ≥6 clips, each ≤60 s and ≤720p.
  > NOTE T03: 12 clips (6 Blender CC BY, 6 PD from archive.org), ~34 MB in `clips/` plus a `<id>.jpg` poster each (`clips/*.jpg` gitignored). fetch-clips.mjs fetches only the cut segment (ffmpeg input seek over HTTPS range requests, stream copy) into `.cache/clip-sources/`, then encodes to fit inside 1280x720. `make-test-clip.sh` writes posters too; `e2e/fixtures/clips/` is fully gitignored. For T20/T22: clips are not in the repo, so rsync `clips/*.{mp4,jpg}` + `manifest.json` to the host.
- [x] **T04: Server skeleton** · impl · Deps: T01 · Touches: `server/src/{main,config}.ts`, `server/src/http/app.ts`, `server/src/routes/clips.ts`, `server/src/clips/ClipLibrary.ts`, `server/src/security/rateLimit.ts`, stub files `server/src/routes/{rooms,chunks}.ts` + `server/src/ws/gateway.ts` (each exports `register(app, deps)` doing nothing), `server/test/clips.test.ts`
  - `app.ts` builds Fastify with `deps = {config, clips, rooms?, store?}` and registers all four route modules, **so later tasks only fill in their own file**. It also handles: health, static client and SPA fallback, `/clips` with Range, trustProxy, rate-limit plugin, and global body limit 2.5 MiB.
  - Accept: `pnpm --filter server test` (manifest validation and a Range request returning 206) and `pnpm --filter server dev` → `curl -s localhost:3000/api/health`.
  > NOTE T04: added `server/src/bootstrap.ts` (`startServer(config)` → `{app,url,port,close}`, used by main.ts and T08) and `server/test/helpers.ts` (temp clips dir / test config). Extra env: `ALLOW_SHORT_DUBBING` (defaults on with `TIMINGS=fast`), `MAX_ROOMS`, `LOG_LEVEL`. Defaults: `CLIPS_DIR=<repo>/clips`, `DATA_DIR=<repo>/.cache/data`, `CLIENT_DIST=<repo>/client/dist`. `/clips/:file` only serves manifest-listed files.
- [x] **T09: Client skeleton + design system** · impl · Deps: T01 · Touches: `client/**` except `src/{net,state,audio,dub,editor,voice,render}/**` and phase pages
  - Vite + React + TS + Tailwind 4, `@/` alias, dev proxy (`/api`, `/clips`, `/ws` with `ws:true` → :3000).
  - UI components in `src/components/ui/` and the theme. Router: `/` → `pages/Home.tsx` placeholder, `/r/:code` → `pages/Room.tsx`, which switches on phase into placeholder components `pages/phases/{Lobby,Dubbing,Showcase,RoundResults,Final}.tsx` (each owned by a later task).
  - Shell layout: logo and an attribution footer link. Root `pnpm dev` runs server and client concurrently.
  - Accept: `pnpm --filter client build`, `pnpm typecheck`. A screenshot of `/` with the dark theme looks right.

### Phase C: server core (T05 → T06 ‖ T07 → T08)
- [x] **T05: Room state machine** · impl · Deps: T02 · Touches: `server/src/room/{Room,timers,types}.ts`, `server/test/room.test.ts`
  - The whole of §2.2 as a pure class: join, reconnect, kick, host migration, settings validation (normal forces 3/210), start blockers, dubbing (manifest storage, dubDone early end, finalize with an `isUploaded(subId, chunkId)` dependency), showcase sub-phases and voting rules, results, final, backToLobby, per-recipient snapshot builder.
  - Accept: `pnpm --filter server test room` with vitest fake timers: a 3-player game through every phase. Must cover: self-vote rejected, vote after lock rejected, auto-advance, disconnect/reconnect mid-DUBBING keeps the manifest, clip non-repeat across rounds and after backToLobby, `ALLOW_SOLO`.
  > NOTE T05: during the upload grace the phase stays `DUBBING` (with `phaseEndsAt` pulled to now when everyone is done); `snapshot.clipCount` = clips still available for the current tag filter (minus used). Duplicate names get a ` 2` suffix. `leave` removes in LOBBY, otherwise counts as disconnect. Room API used by T06/T07: `join/connect/disconnect/leave/handle/authenticate/info/uploadTarget/canDownload/notify/resend/dispose`.
- [x] **T06: RoomManager + WS gateway + rooms REST** · impl · Deps: T04, T05 · Touches: `server/src/room/RoomManager.ts`, `server/src/ws/gateway.ts`, `server/src/routes/rooms.ts`, `server/test/gateway.test.ts`
  - Covers: codes, caps, disposal (calls `store.deleteRoom` when available), token→player, zod parsing, per-socket rate limit, message size cap, Origin check, `rtc` relay (same room only, ≤16 KB), ping/pong, welcome with `ICE_SERVERS`.
  - Accept: test that creates a room via `inject`, connects 2 `ws` clients, and checks state broadcast, relay, `ROOM_FULL` on the 9th, a bad message → `INVALID`, and token reconnect.
  > NOTE T06: hello with an unknown token but a `name` joins as a new player; without a name it is `BAD_TOKEN` (fatal). Fatal errors close with 4100; a replaced socket closes with 4000, kicked/removed 4001, room disposed 4004 (after a fatal `ROOM_NOT_FOUND`). WS without `Origin` is allowed (non-browser); otherwise Origin host must equal `Host`/`X-Forwarded-Host`. `welcome` comes before the first `state`. Test WS client in `server/test/wsClient.ts`.
- [x] **T07: Chunk store + upload/download routes** · impl · Deps: T04, T05 · Touches: `server/src/uploads/ChunkStore.ts`, `server/src/routes/chunks.ts`, `server/test/chunks.test.ts`
  - Raw-body parser for the three mimes. Enforces size and count limits and the auth rules in §3. Writes atomically (tmp + rename). Exposes `isUploaded`, `deleteRoom`, and a startup wipe.
  - Accept: tests for 201, 413, 409 outside DUBBING, 401, owner-only GET during DUBBING, member GET after finalize.
  > NOTE T07: upload auth/phase/mime are checked in `onRequest` (before the body is read). Status codes: 401 BAD_TOKEN, 404 ROOM_NOT_FOUND/unknown chunk, 409 BAD_PHASE (upload), 403 BAD_PHASE (download before finalize), 413 LIMIT, 415 bad Content-Type, 400 INVALID. Content-Type parameters are normalized (`audio/ogg; codecs=opus` ok). Downloads are `Cache-Control: private, no-cache`. A successful upload pushes a fresh snapshot to the uploader (`you.uploaded`).
- [x] **T08: WS integration test: full game** · test · Deps: T06, T07 · Touches: `server/test/integration/fullGame.test.ts`, `server/test/integration/fakeClient.ts`
  - Starts the real server on port 0 with `TIMINGS=fast`, the fixture clips dir and a temp DATA_DIR. Three `FakeClient`s do hello, mic/ready, start, upload 2 chunks each (dummy bytes), manifest, dubDone, preloaded, vote, and run 2 rounds to FINAL. Also covers one client dropping and reconnecting by token mid-round.
  - Accept: `pnpm --filter server test integration` green in under 20 s.
  > NOTE T08: fixture clips are generated by the test itself (`makeFixtureClips`: 0.5 s ffmpeg testsrc2+sine into a temp dir, dummy bytes if ffmpeg is missing) so it does not depend on T03; the run takes ~12 s, most of it the fast-timing showcase waits.

### Phase D: client (‖: T10 & T11 & T13 after T09; then T12, T14, T16, T18 ‖ where deps allow)
- [x] **T10: Net layer, store, Home & join flow** · impl · Deps: T09 (T06 for live testing) · Touches: `client/src/net/**`, `client/src/state/**`, `client/src/pages/Home.tsx`, `client/src/pages/Room.tsx`, `client/test/net.test.ts`
  - Socket with backoff, clock sync, `serverToPerf`, `useRoom()` selectors, error toasts, fatal error screen (`ROOM_NOT_FOUND` → back home).
  - Name prompt when there is no token. Invite link copy button (`/r/CODE`). Create and join both unlock the AudioContext (this calls `audio/context.ts`, which is created here as a minimal file and extended by T11; T11 owns it afterwards).
  - Accept: vitest for the clock-offset wiring and reconnect logic (mock WebSocket). Manually: two tabs join the same room and see each other.
  > NOTE T10: `net/socket.ts` (`RoomSocket`, injectable deps) + `state/session.ts` singleton: `joinRoom/releaseRoom/leaveRoom`, `send(msg)`, `setSticky(key,msg)` (re-sent after every welcome), `onServerMessage(type,fn)` (survives reconnects), `serverToPerf/serverNow`. Store `state/room.ts`: `useRoom(sel)`, `useSnapshot/usePhase/useMe/useYou/usePlayers/useIsHost/useConnStatus`, `lastVoteAck`, `iceServers`, `limits`. Fatal codes or `kicked` stop reconnecting; BAD_TOKEN clears the token and re-shows the name prompt. Verified against a throwaway mock gateway (real T05 `Room`) since T06 had not landed.
- [x] **T11: Audio foundation: mic, meter, recorder** · impl · Deps: T09 (T10 if `context.ts` exists) · Touches: `client/src/audio/**`, `client/src/components/MicCheck.tsx`, `client/test/audio.test.ts`
  - Mic acquisition with the constraints in §2.3, `LevelMeter` component, micOk detection, `pickRecorderMime`, a `Recorder` class that returns `{blob, mime, offsetMs, durationMs}` (it takes a `startVideo()` callback and implements the latency compensation in §2.3), and the sound-unlock overlay.
  - Accept: unit tests for mime picking and the micOk detector (fed synthetic RMS series). Manual MicCheck works in Chrome and Firefox.
  > NOTE T11: `audio/context.ts` (`getAudioContext`, `unlockAudio`, `onAudioStateChange`), `audio/mic.ts` (`acquireMic`, `getMicStream`, `getMicLevelDb`, `useMic` store; reports `micStatus` via a session sticky), `audio/levels.ts` (pure `MicOkDetector`: cumulative 300 ms > -50 dBFS within 5 s, latched until the mic is lost), `audio/recorder.ts` (`pickRecorderMime`, `Recorder.start(startVideo)/stop()/cancel()`, `playAndWaitFirstFrame(video)`), `audio/LevelMeter.tsx`, `audio/SoundUnlockOverlay.tsx` (mounted in `Room.tsx`). MicCheck auto-reopens the mic when permission is already granted. Verified in headless Chromium (fake device); Firefox not checked here (T21).
- [x] **T12: Lobby UI** · impl · Deps: T10, T11 · Touches: `client/src/pages/phases/Lobby.tsx`, `client/src/components/lobby/**`
  - Player cards (host crown, mic/ready badges, connection, voice status slot), MicCheck panel, Ready toggle (disabled until micOk), host-only settings (Normal/Extended switch; rounds, dubbing time and tag multi-select), start button showing `startBlockers` as tooltip/text, kick, invite link with QR-free copy button, clip attribution note.
  - Accept: `pnpm --filter client build`. Manually: 2 tabs; start enables only when both are ready.
  > NOTE T12: `components/VoiceStatus.tsx` is a null stub rendered on each player card (`{playerId,isSelf}`); T18 replaces the file. Dubbing time has a slider (60–360/15) plus a seconds input (`dubbing-seconds-input`, accepts ≥5 for ALLOW_SHORT_DUBBING; server rejects otherwise). Verified with two headless Chromium contexts against the real T06 server: mic/ready gating, settings reset readiness, kick, start → DUBBING.
- [x] **T13: DubPlayer engine + chunk loader** · impl · Deps: T02, T09 · Touches: `client/src/dub/**`, `client/test/dubPlayer.test.ts`
  - Covers §2.3 DubPlayer: editor mode (follows the video element) and synced mode (follows a server `startAt`), the drift watchdog, `setOutput(node)` for rendering, and `dispose()`. Also the chunk loader with decode and peaks.
  - Accept: tests with a fake AudioContext/video (event emitter) assert that `start()` calls match `planSchedule` after seek, rate change and pause. A dev page `/dev/player` (behind `import.meta.env.DEV`) plays the test clip with two synthetic chunks.
  > NOTE T13: `dub/{DubPlayer,chunkLoader,types,DevPlayerPage}`; route `/dev/player` added to `App.tsx` (lazy, DEV only). Engine waits until `video.currentTime` advances before anchoring audio (`waitForMotion`), compensates `outputLatency+baseLatency`, re-checks drift 150/400 ms after each schedule. Verified headless (Playwright Chromium, which has **no H.264/AAC**, so dev/e2e clips must be VP9/Opus webm): steady 1×/1.5× drift within ±30 ms; the wait-for-motion change itself is not yet re-measured. Chunk cache: `loadChunks/loadChunkAudio/primeChunkCache` (LRU by URL, 96 MB).
- [x] **T14: Editor: transport, timeline, preview** · impl · Deps: T13 · Touches: `client/src/editor/{Editor,Timeline,Transport,ChunkBlock,useEditorKeys,editorStore}.tsx?`, `client/src/pages/phases/Dubbing.tsx`
  - Video area, reference audio toggle and volume with the headphones hint, timeline (ruler, playhead, scrub, lanes, waveforms, selection), ±5 s, speeds, all shortcuts, countdown and Done button.
  - Accept: `pnpm --filter client build`. Unit test of `editorStore` reducers (select, delete, replace). In the dev route with injected fake chunks, scrubbing and 2× preview stay in sync, checked by ear and by watchdog logs showing fewer than 1 resync per 5 s while playing.
  > NOTE T14: `editor/editorStore.ts` = pure reducers (`selectChunk/deleteChunk/addOrReplaceChunk/patchChunk/resetFor`) + zustand `useEditor` + non-reactive `media` ({video, player}) + imperative `transport` (play/pause/seek coalesced while seeking/nudge/setSpeed/ref audio). The cursor is `video.currentTime`; playhead and time readout are rAF-driven from `mediaNowMs()` (audio clock while running). `Editor` takes recording hooks as props (`onRecord/onRerecord/onDelete/onRetry/onDeadline`), wired by `Dubbing.tsx`. Timeline zooms 1–8× (Ctrl+wheel). Extra keys: `End`, `[`/`]` cycle selection. No `/dev/editor` route (App.tsx not owned): in DEV `window.__dubEditor` exposes the store and `dubLog`; checked headless in a solo game with injected beep chunks: 0 resyncs over 3 s at 1× and 4.5 s at 2×, 1 after resuming a scrub at 2×.
- [x] **T15: Editor: recording, re-record, upload & restore** · impl · Deps: T14, T11, T10, T07 · Touches: `client/src/editor/{recording,uploadQueue,restore}.ts`, small hooks in `Editor.tsx`/`Transport.tsx` (T14 must be done, so there is no conflict)
  - Record from cursor at 1×. Stops at clip end, on R/Esc, or at the deadline. Discards chunks under minimum length. Re-records the selected chunk. Then: upload, then `manifest`. Shows per-chunk status (uploading / ok / failed, with a retry button). After a reload it rebuilds from `you.manifest`. Enforces the limits in the UI.
  - Accept: unit test of the uploadQueue (retry, manifest only lists uploaded or pending chunks, deleted chunks drop out). Manual with a real mic: record 3 overlapping chunks, delete one, re-record one, reload the page, and all chunks are still there.
  > NOTE T15: `recording.ts` (module singleton set up by `configureRecording`; `toggleRecording/startRecording(replacingId)/stopRecording/cancelRecording/onDeadline`). The re-recorded chunk is muted during the take; Esc/R stop and keep the take, the X button discards it (a re-record then keeps the old one); at the deadline the take is kept and new takes are locked. `uploadQueue.ts` (`UploadQueue`: 3 retries 0.5/1.5/3 s, 4xx except 408/429 are final; the manifest = uploaded + pending, re-sent after each upload; one queue per `code:round:submissionId` via `acquire/releaseUploadQueue` so StrictMode remounts don't dispose it). The manifest is sent as `setSticky('manifest')` (re-sent on reconnect, cleared on leaving DUBBING). `restore.ts` re-downloads `you.manifest ∩ you.uploaded`; chunks that never finished uploading are dropped and the manifest is corrected. Done stops the take and waits for uploads before `dubDone`. Verified headless (solo, fake mic): 2 overlapping takes, delete, re-record, a <300 ms take discarded, reload restores the same ids/positions, Done ends the phase. T19: wait for `[data-testid=upload-status][data-state=saved]` before Done / reload.
- [x] **T16: Showcase + voting** · impl · Deps: T13, T10 · Touches: `client/src/pages/phases/Showcase.tsx`, `client/src/components/showcase/**`
  - "Dub 2 of 5" header. LOADING: preload the video (`canplaythrough`) and decode chunks, then send `preloaded`. PLAYING: synced playback with muted video. A 0–10 slider that starts untouched, debounced at 150 ms, with the `voteAck` value shown. On own item, "This one's yours" with the slider disabled. LOCKED: "Locked in" animation. Shows the votesCast/expected counter.
  - Accept: build. Manually, 2 tabs on one machine start within about 100 ms of each other by ear.
  > NOTE T16: `components/showcase/{useShowcasePlayback,VotePanel,ClipAttribution,showcaseHistory,useServerNow}`. One muted `<video>` + DubPlayer for the whole phase; chunks load without an abort signal (the URL cache is shared, an aborted fetch would poison it). Test IDs: `showcase-status` (`data-status`), `vote-slider`, `vote-pick-0..10` (quick buttons, easiest for e2e), `vote-value`, `vote-ack`, `vote-locked`, `own-item-notice`, `vote-count`, `showcase-video`. `showcaseHistory` remembers show order + own vote per round for T17. In DEV `window.__showcasePlayer` exposes the engine. Verified headless (2 Chromium contexts + fake ws player, VP9 clip): both tabs track the server timeline within ~1 ms of each other (steady -40 ms vs expected, same on both).
- [x] **T17: Round results, Final, Save video** · impl · Deps: T16 · Touches: `client/src/pages/phases/{RoundResults,Final}.tsx`, `client/src/render/**`, `client/src/components/results/**`
  - Round results: animated reveal of authors and points, leaderboard deltas, host "Next" button, auto-advance countdown.
  - Final: winner celebration, standings, replay of bestDub (local DubPlayer, play button), "Save video" button (render per §2.3, progress, download), host "Back to lobby".
  - Accept: build, plus a vitest for the `pickRenderMime` helper. Manually: the downloaded webm plays in VLC/Chrome with the dub audio in sync.
  > NOTE T17: `components/results/{RevealList,Leaderboard(buildStandings),BestDubReplay(useDubChunks),SaveVideo,motion,results.css}`, `render/renderDub.ts` (`pickRenderMime/renderFileName/renderSize/renderDub/downloadBlob`; burns the clip credit + a "Voicejack" mark into the video; file `voicejack-<clip>-<name>.webm`; a zero ConstantSource keeps the audio track alive through silence; `html[data-rendering]` drops glass/blur effects while rendering). Test IDs: `results-list`, `result-entry`, `results-next` (host), `results-countdown`, `leaderboard`, `final`, `final-winner`, `final-standings`, `replay`, `replay-play`, `save-video`, `save-video-panel` (`data-state`), `save-progress`, `back-to-lobby`. Verified headless to FINAL with 2 rounds: webm is VP9+Opus, dub audio present and track covers the whole clip. Headless software rendering only reaches ~10-20 fps in the render (big CSS blurs); real-GPU browsers and the A/V sync check in VLC are left for T21.
- [x] **T18: Voice chat mesh** · impl · Deps: T10, T11 · Touches: `client/src/voice/**`, `client/src/components/VoiceStatus.tsx`, one `<VoiceProvider>` line in `pages/Room.tsx` (coordinate: T10 owns `Room.tsx` and adds `{/* VOICE_SLOT */}`, which T18 replaces)
  - Perfect negotiation, peers follow the roster, gating via `voiceAllowed`, per-peer state, speaking indicator (an AnalyserNode on each remote stream), and a self-mute button in allowed phases.
  - Accept: unit test of the gating policy and of roster diffing (which peers to open or close). Manually, 2 Chrome profiles hear each other in the lobby, and the voice is silent during DUBBING and while a clip plays.
  > NOTE T18: done. `voice/{voicePolicy,voiceStore,Peer,VoiceMesh,VoiceProvider}`, `components/VoiceStatus.tsx` (connection dot `voice-status[data-state]`, speaking bars, per-peer mute `voice-peer-mute`), floating dock `voice-dock[data-allowed]` with self-mute `voice-self-mute`; remote `<audio>` in `[data-testid=voice-audio]`. Voice sends a clone of the mic track; gating runs synchronously in the store subscription. Unit tests `client/test/voice.test.ts`. Verified with two headless Chromium contexts (`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --disable-features=WebRtcHideLocalIpsWithMdns`): pcs reach `connected`, audio elements get a live track and inbound RTP bytes grow, peer/self mute work, DUBBING disables the sender track and mutes remote audio with the pc staying connected, voice is back on after DUBBING. The dock (fixed bottom-left) overlaps the footer tagline; T21 may want footer padding.

### Phase E: end-to-end, ship
- [x] **T19: Playwright e2e smoke** · test · Deps: T12, T15, T16, T17 · Touches: `e2e/**`
  - `webServer`: build client, then start the server with `TIMINGS=fast CLIPS_DIR=e2e/fixtures/clips` (fixtures generated in `globalSetup` via `make-test-clip.sh`). Chromium args `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required`.
  - Three contexts run: create, join via the invite URL, mic OK (the fake beep), ready, start (extended: 1 round, 15 s dubbing). Each records one chunk (press R, wait 2 s, press R), then clicks Done. They vote in the showcase. The test asserts on round results and then the Final view. A second spec covers reload during DUBBING keeping the chunk.
  - Stable `data-testid`s should be added by the owning tasks; if any are missing, add them here as minimal edits.
  - Accept: `pnpm e2e` green headless in under 2 min.
  > NOTE T19 (orchestrator): Playwright's bundled Chromium has no H.264/AAC, so e2e fixture clips must be VP9/Opus webm (see T13 note, `.cache/dev-clips`); real Chrome/Firefox play the mp4 library fine. Voice check for T18 may need `--disable-features=WebRtcHideLocalIpsWithMdns`.
  > NOTE T19: `pnpm e2e` = `playwright test -c e2e/playwright.config.ts`. `e2e/scripts/serve.sh` (webServer) makes VP9/Opus fixtures via `e2e/scripts/make-fixtures.sh`, builds the client into `$E2E_TMP/dist` (not `client/dist`) and runs the server on 127.0.0.1:`E2E_PORT` (4791) with TIMINGS=fast; scratch dir `E2E_TMP` (default `$TMPDIR/voicejack-e2e`). Specs: `full-game` (3 players, deterministic votes 10/6/2 → final standings 100/60/20, voice off in DUBBING / on in showcase), `reload-dubbing`, `voice` (2 contexts, pcs connected, live remote track). Fast timings make LOCKED (200 ms) and ROUND_RESULTS (1 s) too short to poll, so the showcase is checked from a MutationObserver log (`window.__showcaseLog`) and `results-next` is not clicked. ~1 min, 3× green.
- [x] **T20: Docker image + compose + nginx** · impl · Deps: T06, T07, T09 · Touches: `deploy/**`, `.dockerignore`, root `package.json` (`docker:build` script only)
  - Multi-stage on `node:24-alpine`: build with `pnpm -r build`, then `pnpm deploy --filter server --prod /out`, and copy `client/dist`. Runtime runs as non-root with `tini`, `NODE_OPTIONS=--max-old-space-size=192`, and a healthcheck on `/api/health`.
  - `compose.yaml`: `ports: ["127.0.0.1:${PORT:-3087}:3000"]`, `mem_limit: 320m`, `cpus: 1.0`, volumes `./clips:/app/clips:ro` and `./data:/app/data`, `restart: unless-stopped`.
  - `nginx/dub.borbus.eu.conf`: `client_max_body_size 4m`; `location /ws` with `proxy_http_version 1.1`, Upgrade/Connection headers and `proxy_read_timeout 1h`; `limit_req_zone` for `/api/rooms` (5r/m) and the general API; `X-Forwarded-For`.
  - `README-deploy.md`: the A record `dub.borbus.eu` at goneo **(manual, owner)**, `certbot --nginx -d dub.borbus.eu`, rsync clips, and "read `ARCHITECTURE.md` on the box first; check free port with `ss -ltn`".
  - Accept: `docker build -f deploy/Dockerfile -t dubparty .` then `docker run -p 127.0.0.1:3087:3000 -v $PWD/e2e/fixtures/clips:/app/clips:ro dubparty`, then `curl localhost:3087/api/health`. Image under 200 MB, and the idle container uses under 80 MB RSS (`docker stats`).
  > NOTE T20: server is bundled into one `server.mjs` by `deploy/bundle-server.mjs` (esbuild resolved via tsx) instead of `pnpm deploy`, so the runtime has no node_modules; image ~169 MB, idle ~26 MiB. `DATA_DIR=/app/data/uploads` (startup wipe cannot rm a mount point); `TRUST_PROXY=loopback,uniquelocal` (nginx arrives via the Docker bridge). Port 3087; `dub.borbus.eu` is already DNS + a SAN of the `borbus` cert, so no certbot. Deploy steps + ARCHITECTURE.md drafts in `deploy/README-deploy.md`.
- [ ] **T21: Cross-browser verification & polish** · verify · Deps: T18, T19 · Touches: small fixes anywhere (list them in the commit), `docs/manual-test.md`
  - Manual checklist on Chrome and Firefox (the ogg/opus path): Firefox-recorded chunks play back in Chrome and the other way round. Check echo with speakers vs headphones, the autoplay overlay after reload, a 2-player voice call over 2 networks (e.g. phone hotspot), mobile layout sanity, and attributions visible.
  - Accept: `pnpm typecheck && pnpm test && pnpm e2e`, with the checklist filled in.
- [ ] **T23: Rebrand DubParty → Voicejack** · impl · Deps: T17, T19 · Touches: user-facing strings anywhere, `deploy/**`, README/SPEC/PLAN headings
  - "Dub Party" exists on Steam, so the product is **Voicejack** (owner, 2026-10-17). Sweep titles, logo, copy, render watermark, download filename, meta/OG tags, Docker/compose name, vhost `voicejack.borbus.eu` (+ `dub.borbus.eu` 301). Internal identifiers (`@dub/shared`, `dub.*` storage keys, `src/dub/`) stay. Issue #37.
  - Accept: `grep -rniE 'dub ?party' --exclude-dir=node_modules --exclude-dir=.git .` only hits history notes; typecheck/test/build/e2e green.
- [ ] **T22: Deploy to Hetzner** · verify · Deps: T20, T21, owner has added the DNS A record · Touches: `deploy/README-deploy.md` (notes only)
  - On the host: `/opt/dubbing-game` gets compose, `.env` and clips (run `fetch-clips.mjs` locally, rsync the mp4s and manifest), then `docker compose up -d --build` (or load the image), nginx vhost, `nginx -t && systemctl reload nginx`, certbot.
  - Accept: `curl -sf https://dub.borbus.eu/api/health`. A WS upgrade works (`wscat` or a browser game with 2 devices). The container's memory stays under its limit.

**Parallel lanes summary:**
- After T01: {T02, T03, T04, T09}.
- After T02/T04: {T05 → (T06 ‖ T07) → T08} runs alongside the client lane {T10 ‖ T11 ‖ T13} → {T12, T14, T16, T18} → {T15, T17}.
- T20 can start once T06/T07/T09 are done.
- T19, T21 and T22 come last.

---

## 5. Risks and the chosen mitigations

| Risk | Mitigation |
|---|---|
| **A/V sync** (editor/showcase drift, recorder start latency) | One `DubPlayer` engine. The schedule is computed from `video.currentTime` by the pure, unit-tested `planSchedule`. All sources are rescheduled on every seek, rate change or stall, and a 250 ms watchdog resyncs above 60 ms drift. Recording start latency is measured (`onstart` → first video frame) and stored as `offsetMs`. Showcase uses NTP-style clock offset (min-RTT of ≥5 pings), absolute `startAt` with a 1.5 s lead, and a seek correction above 150 ms. |
| **Autoplay policies** | AudioContext is created and resumed on the Create/Join/MicCheck click. Showcase videos are always `muted` (only the dub is audible, via WebAudio). If `ctx.state !== 'running'` (reload or rejoin), a full-screen "Tap to enable sound" overlay appears. Remote voice `<audio>` elements are `play()`ed after that gesture. |
| **MediaRecorder codecs differ** (Chrome webm/opus, Firefox ogg or webm/opus, Safari mp4/aac) | Picked with `isTypeSupported` from a fixed list. The server accepts exactly 3 mimes and stores each chunk's mime. Playback always goes through `decodeAudioData`: if decode fails, the chunk is skipped and a toast is shown, and the round continues. Chrome/Firefox are the primary targets and are cross-checked in T21; Safari is best effort. Render output is webm (vp9/vp8+opus), with mp4 as Safari's fallback. |
| **Echo / reference bleed** | Constraints are `echoCancellation/noiseSuppression/autoGainControl: true`. The editor shows a headphones hint. The reference audio defaults to 0.15 volume and has a toggle. Voice chat is gated off during DUBBING and while a clip plays, so it cannot leak into recordings or showcase. |
| **NAT without TURN** (symmetric NAT/CGNAT, some mobile networks: those peer links fail) | Public STUN only, by design (no new firewall ports). Voice is non-essential: the game runs entirely over WS/HTTP. Each peer shows "no direct route" when ICE fails. `ICE_SERVERS` is env-configurable and sent in `welcome`, so a TURN server can be added later with no client change. This is documented in the deploy README. |
| **Server load on a shared 2 vCPU / 3.7 GB box** | No transcoding on the server, uploads stored on disk, caps of 30 rooms × 8 players, chunk/submission size limits, rate limits in both nginx and Fastify, `mem_limit 320m`, a cleanup timer, and a startup wipe of DATA_DIR. |
| **Abuse of a public endpoint** | Room-create rate limit, unguessable tokens, unlinkable anonymous submission IDs, per-socket message rate and size caps, Origin check on WS, upload auth per token, room lifetime caps. |
| **Clip licensing** | Only CC-BY or PD sources go in `clips.sources.json`, with attribution in the manifest that is shown in the UI. Owner memes are marked `"local": true`, gitignored and never shipped in the image (clips are a mounted volume). |
| **Losing work on reload / disconnect during DUBBING** | Each chunk is uploaded immediately, the server keeps the manifest, the snapshot carries `you.manifest`, and the client re-downloads its own chunks. At the deadline the server auto-commits `manifest ∩ uploaded` after `uploadGraceMs`. |
| **Agent sessions interrupted** | Small tasks, one commit each with checklist and code together, explicit file ownership, protocol frozen in T01, plus the Resuming procedure in §1. |

### Critical files for implementation
- `/home/marcel/projects/dubbing-game/shared/src/protocol/` (`common.ts`, `c2s.ts`, `s2c.ts`, `rest.ts`): the contract that every parallel lane depends on
- `/home/marcel/projects/dubbing-game/server/src/room/Room.ts`: the server-side game state machine, scoring and voting rules
- `/home/marcel/projects/dubbing-game/client/src/dub/DubPlayer.ts`: one playback/sync engine reused by the editor, showcase, final replay and render
- `/home/marcel/projects/dubbing-game/client/src/editor/Editor.tsx` (with `recording.ts`, `uploadQueue.ts`): the core editor and its recording/upload path
- `/home/marcel/projects/dubbing-game/server/src/http/app.ts`: route/WS registration, created in final form in T04 so later tasks only fill in their own files

