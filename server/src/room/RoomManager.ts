import {
  LIMITS,
  generateRoomCode,
  type AudioMime,
  type ChunkId,
  type ClipInfo,
  type GameSettings,
  type Phase,
  type PlayerId,
  type QueueMode,
  type RoomCode,
  type RoomKind,
  type S2C,
  type SubmissionId,
} from '@dub/shared';
import type { Config } from '../config.js';
import { BotPlayer, type BotSound } from '../bots/BotPlayer.js';
import { loadBotSounds } from '../bots/sounds.js';
import { BotVoiceScheduler, botSoundKey, botSoundUrl } from '../bots/BotVoice.js';
import { Room, type JoinResult } from './Room.js';
import { realScheduler } from './timers.js';
import type { FinishedGame } from '../elo/Ratings.js';
import type { Tracker } from '../analytics/Analytics.js';
import type { Clock, FinalSeat, PlayerReport, RoomError, RoomLibrary, Scheduler } from './types.js';

/** Upload storage as seen by rooms (implemented by ChunkStore). */
export interface RoomStore {
  isUploaded(code: RoomCode, submissionId: SubmissionId, chunkId: ChunkId): boolean;
  deleteRoom(code: RoomCode): void | Promise<void>;
  /** Direct write, as an HTTP upload would (used by dev bots, V01). */
  put?(
    code: RoomCode,
    round: number,
    submissionId: SubmissionId,
    chunkId: ChunkId,
    mime: AudioMime,
    data: Buffer,
  ): Promise<unknown>;
}

/** One live socket of a player, registered by the gateway. */
export interface Connection {
  send(msg: S2C): void;
  close(code?: number, reason?: string): void;
}

export const ROOM_EMPTY_TTL_MS = 10 * 60_000;
export const ROOM_MAX_AGE_MS = 3 * 60 * 60_000;
export const SWEEP_INTERVAL_MS = 60_000;

/** What bots need to "upload" (V01 `DEV_BOTS`, v1.2 admin test rooms). */
export interface BotEnv {
  sounds: readonly BotSound[];
  put(
    code: RoomCode,
    round: number,
    submissionId: SubmissionId,
    chunkId: ChunkId,
    mime: AudioMime,
    data: Buffer,
  ): Promise<unknown>;
  onError?(e: unknown): void;
}

export interface RoomManagerDeps {
  config: Config;
  clips: readonly ClipInfo[];
  /** V05 clip libraries (DB-backed); without it every room plays `clips`. */
  library?: RoomLibrary;
  store?: RoomStore;
  /** Bot environment; by default built from `store.put` + `botSounds`. */
  bots?: BotEnv;
  /**
   * Bot sound pool provider (v1.2 #46: snippets of the official library, `LibraryBotSounds`).
   * Default `loadBotSounds(clipsDir)`. Called at startup (#53: never awaited by a request) and
   * on each test room.
   */
  botSounds?: () => Promise<readonly BotSound[]>;
  /**
   * #53: pushes of intermediate pools (the cache, fallback tones, partial snippets) while
   * `botSounds()` is still running (`LibraryBotSounds.onChange`).
   */
  onBotSoundsChange?: (fn: (pool: readonly BotSound[]) => void) => () => void;
  clock?: Clock;
  scheduler?: Scheduler;
  rng?: () => number;
  /** V09: rates finished public games (`Ratings`); private games never reach it. */
  ratings?: { recordGame(game: FinishedGame): unknown };
  /** V15 aggregate analytics (no ids); rooms count games, rounds, votes, drop-offs. */
  analytics?: Tracker;
}

/** V08: public-room events, routed to the matchmaker. */
export interface PublicRoomHooks {
  onRequeue(code: RoomCode, playerId: PlayerId, userId: string | null): void;
  onVoteKicked(code: RoomCode, playerId: PlayerId, userId: string | null): void;
  onReport(report: PlayerReport): void;
}

