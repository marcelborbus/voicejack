# Deploying Voicejack to hetzner (voicejack.borbus.eu)

**Read `/opt/AGENTS.md` and `/opt/docs/ARCHITECTURE.md` on the box first.** They record the
host conventions this deployment follows: one Compose project per service under `/opt/<name>/`,
loopback-only ports behind host nginx, `nginx -t` before every reload, port-80 blocks must
include `snippets/acme.conf`, and keep an eye on the ~1 GB of free RAM.

| What            | Value                                                                                  |
| --------------- | -------------------------------------------------------------------------------------- |
| Public URL      | `https://voicejack.borbus.eu` (**public, no Authelia**, see below)                           |
| Compose project | `/opt/voicejack` (project name `voicejack`, container `voicejack`)                |
| Port            | `127.0.0.1:3087` → container `3000` (check it is still free: `ss -ltn \| grep 3087`)   |
| Image           | `voicejack:latest`, ~300 MB (node:24-alpine + ffmpeg + one bundled `server.mjs` + `client/dist`) |
| Memory          | `mem_limit 450m` (no swap; 320m before V05), `NODE_OPTIONS=--max-old-space-size=192`; ~30 MB idle, ~290 MB while ffmpeg normalizes an upload |
| CPU             | `cpus: 1.0`                                                                            |
| State           | **`./data/db/voicejack.sqlite`** (SQLite + WAL: guest/registered accounts, sessions) — **back it up**. **`./data/library`** (admin-uploaded clips, V05) — **back it up**. `./clips` (read-only), `./data/uploads` (wiped on every start) |
| Secrets         | none                                                                                   |

**Why public:** guests join through an invite link (`/r/<CODE>`) and have no borbus account.
Rooms are anonymous and live at most 3 h, and uploads never survive a restart, so there is no
persistent user data a login would protect. (Since v1.1/V03 there are guest profiles in
SQLite: an anonymous id, the last display name and game stats per browser cookie, no personal
data until V04 adds optional email login.) Abuse is bounded by the app (30 rooms × 8 players,
per-route REST limits, per-socket WS rate/size caps, Origin check) and by the `limit_req` /
`limit_conn` zones (`dub_*`) in the vhost. If accounts or persistent storage are ever added,
put an Authelia gate in front of it.

## 0. Prerequisites (already done as of 2026-10-16)

- **DNS (manual, owner):** A record `voicejack.borbus.eu → 89.167.46.209` at goneo. Already resolves.
- **Certificate:** `voicejack.borbus.eu` is already a SAN of the shared `borbus` cert
  (`openssl x509 -in /etc/letsencrypt/live/borbus/cert.pem -noout -ext subjectAltName`).
  So **no certbot run is needed**; the vhost just includes `snippets/ssl-borbus.conf`.
  Do **not** run `certbot --nginx` here: it would rewrite the vhost and the host deliberately
  does not use certbot's nginx plugin. If the name ever has to be re-added, use the webroot
  command from ARCHITECTURE.md §6 with every existing `-d` repeated plus `-d voicejack.borbus.eu`.

## 1. Build the image and ship it (dev box)

Building on the host is possible but the Vite build is the most memory-hungry step there is,
so build locally and load the image over ssh:

```sh
cd ~/projects/dubbing-game
pnpm docker:build                    # = docker build -f deploy/Dockerfile -t voicejack .
docker save voicejack:latest | gzip | ssh hetzner 'gunzip | docker load'
```

## 2. Clips (dev box)

Clips are never baked into the image. Fetch them locally, then rsync the manifest and mp4s:

```sh
node scripts/fetch-clips.mjs         # fills clips/ (manifest.json + *.mp4)
ssh hetzner 'install -d /opt/voicejack/clips'
rsync -av --delete clips/manifest.json clips/*.mp4 clips/*.jpg hetzner:/opt/voicejack/clips/
```

Owner-provided clips (`"local": true` in the manifest) are fine to rsync to the private box,
they just are not redistributable. If the manifest is missing the server still starts with an
empty library (warning in the log); if it is invalid the server refuses to start.

