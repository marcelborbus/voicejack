# Voicejack (formerly DubParty) v1.1 — plan

Source: owner's Issue Inbox (#23), 2026-10-17. Owner decisions: login = **email magic link only**;
voice with strangers in public games = **opt-in, muted by default**; custom libraries = **hosts
upload their own clips**.

**Gate:** no v1.1 implementation starts before v1 is verified and deployed (T22 done, `pnpm e2e`
green on main, tag `v1.0`). Conventions as in PLAN.md §1 (one commit per task, `Vxx:` prefix,
`Closes #N`, own paths only). Issues: label `v1.1`, milestone "v1.1".

### Architecture changes
- **Persistence:** SQLite via Node 24 built-in `node:sqlite` (no native build), file
  `/app/data/db/voicejack.sqlite` (outside the wiped uploads dir); add to `/opt/backups`. Tiny
  migration runner in `server/src/db/`.
- **Accounts:** email magic link (15-min single-use token, hashed in DB) sent through the host's
  Postfix relay as `noreply@borbus.eu` (ARCHITECTURE §7 "Reaching it from containers").
  HttpOnly session cookie (30 d). **Guest profiles**: every browser gets a guest account row +
  cookie; registering claims it (Elo/history kept).
- **Global presence socket** `/ws/presence` (home page): online count, queue count, friends'
  status, DMs. Room socket stays as-is.
- **Admin**: `/admin/*` client route + `/api/admin/*`, gated by **Authelia at nginx**
  (`authelia-authrequest.conf`, group `admins`) and re-checked server-side via `Remote-Groups`
  header (only trusted from loopback/docker proxy) — same pattern as marcel.borbus.eu.
- **Clip storage**: libraries in DB; files in `/app/data/clips/<libraryId>/`. Uploads normalized
  server-side by ffmpeg (alpine pkg in image, one job at a time, `nice`, ≤60 s, ≤720p, H.264/AAC +
  VP9/Opus not needed). Raise `mem_limit` to ~450m; check box RAM first.
- Legal (Germany, accounts + donations): **Impressum + Datenschutzerklärung** pages, account
  deletion, notice-and-takedown contact for uploaded clips. Required before public launch of v1.1.

