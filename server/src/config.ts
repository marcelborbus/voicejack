import path from 'node:path';
import { IceServerSchema, MAX_PLAYERS, MAX_ROOMS, type IceServer } from '@dub/shared';

/** All game timings in ms (PLAN §2.1). */
export interface Timings {
  uploadGraceMs: number;
  preloadMaxMs: number;
  playLeadMs: number;
  voteGraceMs: number;
  betweenItemsMs: number;
  roundResultsMs: number;
  lobbyDropMs: number;
  hostMigrateMs: number;
  /** V08 public rooms: time to pass the mic check and press ready after a match. */
  readyCheckMs: number;
  /** V08 matchmaking: 3+ players start once the oldest waited this long (6 start at once). */
  matchFullWaitMs: number;
  /** V08 matchmaking: 2 players start once the oldest waited this long. */
  matchPairWaitMs: number;
  /** V08 matchmaking tick (queue updates + matching). */
  matchTickMs: number;
}

export const TIMINGS_PRESETS = {
  prod: {
    uploadGraceMs: 3000,
    preloadMaxMs: 8000,
    playLeadMs: 1500,
    voteGraceMs: 2000,
    betweenItemsMs: 1500,
    roundResultsMs: 15000,
    lobbyDropMs: 60000,
    hostMigrateMs: 30000,
    readyCheckMs: 20000,
    matchFullWaitMs: 20000,
    matchPairWaitMs: 60000,
    matchTickMs: 1000,
  },
  fast: {
    uploadGraceMs: 500,
    preloadMaxMs: 2000,
    playLeadMs: 300,
    voteGraceMs: 300,
    betweenItemsMs: 200,
    roundResultsMs: 1000,
    lobbyDropMs: 60000,
    hostMigrateMs: 30000,
    readyCheckMs: 2000,
    matchFullWaitMs: 400,
    matchPairWaitMs: 4000,
    matchTickMs: 100,
  },
} as const satisfies Record<string, Timings>;
export type TimingsName = keyof typeof TIMINGS_PRESETS;

export interface Config {
  port: number;
  host: string;
  clipsDir: string;
  dataDir: string;
  /** V05: writable clip uploads (`<libraryDir>/<libraryId>/`). Must live outside dataDir. */
  libraryDir: string;
  /** V05: ADMIN_DEV=1 lets loopback use /api/admin without Authelia (ignored in production). */
  adminDev: boolean;
  /** SQLite file (`:memory:` in tests). Must live outside dataDir, which is wiped. */
  dbPath: string;
  /** `Secure` attribute on the session cookie (default: NODE_ENV=production). */
  cookieSecure: boolean;
  clientDist: string;
  timingsName: TimingsName;
  timings: Timings;
  /** Lets a single player start a game. */
  allowSolo: boolean;
  /** V01 dev test mode: hosts may add server-side bots (env DEV_BOTS=1; off in prod). */
  devBots: boolean;
  /** dubbingSeconds may go down to SHORT_DUBBING_MIN_SECONDS (on by default with TIMINGS=fast). */
  allowShortDubbing: boolean;
  trustProxy: string | boolean;
  iceServers: IceServer[];
  maxRooms: number;
  maxPlayers: number;
  logLevel: string;
  /** V04 magic-link mail: `smtp` (prod default) or `log` (dev/tests: link to log + outbox). */
  mailTransport: 'smtp' | 'log';
  smtpHost: string;
  smtpPort: number;
  mailFrom: string;
  /** Origin the emailed links point at, no trailing slash (e.g. https://voicejack.borbus.eu). */
  publicUrl: string;
  /**
   * V11: owner-editable `/costs.json` (support prompt numbers). When unset or missing, the copy
   * shipped in `clientDist` (from client/public) is served. Prod: /app/data/costs.json.
   */
  costsPath: string | null;
}

/** Repo root (server/src/config.ts → ../..). */
export const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

const DEFAULT_ICE: IceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

function bool(v: string | undefined, dflt = false): boolean {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const timingsName: TimingsName = env.TIMINGS === 'fast' ? 'fast' : 'prod';
  let iceServers = DEFAULT_ICE;
  if (env.ICE_SERVERS) {
    const raw: unknown = JSON.parse(env.ICE_SERVERS);
    if (!Array.isArray(raw)) throw new Error('ICE_SERVERS must be a JSON array');
    iceServers = raw.map((x, i) => {
      const r = IceServerSchema.safeParse(x);
      if (!r.success) throw new Error(`ICE_SERVERS[${i}] is invalid: ${r.error.message}`);
      return r.data;
    });
  }
  const trust = env.TRUST_PROXY ?? '127.0.0.1';
  return {
    port: env.PORT ? Number(env.PORT) : 3000,
    host: env.HOST ?? '0.0.0.0',
    clipsDir: path.resolve(env.CLIPS_DIR ?? path.join(REPO_ROOT, 'clips')),
    dataDir: path.resolve(env.DATA_DIR ?? path.join(REPO_ROOT, '.cache/data')),
    libraryDir: path.resolve(env.LIBRARY_DIR ?? path.join(REPO_ROOT, '.cache/library')),
    adminDev: bool(env.ADMIN_DEV) && env.NODE_ENV !== 'production',
    dbPath:
      env.DB_PATH === ':memory:'
        ? ':memory:'
        : path.resolve(env.DB_PATH ?? path.join(REPO_ROOT, '.cache/db/voicejack.sqlite')),
    cookieSecure: bool(env.COOKIE_SECURE, env.NODE_ENV === 'production'),
    clientDist: path.resolve(env.CLIENT_DIST ?? path.join(REPO_ROOT, 'client/dist')),
    timingsName,
    timings: { ...TIMINGS_PRESETS[timingsName] },
    allowSolo: bool(env.ALLOW_SOLO),
    devBots: bool(env.DEV_BOTS),
    allowShortDubbing: bool(env.ALLOW_SHORT_DUBBING, timingsName === 'fast'),
    trustProxy: trust === 'true' ? true : trust === 'false' || trust === '' ? false : trust,
    iceServers,
    maxRooms: env.MAX_ROOMS ? Number(env.MAX_ROOMS) : MAX_ROOMS,
    maxPlayers: MAX_PLAYERS,
    logLevel: env.LOG_LEVEL ?? 'info',
    mailTransport:
      (env.MAIL_TRANSPORT ?? (env.NODE_ENV === 'production' ? 'smtp' : 'log')) === 'smtp'
        ? 'smtp'
        : 'log',
    smtpHost: env.SMTP_HOST ?? 'localhost',
    smtpPort: env.SMTP_PORT ? Number(env.SMTP_PORT) : 25,
    mailFrom: env.MAIL_FROM ?? 'Voicejack <noreply@borbus.eu>',
    publicUrl: (env.PUBLIC_URL ?? 'http://localhost:5173').replace(/\/+$/, ''),
    costsPath: env.COSTS_PATH ? path.resolve(env.COSTS_PATH) : null,
  };
}