## 3. Compose project (host)

```sh
ssh hetzner
cd /opt/voicejack
# compose.yaml: copy deploy/compose.yaml from the repo (scp deploy/compose.yaml hetzner:/opt/voicejack/)
install -d -o 1000 -g 1000 data data/db   # the container runs as uid 1000 (node); must be writable
free -h && docker stats --no-stream  # headroom check before starting anything
docker compose up -d                 # uses the loaded voicejack:latest, no build
docker compose ps                    # wait for (healthy)
curl -sf http://127.0.0.1:3087/api/health
```

Optional `.env` next to `compose.yaml`: `PORT=3087` (host port), `ICE_SERVERS='[...]'` (JSON;
add a TURN server here later, no client change needed), `LOG_LEVEL=info`.

**Test bots (V01, off by default).** With `DEV_BOTS=1` the host of a room gets "Add bot" /
"Remove bot" (1–7 server-side bots that ready up, dub with clip snippets and vote randomly; no
voice). To enable on the box: add `DEV_BOTS=1` to `/opt/voicejack/.env`, then
`docker compose up -d` (recreates the container; rooms in progress are lost). Remove the line and
run it again to turn bots off. Bot audio comes from `clips/bot-sounds/` — build it on the dev box
with `node scripts/make-bot-sounds.mjs` and rsync it along with the clips
(`rsync -av --delete clips/bot-sounds hetzner:/opt/voicejack/clips/`). Without it (and without
ffmpeg in the image) bots submit empty dubs.

To build on the host instead of shipping the image: clone the repo to `/opt/voicejack/src`,
put `DUB_SRC=./src` in `.env`, and `docker compose up -d --build` (watch the RAM).

### Database and backups (V03)

The server keeps a SQLite database at `/opt/voicejack/data/db/voicejack.sqlite` (container
`DB_PATH=/app/data/db/voicejack.sqlite`, WAL mode, so `-wal`/`-shm` files sit next to it). It is
created and migrated automatically at startup (`db: … at schema vN` in the log). It holds the
guest/registered accounts and sessions, so unlike the rest of `./data` it **must be kept**:

- `data/db` must exist and be owned by uid 1000 (`install -d -o 1000 -g 1000 data/db`); the
  server would create it itself if `data` is writable, but create it explicitly.
- **Add `/opt/voicejack/data/db` to the host's backups in `/opt/backups`** (follow how the other
  services' state is backed up there). For a consistent copy of a live WAL database use
  `sqlite3 data/db/voicejack.sqlite ".backup '/path/voicejack-$(date +%F).sqlite'"` (or copy the
  `.sqlite`, `-wal` and `-shm` files together while the container is stopped).
- Never put it under `data/uploads` (wiped on start; the server refuses that `DB_PATH`).
- Restoring: stop the container, replace the three files, start it.

### Mail: magic-link sign-in (V04)

Sign-in links are sent through the host's Postfix null client (ARCHITECTURE §7 "Reaching it
from containers"). `compose.yaml` sets `MAIL_TRANSPORT=smtp`, `SMTP_HOST=host.docker.internal`,
`SMTP_PORT=25`, `MAIL_FROM=Voicejack <noreply@borbus.eu>`, `PUBLIC_URL=https://voicejack.borbus.eu`,
plus `extra_hosts: host.docker.internal:host-gateway`. All can be overridden in `.env`.

- **No Postfix change is needed** (checked read-only 2026-10-17): `mynetworks = 127.0.0.0/8
  [::1]/128 172.16.0.0/12`, `inet_interfaces = all`, `smtpd_relay_restrictions =
  permit_mynetworks, reject_unauth_destination`, and ufw allows 25/tcp from `172.16.0.0/12`.
  `voicejack_default` is `172.26.0.0/16` (gateway `172.26.0.1`), inside that range. If the
  network were ever recreated outside 172.16/12, the change would be
  `postconf -e 'mynetworks = 127.0.0.0/8 [::1]/128 172.16.0.0/12 <subnet>'` plus
  `ufw allow from <subnet> to any port 25 proto tcp`, then `systemctl reload postfix`.