/** A live human room socket, as counted by presence (V07). */
export interface HumanConnection {
  code: RoomCode;
  playerId: PlayerId;
  userId: string | null;
  phase: Phase;
}

/** Owns all rooms: codes, caps, socket routing and disposal. */
export class RoomManager {
  private readonly rooms = new Map<RoomCode, Room>();
  private readonly activity = new Set<() => void>();
  private readonly conns = new Map<RoomCode, Map<PlayerId, Connection>>();
  private readonly clock: Clock;
  private readonly scheduler: Scheduler;
  private sweepHandle: ReturnType<typeof setInterval> | null = null;
  private publicHooks: PublicRoomHooks | null = null;
  /** V09: queue mode each public room was matched from (its games' `kind`). */
  private readonly modes = new Map<RoomCode, QueueMode>();
  /** v1.2 #46: admin test rooms (bots allowed without DEV_BOTS, no analytics). */
  private readonly testRooms = new Set<RoomCode>();
  /** v1.2 #47: per-room bot voice schedulers (rooms with bots only). */
  private readonly voices = new Map<RoomCode, BotVoiceScheduler>();
  private readonly bots: BotEnv;
  /** Our own sound array (filled in place) unless `deps.bots` was given. */
  private readonly ownSounds: BotSound[] | null = null;
  /** The pool before the last swap, so in-flight `botVoice` URLs keep resolving. */
  private retiredSounds: readonly BotSound[] = [];
  private unsubSounds: (() => void) | null = null;
  /** Resolves once the bot sound pool is loaded (immediately without DEV_BOTS). */
  botsReady: Promise<void>;

  constructor(private readonly deps: RoomManagerDeps) {
    this.clock = deps.clock ?? { now: () => Date.now() };
    this.scheduler = deps.scheduler ?? realScheduler;
    this.botsReady = Promise.resolve();
    if (deps.bots) {
      this.bots = deps.bots;
    } else {
      const store = deps.store;
      this.ownSounds = [];
      this.bots = {
        sounds: this.ownSounds,
        put: (...args) => (store?.put ? store.put(...args) : Promise.resolve()),
      };
      // Bots only need sounds once a round starts. DEV_BOTS: the quick dev pool (script output
      // or synthetic tones) right away, then the library pool once it is cut (`botSounds`).
      const own = this.ownSounds;
      this.unsubSounds = deps.onBotSoundsChange?.((s) => this.swapSounds(s)) ?? null;
      if (deps.config.devBots) {
        this.botsReady = loadBotSounds(deps.config.clipsDir).then(
          (s) => {
            if (own.length === 0) own.push(...s);
            if (deps.botSounds) void this.refreshBotSounds();
          },
          () => {},
        );
      } else if (deps.botSounds) {
        // #53: load (or start cutting) the library pool at startup, not on the first test room.
        void this.refreshBotSounds();
      }
    }
  }

  /** Replaces the shared pool in place (bots pick per chunk; recorded chunks stay as they are). */
  private swapSounds(s: readonly BotSound[]): void {
    const own = this.ownSounds;
    if (!own || s.length === 0 || (s.length === own.length && s.every((x, i) => x === own[i])))
      return;
    this.retiredSounds = [...own];
    own.splice(0, own.length, ...s);
  }

  private botRefresh: Promise<void> = Promise.resolve();

  /** (Re)loads the sound pool into the array every bot shares. Never rejects. */
  refreshBotSounds(): Promise<void> {
    const own = this.ownSounds;
    if (!own) return Promise.resolve();
    const load = this.deps.botSounds ?? (() => loadBotSounds(this.deps.config.clipsDir));
    this.botRefresh = load().then(
      (s) => this.swapSounds(s),
      () => {},
    );
    return this.botRefresh;
  }

  /**
   * v1.2 #47: the pool snippet behind `GET /api/bot-sounds/:key`, if it is in the pool (or was,
   * before the last swap).
   */
  botSound(key: string): BotSound | undefined {
    const match = (s: BotSound) => botSoundKey(s) === key;
    return this.bots.sounds.find(match) ?? this.retiredSounds.find(match);
  }

