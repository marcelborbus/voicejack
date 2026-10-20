import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { ClipLibrary, toClipInfo } from './clips/ClipLibrary.js';
import { RoomManager } from './room/RoomManager.js';
import { ChunkStore } from './uploads/ChunkStore.js';
import { buildApp } from './http/app.js';
import { openDb, type Db } from './db/index.js';
import { migrate } from './db/migrate.js';
import { readLegal } from './legal/legal.js';
import { Accounts } from './accounts/Accounts.js';
import { Presence } from './presence/Presence.js';
import { Matchmaker } from './match/Matchmaker.js';
import { Reports } from './match/Reports.js';
import { Friends } from './friends/Friends.js';
import { LibraryBotSounds } from './bots/librarySounds.js';
import { Ratings } from './elo/Ratings.js';
import { Analytics } from './analytics/Analytics.js';

/** Expired sessions / idle guests are purged this often (and once at startup). */
export const DB_CLEANUP_MS = 3600_000;

export interface RunningServer {
  app: FastifyInstance;
  rooms: RoomManager;
  store: ChunkStore;
  db: Db;
  accounts: Accounts;
  presence: Presence;
  matchmaker: Matchmaker;
  reports: Reports;
  friends: Friends;
  ratings: Ratings;
  analytics: Analytics;
  /** e.g. `http://127.0.0.1:3000` */
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Builds every dependency from `config`, then listens. Used by main.ts and integration tests. */
export async function startServer(
  config: Config,
  opts: { logger?: boolean | { level: string } } = {},
): Promise<RunningServer> {
  const store = new ChunkStore(config.dataDir);
  await store.init();
  const dataDir = path.resolve(config.dataDir) + path.sep;
  if (config.dbPath !== ':memory:' && path.resolve(config.dbPath).startsWith(dataDir)) {
    throw new Error(`DB_PATH (${config.dbPath}) must not be inside DATA_DIR, which is wiped`);
  }
  if ((path.resolve(config.libraryDir) + path.sep).startsWith(dataDir)) {
    throw new Error(
      `LIBRARY_DIR (${config.libraryDir}) must not be inside DATA_DIR, which is wiped`,
    );
  }
  const db = openDb(config.dbPath);
  const mig = migrate(db);
  const clips = ClipLibrary.open(db, { clipsDir: config.clipsDir, libraryDir: config.libraryDir });
  const accounts = new Accounts(db);
  const ratings = new Ratings(db);
  const analytics = new Analytics(db);
  // v1.2 #46: bots "speak" snippets cut from the official library (cached in LIBRARY_DIR).
  let botLog = (m: string) => console.log(`[bots] ${m}`);
  const botSounds = new LibraryBotSounds({
    library: clips,
    libraryDir: config.libraryDir,
    clipsDir: config.clipsDir,
    log: (m) => botLog(m),
  });
  const rooms = new RoomManager({
    botSounds: () => botSounds.get(),
    onBotSoundsChange: (fn) => botSounds.onChange(fn),
    analytics,
    config,
    clips: clips.clips.map(toClipInfo),
    store,
    library: clips,
    ratings,
  });
  clips.onChange(() => rooms.libraryChanged());
  const presence = new Presence({ rooms });
  const reports = new Reports(db);
  const matchmaker = new Matchmaker({
    rooms,
    presence,
    reports,
    ratings,
    analytics,
    timings: config.timings,
  });
  const friends = new Friends({ db, presence, rooms });
  const app = await buildApp(
    { config, clips, rooms, store, accounts, presence, matchmaker, friends, ratings, analytics },
    opts,
  );
  const cleanup = () => {
    try {
      const n = accounts.cleanup();
      if (n.sessions || n.guests) app.log.info(n, 'db cleanup');
      // V15 retention: aggregates 2 years, feedback 1 year.
      const a = analytics.prune();
      if (a.aggregates || a.feedback) app.log.info(a, 'analytics cleanup');
    } catch (e) {
      app.log.error(e, 'db cleanup failed');
    }
  };
  const cleanupTimer = setInterval(cleanup, DB_CLEANUP_MS);
  cleanupTimer.unref();
  matchmaker.setLog(app.log);
  botLog = (m) => app.log.info(m);
  app.addHook('onClose', async () => {
    clearInterval(cleanupTimer);
    friends.dispose();
    matchmaker.dispose();
    presence.dispose();
    await rooms.stop();
    try {
      analytics.stop(); // flush the last counters (rooms.stop may have added drop-offs)
    } catch (e) {
      app.log.error(e, 'analytics flush failed');
    }
    db.close();
  });
  if (mig.applied.length) app.log.info(`db: applied ${mig.applied.join(', ')}`);
  if (mig.unknown.length) app.log.warn(`db: has migrations newer than this build: ${mig.unknown}`);
  app.log.info(`db: ${config.dbPath} at schema v${mig.version}`);
  cleanup();
  rooms.start();
  analytics.start(undefined, (e) => app.log.error(e, 'analytics flush failed'));
  for (const w of clips.warnings) app.log.warn(w);
  const legal = await readLegal(config.legalPath);
  if (!legal.ok) {
    app.log.warn(`legal: Impressum not configured (${legal.reason}); /impressum shows a banner`);
  }
  app.log.info(`clips: ${clips.size} from ${config.clipsDir}`);
  await app.listen({ port: config.port, host: config.host });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  return {
    app,
    rooms,
    store,
    db,
    accounts,
    presence,
    matchmaker,
    reports,
    friends,
    ratings,
    analytics,
    url: `http://${host}:${port}`,
    port,
    close: () => app.close(),
  };
}