- The app speaks plain SMTP without AUTH or STARTTLS (host-local hop; Postfix's TLS is on the
  goneo leg). Postfix rewrites the envelope sender to `m@borbus.eu` and `smtp_header_checks`
  replaces the whole `From:` with `noreply@borbus.eu`, so mails show that address without the
  "Voicejack" display name. Optional, to keep the name: add
  `/^From: Voicejack <noreply@borbus\.eu>$/ DUNNO` as the **first** line of
  `/etc/postfix/header_checks` (first match wins, other senders unchanged), then
  `postmap -q "From: Voicejack <noreply@borbus.eu>" regexp:/etc/postfix/header_checks` (expect
  `DUNNO`) and `systemctl reload postfix`. Not applied.
- goneo throttling: Postfix sends one mail per 10 s. The app caps requests at 3 per address per
  15 min (counted in the DB), 10 per IP per hour and 300 per hour overall (in memory).
- Smoke test after deploy: request a link for your own address in the UI, then
  `docker logs voicejack 2>&1 | grep -i mail` (failures are logged as `login mail failed`) and
  `journalctl -u postfix --since -5min` / `mailq` on the host.
- Locally and in tests `MAIL_TRANSPORT=log` (default unless `NODE_ENV=production`) prints the
  link to the server log instead of sending.
- ARCHITECTURE §7 "What sends mail" gets a row: `| Voicejack | magic-link sign-in mails |`.

**Why `./data/uploads` and not `./data`:** the server wipes `DATA_DIR` with `rm -r` at startup,
which cannot remove a mount point, so the image sets `DATA_DIR=/app/data/uploads`.

### Clip libraries + admin (V05)

Libraries and clips live in the SQLite DB (migration `002_libraries.sql`). At every start the
server imports `clips/manifest.json` (idempotently) as the official default library **Classics**;
those files stay in the read-only `./clips` mount and keep their v1 URLs (`/clips/<file>`).
Clips uploaded on **https://voicejack.borbus.eu/admin** are normalized in the container by
ffmpeg (H.264/AAC mp4 ≤720p, faststart, ≤60 s, poster jpg; one job at a time under `nice`) and
stored in `./data/library/<libraryId>/` (`LIBRARY_DIR=/app/data/library`), served at
`/clips/<libraryId>/<file>`. Upload temp files sit in `./data/library/.tmp` (the 16 MB `/tmp`
tmpfs is too small) and are deleted after each job.

Host steps (not applied yet):

1. **RAM:** `mem_limit`/`memswap_limit` are now **450m** in `compose.yaml` (was 320m). Measured:
   ~290 MiB peak while normalizing a 20 s 1080p upload, ~30 MiB idle. Check `free -h` first
   (2026-10-17: 2.4 GiB available).
2. **Image:** ffmpeg (alpine package) adds ~130 MB: 169 MB → 301 MB. `docker save | gzip` ships
   correspondingly more.
3. **Directory:** `install -d -o 1000 -g 1000 /opt/voicejack/data/library` (the server would
   create it if `data` is writable) and **add `/opt/voicejack/data/library` to the backups**
   next to `data/db` (the DB rows and the files belong together).
4. **Authelia rule** in `/opt/authelia/config/configuration.yml`, `access_control.rules` (next to
   the portfolio rule), then `docker compose restart authelia`:

   ```yaml
       # --- Voicejack clip-library admin — admins only. The game itself is public
       # and needs no rule (nginx serves it without auth_request).
       - domain: 'voicejack.borbus.eu'
         resources:
           - '^/(admin|api/admin)([/?].*)?$'
         subject:
           - 'group:admins'
         policy: 'one_factor'
   ```

5. **nginx:** deploy the updated vhost (section 4). It now includes
   `snippets/authelia-location.conf` once and `snippets/authelia-authrequest.conf` in
   `location /admin` and `location /api/admin/` (body limit 210m there only, request buffering
   off, 300 s timeouts). All other locations blank `Remote-User`/`Remote-Groups`.