  /** Number of snippets bots can "record" (0 = bots submit empty dubs). */
  get botSoundCount(): number {
    return this.bots.sounds.length;
  }

  isTestRoom(code: RoomCode): boolean {
    return this.testRooms.has(code);
  }

  /**
   * v1.2 #46 admin test game: a private room hosted by `name` (linked to `userId` if given), its
   * settings applied (short dubbing times allowed), and `bots` bots seated. The room allows the
   * lobby's bot controls without DEV_BOTS and never reaches analytics or Elo. Refreshes the bot
   * sound pool in the background; #53: never waits for it (a cold pool plays the fallback tones
   * and swaps to the library snippets when they are cut).
   */
  createTestRoom(opts: {
    name: string;
    userId?: string | null;
    bots: number;
    settings: Partial<GameSettings>;
  }): { room: Room; join: JoinResult } | RoomError {
    const room = this.newRoom('private', true);
    if (!(room instanceof Room)) return room;
    const join = room.join(opts.name);
    if ('code' in join) {
      room.dispose();
      return join;
    }
    const host = join.playerId;
    if (opts.userId) room.linkUser(host, opts.userId);
    this.testRooms.add(room.code);
    this.register(room); // before bots: they attach as connections
    const fail = (e: RoomError) => {
      void this.dispose(room.code);
      return e;
    };
    const set = room.handle(host, {
      t: 'updateSettings',
      settings: { mode: 'extended', ...opts.settings },
    });
    if (set) return fail(set);
    for (let i = 0; i < opts.bots; i++) {
      const e = room.handle(host, { t: 'addBot' });
      if (e) return fail(e);
    }
    void this.refreshBotSounds();
    return { room, join };
  }

  get size(): number {
    return this.rooms.size;
  }

  stats(): { rooms: number; players: number } {
    let players = 0;
    for (const r of this.rooms.values()) players += r.playerCount;
    return { rooms: this.rooms.size, players };
  }

  codes(): RoomCode[] {
    return [...this.rooms.keys()];
  }

  /** Libraries changed (admin edit): lobbies re-send their clip counts / tags. */
  libraryChanged(): void {
    for (const r of this.rooms.values()) r.libraryChanged();
  }

  get(code: RoomCode): Room | undefined {
    return this.rooms.get(code);
  }

  /** New room with `name` as host. Fails with ROOM_FULL at `MAX_ROOMS`. */
  create(name: string): { room: Room; join: JoinResult } | RoomError {
    const room = this.newRoom('private');
    if (!(room instanceof Room)) return room;
    const join = room.join(name);
    if ('code' in join) return join;
    this.register(room);
    return { room, join };
  }

  /** V08: an empty, server-hosted public room; the matchmaker seats the players. */
  /**
   * V13: clips a new public room can deal per round: the default library's enabled clips
   * (public rooms keep the default settings), same fallback as `Room`.
   */
  publicClipCount(): number {
    const lib = this.deps.library;
    const d = lib?.defaultId();
    const clips = (d && lib?.clipsOf(d)) || this.deps.clips;
    return clips.length;
  }

  createPublic(mode: QueueMode = 'casual'): Room | RoomError {
    const room = this.newRoom('public');
    if (!(room instanceof Room)) return room;
    this.register(room);
    this.modes.set(room.code, mode);
    return room;
  }

  /** V08: where public rooms report requeues, vote-kicks and reports (the matchmaker). */
  setPublicHooks(hooks: PublicRoomHooks | null): void {
    this.publicHooks = hooks;
  }

  private register(room: Room): void {
    this.rooms.set(room.code, room);
    this.conns.set(room.code, new Map());
  }