### Tasks (v1.1)
| ID | Task | Deps |
|---|---|---|
| V01 | **Bots / dev test mode**: host can add 1–7 bots to a private room (button only when `DEV_BOTS=1` or user is admin). Bots: auto micOk/ready, during DUBBING upload 2–5 chunks cut from a pre-extracted pool of clip audio snippets (`scripts/make-bot-sounds.mjs`, ffmpeg → opus webm) at random offsets, vote randomly 3–9, never voice. Server-side `BotPlayer` using the same Room API as the FakeClient in `server/test/integration/fakeClient.ts`. | v1 |
| V02 | **Design pass**: Designer agent writes `docs/design-v1.1.md` (skribbl-ish playful energy, own identity: doodle accents, avatar builder, bold colours, sounds/juice, share card/OG image, invite-friendly), keeps current buttons; then apply across pages. | v1 |
| V03 | **DB + migrations + guest profiles** | v1 |
| V04 | **Magic-link auth** (request/verify/logout, rate limits, mail templates), account page, delete account | V03 |
| V05 | **Clip libraries model + admin page** (Authelia-gated): CRUD libraries, upload/normalize clips, attribution, enable/disable, set default public library; nginx `/admin` + `/api/admin` locations | V03 |
| V06 | **Host custom libraries**: logged-in hosts create private libraries, upload clips (quota e.g. 30 clips / 300 MB per user), pick library in lobby settings; usable only in private rooms; admin takedown | V04, V05 |
| V07 | **Presence + counts**: `/ws/presence`, "N online" and "N looking for a game" on the join buttons | V03 |
| V08 | **Public matchmaking ("Join random game")**: server-hosted public rooms, normal settings, auto-start at 3–6 players after a countdown, **voice opt-in muted by default** + report/vote-kick | V07 |
| V09 | **Elo**: pairwise multiplayer Elo from final standings (each pair a match, K=32/(n−1)), start 1000, only public/ranked games; ranked unlocked after 3 public games; matchmaking window ±100 widening +50 every 5 s, any after 45 s or if <3 in window; guest Elo saved to guest profile + "register to keep your rating" prompt after the game | V04, V08 |
| V10 | **Friends + DMs**: after a game, friend-request other logged-in players; friends list w/ online status on home; invite friend to private room (presence push); text DMs (rate limits, block/report, 90-day retention) | V04, V07 |
| V11 | **Support prompt** after Final: "Solo dev on a toaster — Voicejack costs ≈ €X/month for Y players" + link; numbers from a `costs.json` the owner edits. Link: `https://liberapay.com/marcel.borbus/donate` (owner's Liberapay). Use a plain link styled as our button (or Liberapay's `donate.svg` self-hosted) — **don't load `liberapay.com/.../button.js`**: no third-party script on the page (CSP, privacy/Datenschutz, no tracking). | V02 |
| V12 | **Legal pages + privacy** (Impressum, Datenschutz, takedown contact) | V04 |
| V13 | v1.1 e2e (bots make solo e2e cheap) + deploy | all |
| V14 | **Every player dubs a different scene** (#38, owner, central): per-round `assignClips` (distinct in a round, fresh clips first then least recently used, never a clip the player already had), start blocker only if clips < players, protocol v2 (`you.clip`, `ShowcaseItem.clip`, `RoundResultEntry.clip`), showcase switches clip per item | v1; before V09/V13 |

Parallel lanes after the gate: {V01, V02, V03} → {V04, V05, V07} → {V06, V08, V10, V12} → {V09, V11} → V13.

### Monetization numbers (to verify in V11)
Measured from v1: ~3 MB clip + ~2 MB dub chunks per player per round → ~15 MB per player per
3-round game; voice is P2P (no server traffic). 10 concurrent players are a rounding error on the
current box. A dedicated Hetzner CX23 (~€3.49/mo + IPv4, 20 TB traffic included — check
hetzner.com/cloud for today's price) would carry roughly 100+ concurrent players. Suggested copy:
"Running Voicejack costs about €5/month for ~100 players at once — €3 keeps your squad dubbing for
a month." If a TURN relay is added later, that becomes the main bandwidth cost.

**Donation service linked to your IBAN:** recommend **Liberapay** (non-profit, no platform fee,
pays out via Stripe/PayPal to a German bank account / SEPA) or **GitHub Sponsors** (no platform
fee, Stripe payout to bank; repo already on GitHub; USD with ~2 % FX conversion). Ko-fi is an
alternative (0 % on one-off donations, PayPal/Stripe). Owner must create the account (manual step).

## Status

- [x] V03 DB + migrations + guest profiles (#26)
- [x] V01 Bots / dev test mode (#24): `DEV_BOTS=1`, C2S `addBot`/`removeBot`, `PlayerPublic.isBot`, `you.canManageBots`; `isAdmin` hook in RoomManager for V05
- [x] V07 Presence + counts (#30): `/ws/presence` (`PresenceC2S`/`PresenceS2C` in `shared/src/protocol/presence.ts`, throttled `counts` push), `GET /api/stats`; hooks for V08 `Presence.setLooking`, for V10 `Presence.isOnline`/`sendToUser`
- [x] V04 Magic-link auth (#27): `POST /api/auth/request`, confirm page `GET`/`POST /api/auth/verify`, `POST /api/auth/logout`, `PATCH`/`DELETE /api/me`, `MeUser.email`; `RegisterPrompt` in `client/src/components/account` for V09; mail via host Postfix (`host.docker.internal:25`)
- [x] V05 Clip libraries + admin (#28): migration `002_libraries.sql`, DB-backed `ClipLibrary` (manifest imported as official default `classics`), `/api/admin/*` (Authelia `Remote-Groups: admins` from `TRUST_PROXY` peers, `ADMIN_DEV=1` locally), uploads normalized by ffmpeg into `LIBRARY_DIR`, `GameSettings.libraryId` + `GET /api/libraries`, lobby `LibraryPicker`, `/admin` page; for V06 `ClipLibrary.createLibrary(body, {userId, visibility:'private'})`, `canUse(libraryId, userId)`, `clips.uploaded_by`
- [x] V10 Friends + DMs (#33): `004_friends.sql` (friendships, blocks, messages; reports via V08's table), `/api/friends/*` REST (`shared/src/protocol/friends.ts`), presence S2C `friendStatus`/`friends`/`dm`/`invite` (`Presence.onStatusChange`/`statusOf`), `client/src/components/friends` (home panel, dock, chat drawer, invite cards, Add friend on results/final)
- [x] V14 Every player dubs a different scene (#38): shared `assignClips`/`recordClips`/`ClipHistory`, `PROTOCOL_VERSION = 2`: `RoomSnapshot.clip` and `RoundResult.clip` removed, `you.clip`, `ShowcaseItem.clip`, `RoundResultEntry.clip`; `clipCount` = filtered library size; start blocked only if clips < players
- [x] V02 Design pass (#25): `docs/design-v1.1.md`; grape-ink sticker theme, doodle kit + mic/jack logo, name-seeded avatars (`lib/avatar.ts`), WebAudio UI sounds + mute (`lib/sfx.ts`, silent in DUBBING), invite message/Share/QR (`uqr`), results share card (`lib/shareCard.ts`), OG/Twitter meta + `og.png` (`scripts/make-og.mjs`); buttons unchanged
- [x] V08 Public matchmaking (#31): `/ws/presence` C2S `queueJoin {name}`/`queueLeave`, S2C `queue {position?, size, waitedMs}`/`queueLeft`/`matchFound {code, token}` (+ error `BLOCKED`); pure `server/src/match/Matcher.ts` (6 now, 3+ after 20 s, 2 after 60 s; V09 hooks `compatible(a, b, waitedMs, ctx)`/`score(a, b)` via `Matchmaker` `rules`); `Room.kind` 'private'|'public' + `RoomSnapshot.public` (20 s ready check, requeue at the front, C2S `voteKick`/`report`, S2C `requeued`, `kicked.by`); `003_reports.sql`; public voice opt-in (`client/src/components/match`)
- [x] V06 Host custom libraries (#29): `005_user_libraries.sql` (`users.upload_banned`, `libraries.disabled`, `clips.rights_confirmed_at`, `clip_uploads`, `reports.clip_id`), `/api/my/*` (registered only; 5 libraries / 30 clips / 300 MB / 10 uploads a day, shared queue admin-first, 1 job per user), `POST /api/clips/:id/report`, admin `/api/admin/user-libraries` + disable/ban/resolve, private clip files random-named and cookie-gated (owner or player of a room using the library), `/library` page, lobby groups Official / My libraries
- [x] V11 Support prompt (#34): `client/src/components/support` (Final `SupportPrompt` after 7 s, once per session via sessionStorage `vj.supportShown`; home footer `HomeSupport`, footer `SupportLink`), plain Liberapay link, no third-party script; `GET /costs.json` = `COSTS_PATH` (`/app/data/costs.json`) else `client/public/costs.json`