**Trust model:** the app accepts `/api/admin/*` only if the TCP peer is in `TRUST_PROXY`
(`loopback,uniquelocal`: nginx via the docker bridge) **and** `Remote-Groups` contains `admins`
(plus a same-origin check on writes); otherwise 403. Same pattern as marcel.borbus.eu, and it
is safe only while the port stays loopback-bound. `ADMIN_DEV=1` (dev only, ignored with
`NODE_ENV=production`) lets loopback in without headers.

Verify after deploy: `curl -s -o /dev/null -w "%{http_code}\n" https://voicejack.borbus.eu/admin`
→ 302 to auth.borbus.eu; `curl -s -H 'Remote-Groups: admins' -H 'Remote-User: x'
https://voicejack.borbus.eu/api/me` must not grant anything (headers are blanked);
`curl -s https://voicejack.borbus.eu/api/libraries` lists Classics. Then sign in as `marcel`,
upload a short clip on `/admin`, and watch `docker stats --no-stream voicejack`.

**ARCHITECTURE.md §3.9** needs updating: Voicejack is no longer "nothing persistent" (DB +
library, both backed up), `/admin` is Authelia-gated (`admins`), `mem_limit 450m`; add the
rule to the §3.1 access-control table and the new footprint to §5.

### Support prompt numbers (V11)

The "Chip in?" card after a game reads `/costs.json` (`{"monthlyEur": 5, "players": 100,
"updated": "2026-10-17"}`). To change the numbers without a rebuild, put your own copy at
`/opt/voicejack/data/costs.json` (`COSTS_PATH=/app/data/costs.json` in the image). It is read on
every request; while it is missing or not valid JSON, the copy from `client/public/` is served.

### Impressum details (V12)

`/impressum` renders `GET /api/legal`, which reads `LEGAL_PATH` (`/app/data/legal.json` in the
image, i.e. `/opt/voicejack/data/legal.json` on the host). Your name and address are personal
data, so this file is **never committed**: copy `deploy/legal.example.json`, fill it in, and make
it readable by uid 1000. Fields: `name`, `address` (lines separated by `\n`), `email`, optional
`phone`, `responsibleForContent` (§18 MStV) and `vatId`. It is read per request (no restart).
While it is missing or invalid the page shows "Impressum not configured" and the server logs a
`legal:` warning at startup.

## 4. nginx (host)

```sh
scp deploy/nginx/voicejack.borbus.eu.conf hetzner:/etc/nginx/sites-available/voicejack.borbus.eu
ssh hetzner
ln -s /etc/nginx/sites-available/voicejack.borbus.eu /etc/nginx/sites-enabled/voicejack.borbus.eu
nginx -t && systemctl reload nginx
```

The vhost follows `marcel.borbus.eu`: port 80 = acme include + 301, port 443 = `ssl http2`,
`ssl-borbus.conf`, `proxy.conf` (which already sets HTTP/1.1, Upgrade/Connection via
`$connection_upgrade`, X-Forwarded-*). It defines three zones at http level: `dub_create`
(POST `/api/rooms`, 5 r/min), `dub_api` (rest of `/api/`, 20 r/s burst 60) and `dub_conn`
(16 concurrent `/ws` per IP). `/ws` gets `proxy_read_timeout 1h`. Body limit 4 MB (largest
chunk is 2 MiB). No `add_header` inside locations, or the HSTS headers from the snippet vanish.

The container trusts `X-Forwarded-For` from private ranges only (`TRUST_PROXY=loopback,uniquelocal`),
because nginx reaches it via the Docker bridge gateway, not 127.0.0.1. That keeps the app's own
per-IP rate limits keyed on the real client, and since the port is loopback-only nothing else can
reach it.

## 5. Verify

```sh
curl -sf https://voicejack.borbus.eu/api/health
curl -s -o /dev/null -w "%{http_code}\n" https://voicejack.borbus.eu/r/ABCDEF          # 200 (SPA)
curl -s -o /dev/null -w "%{http_code}\n" http://voicejack.borbus.eu/                   # 301
curl -s -o /dev/null -D - -H 'Range: bytes=0-99' https://voicejack.borbus.eu/clips/<file>.mp4 | head -1   # 206
docker stats --no-stream voicejack                                                # well under 450 MiB
```