  private newRoom(kind: RoomKind, test = false): Room | RoomError {
    if (this.rooms.size >= this.deps.config.maxRooms) {
      return { code: 'ROOM_FULL', message: 'server is full, try again later' };
    }
    let code: RoomCode;
    do code = generateRoomCode(this.deps.rng);
    while (this.rooms.has(code));
    const { config, store } = this.deps;
    const room = new Room({
      code,
      kind,
      clock: this.clock,
      scheduler: this.scheduler,
      emit: (pid, msg) => {
        this.conns.get(code)?.get(pid)?.send(msg);
        this.changed();
      },
      clips: this.deps.clips,
      library: this.deps.library,
      timings: config.timings,
      options: {
        allowSolo: config.allowSolo,
        allowShortDubbing: config.allowShortDubbing || test,
        maxPlayers: config.maxPlayers,
        limits: LIMITS,
        devBots: config.devBots,
      },
      isUploaded: store ? (sub, chunk) => store.isUploaded(code, sub, chunk) : undefined,
      onPlayerRemoved: (pid) => {
        const c = this.conns.get(code)?.get(pid);
        if (c) {
          this.conns.get(code)!.delete(pid);
          c.close(4001, 'removed');
          this.changed();
        }
      },
      onBotAdded: (pid) => {
        this.attach(code, pid, this.newBot(room, pid));
        this.botVoice(room).sync();
      },
      onRequeue: (pid, uid) => this.publicHooks?.onRequeue(code, pid, uid),
      onVoteKicked: (pid, uid) => this.publicHooks?.onVoteKicked(code, pid, uid),
      onReport: (r) => this.publicHooks?.onReport(r),
      onFinal: (seats) => this.gameOver(code, kind, seats),
      // v1.2 #46: an admin test room lets its host add/remove bots without DEV_BOTS.
      isAdmin: () => test,
      rng: this.deps.rng,
      // Test games are not product usage: no analytics at all (and private rooms skip Elo).
      analytics: test ? undefined : this.roomTracker(() => room),
    });
    if (!test) this.deps.analytics?.track('room_created', { kind });
    return room;
  }

  /**
   * The room's V15 tracker, plus v1.2 #45 unique players: when a game starts, every human
   * player linked to a user counts once per day (`game_player_unique`, in-memory hashes only).
   */
  private roomTracker(room: () => Room): Tracker | undefined {
    const a = this.deps.analytics;
    if (!a) return undefined;
    return {
      track: (event, dims, by) => {
        a.track(event, dims, by);
        if (event !== 'game_started' || !a.unique) return;
        const r = room();
        for (const pid of r.playerIds()) {
          const uid = r.userIdOf(pid);
          if (uid) a.unique('game_player_unique', uid, { kind: dims?.kind });
        }
      },
    };
  }

  /** V09: public games are rated; private ones never touch Elo. */
  private gameOver(code: RoomCode, kind: RoomKind, seats: FinalSeat[]): void {
    if (kind !== 'public' || !this.deps.ratings) return;
    try {
      this.deps.ratings.recordGame({
        kind: this.modes.get(code) ?? 'casual',
        roomCode: code,
        seats,
      });
    } catch (e) {
      console.error('[elo] recording game failed', e);
    }
  }

  /** v1.2 #47: the room's bot voice scheduler (created with its first bot). */
  private botVoice(room: Room): BotVoiceScheduler {
    const code = room.code;
    let v = this.voices.get(code);
    if (!v) {
      v = new BotVoiceScheduler({
        clock: this.clock,
        scheduler: this.scheduler,
        rng: this.deps.rng,
        state: () => (this.rooms.get(code) === room ? room.botVoiceState() : null),
        sounds: () => this.bots.sounds,
        speak: (playerId, sound) => {
          const msg: S2C = {
            t: 'botVoice',
            playerId,
            soundUrl: botSoundUrl(sound),
            durationMs: sound.durationMs,
          };
          // Humans only, and only those in voice (public rooms: opted in; they have no bots).
          for (const [pid, conn] of this.conns.get(code) ?? []) {
            if (!(conn instanceof BotPlayer) && room.inVoice(pid)) conn.send(msg);
          }
        },
      });
      this.voices.set(code, v);
    }
    return v;
  }