Then a real game with two devices (WS upgrade + voice). Voice uses public STUN only, so peers
behind symmetric NAT/CGNAT show "no direct route"; the game itself still works over WS/HTTP.

Add an Uptime Kuma HTTP check on `https://voicejack.borbus.eu/api/health`.

Redeploy = steps 1 (+2 if clips changed), then `cd /opt/voicejack && docker compose up -d`.
Restarting ends all running games (rooms are in memory); pick a quiet moment.

## 6. Update `/opt/docs/ARCHITECTURE.md` (same session — AGENTS.md requires it)

Draft text for each section; adjust to what you actually verified, and bump **Last verified**.

**§1 DNS and TLS**, hostname table, add a row:

> | `voicejack.borbus.eu` | Voicejack party dubbing game (§3.9), public |

and change the cert sentence to: "One Let's Encrypt certificate (`--cert-name borbus`) covers
all ten hostnames above as SANs (… `marcel.borbus.eu` 2026-10-11, `voicejack.borbus.eu` 2026-10-16)."
Also append `-d voicejack.borbus.eu` to the certbot command in **§6** step 2, or the next expansion
silently drops it.

**§2 Request path**, add `voicejack :3087 (public)` to the diagram, and to the **nginx layout** table:

> | `sites-available/voicejack.borbus.eu` | Voicejack, **public, no gate** (§3.9); defines `limit_req_zone`s `dub_create`, `dub_api` and `limit_conn_zone` `dub_conn` |

**§3 Services**, new subsection:

> ### 3.9 Voicejack — voicejack.borbus.eu · `/opt/voicejack`
>
> Container `voicejack`, bound `127.0.0.1:3087`, served at <https://voicejack.borbus.eu> —
> **publicly, with no Authelia in front of it.** A browser party game (github.com/marcelborbus/voicejack):
> players join a room by invite link, dub short video clips with their mic and vote.
> Guests have no borbus account, rooms are anonymous and in memory (max 3 h), uploads go to
> `data/uploads/` and are wiped on every start, so there is nothing a login would protect.
> Abuse limits: the app caps 30 rooms × 8 players with per-route/per-socket limits and an
> Origin check; the vhost adds `dub_*` rate/conn zones and a 4 MB body cap.
> **If accounts or persistent storage are ever added, gate it.**
>
> - Image `voicejack:latest` is built on the dev box (`pnpm docker:build`) and loaded with
>   `docker save | ssh hetzner docker load`; nothing is built here (Vite would be the most
>   RAM-hungry thing on the box). Clips are rsynced to `clips/` (read-only mount), never in the image.
> - Runs as uid 1000, read-only rootfs, `cap_drop: ALL`, `mem_limit 320m`, `cpus 1.0`.
> - `TRUST_PROXY=loopback,uniquelocal`: nginx arrives from the Docker bridge, so private ranges
>   are trusted for `X-Forwarded-For`; safe only while the port stays on loopback.
> - Nothing to back up. Voice chat is WebRTC with public STUN only (no TURN, no new ports);
>   `ICE_SERVERS` in `.env` can add a TURN server later.
> - Redeploy: load the new image, `cd /opt/voicejack && docker compose up -d` (ends running games).

**§4 Ports → Loopback only**, add a row:

> | 3087 | Voicejack |

and add to the sentence under it that a public-by-design service (rote-mappe, matrix, dub) skips the Authelia step with a stated reason.

**§5 Resource budget**, add a row (use the measured value):

> | `voicejack` | ~26 MB idle (capped 320 MB; grows with active rooms, uploads are on disk) |

**§10 Verifying**, add to the "must answer 200 without a session" block:

> `curl -sS -o /dev/null -w "%{http_code}\n" https://voicejack.borbus.eu/api/health   # Voicejack, public by design`