  private newBot(room: Room, playerId: PlayerId): BotPlayer {
    const bots = this.bots;
    return new BotPlayer({
      room,
      playerId,
      clock: this.clock,
      scheduler: this.scheduler,
      sounds: bots.sounds,
      put: (round, sub, chunk, mime, data) => bots.put(room.code, round, sub, chunk, mime, data),
      rng: this.deps.rng,
      onError: bots.onError,
    });
  }

  /**
   * `fn` runs (synchronously, possibly many times per mutation) whenever sockets attach/detach
   * or a room emits; listeners coalesce it themselves (presence throttles). Returns unsubscribe.
   */
  onActivity(fn: () => void): () => void {
    this.activity.add(fn);
    return () => void this.activity.delete(fn);
  }

  private changed(): void {
    for (const fn of this.activity) fn();
  }

  /** Every live human room socket (bots excluded), for presence counts (V07). */
  *humanConnections(): Generator<HumanConnection> {
    for (const [code, map] of this.conns) {
      const room = this.rooms.get(code);
      if (!room) continue;
      for (const [playerId, conn] of map) {
        if (conn instanceof BotPlayer) continue;
        yield { code, playerId, userId: room.userIdOf(playerId), phase: room.currentPhase };
      }
    }
  }

  /** Registers `conn` as the player's socket, closing any previous one (token reconnect). */
  attach(code: RoomCode, playerId: PlayerId, conn: Connection): void {
    const map = this.conns.get(code);
    if (!map) return;
    const prev = map.get(playerId);
    map.set(playerId, conn);
    this.changed();
    if (prev && prev !== conn) prev.close(4000, 'replaced by a new connection');
  }

  /** True if `conn` was the player's current socket (and is now removed). */
  detach(code: RoomCode, playerId: PlayerId, conn: Connection): boolean {
    const map = this.conns.get(code);
    if (map?.get(playerId) !== conn) return false;
    map.delete(playerId);
    this.changed();
    return true;
  }

  connection(code: RoomCode, playerId: PlayerId): Connection | undefined {
    return this.conns.get(code)?.get(playerId);
  }

  async dispose(code: RoomCode): Promise<void> {
    const room = this.rooms.get(code);
    if (!room) return;
    room.dispose();
    this.rooms.delete(code);
    this.modes.delete(code);
    this.testRooms.delete(code);
    this.voices.get(code)?.dispose();
    this.voices.delete(code);
    const map = this.conns.get(code);
    this.conns.delete(code);
    this.changed();
    for (const c of map?.values() ?? []) {
      c.send({ t: 'error', code: 'ROOM_NOT_FOUND', message: 'room closed', fatal: true });
      c.close(4004, 'room closed');
    }
    await this.deps.store?.deleteRoom(code);
  }

  /** Disposes rooms empty for 10 min or older than 3 h. Returns the disposed codes. */
  async sweep(): Promise<RoomCode[]> {
    const now = this.clock.now();
    const gone: RoomCode[] = [];
    for (const [code, room] of this.rooms) {
      const empty = room.emptySince;
      if (
        now - room.createdAt >= ROOM_MAX_AGE_MS ||
        (empty !== null && now - empty >= ROOM_EMPTY_TTL_MS)
      ) {
        gone.push(code);
      }
    }
    for (const code of gone) await this.dispose(code);
    return gone;
  }

  start(intervalMs = SWEEP_INTERVAL_MS): void {
    if (this.sweepHandle) return;
    this.sweepHandle = setInterval(() => void this.sweep(), intervalMs);
    this.sweepHandle.unref?.();
  }

  async stop(): Promise<void> {
    if (this.sweepHandle) clearInterval(this.sweepHandle);
    this.sweepHandle = null;
    this.unsubSounds?.();
    this.unsubSounds = null;
    for (const code of [...this.rooms.keys()]) await this.dispose(code);
  }
}
