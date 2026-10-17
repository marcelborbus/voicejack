import {
  LIMITS,
  generateRoomCode,
  type AudioMime,
  type ChunkId,
  type ClipInfo,
  type PlayerId,
  type RoomCode,
  type S2C,
  type SubmissionId,
} from '@dub/shared';
import type { Config } from '../config.js';
import { BotPlayer, type BotSound } from '../bots/BotPlayer.js';
import { loadBotSounds } from '../bots/sounds.js';
import { Room, type JoinResult } from './Room.js';
import { realScheduler } from './timers.js';
import type { Clock, RoomError, Scheduler } from './types.js';

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

/** What bots need to "upload" (V01; only used when `config.devBots`). */
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
  store?: RoomStore;
  /** Bot environment; by default built from `store.put` + `loadBotSounds(clipsDir)`. */
  bots?: BotEnv;
  clock?: Clock;
  scheduler?: Scheduler;
  rng?: () => number;
}

/** Owns all rooms: codes, caps, socket routing and disposal. */
export class RoomManager {
  private readonly rooms = new Map<RoomCode, Room>();
  private readonly conns = new Map<RoomCode, Map<PlayerId, Connection>>();
  private readonly clock: Clock;
  private readonly scheduler: Scheduler;
  private sweepHandle: ReturnType<typeof setInterval> | null = null;
  private readonly bots: BotEnv | null;
  /** Resolves once the bot sound pool is loaded (immediately without DEV_BOTS). */
  readonly botsReady: Promise<void>;

  constructor(private readonly deps: RoomManagerDeps) {
    this.clock = deps.clock ?? { now: () => Date.now() };
    this.scheduler = deps.scheduler ?? realScheduler;
    this.bots = deps.bots ?? null;
    this.botsReady = Promise.resolve();
    if (!this.bots && deps.config.devBots) {
      const store = deps.store;
      const sounds: BotSound[] = [];
      this.bots = {
        sounds,
        put: (...args) => (store?.put ? store.put(...args) : Promise.resolve()),
      };
      // Filled in place; bots only need sounds once a round starts.
      this.botsReady = loadBotSounds(deps.config.clipsDir).then(
        (s) => void sounds.push(...s),
        () => {},
      );
    }
  }

  /** Number of snippets bots can "record" (0 = bots submit empty dubs). */
  get botSoundCount(): number {
    return this.bots?.sounds.length ?? 0;
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

  get(code: RoomCode): Room | undefined {
    return this.rooms.get(code);
  }

  /** New room with `name` as host. Fails with ROOM_FULL at `MAX_ROOMS`. */
  create(name: string): { room: Room; join: JoinResult } | RoomError {
    if (this.rooms.size >= this.deps.config.maxRooms) {
      return { code: 'ROOM_FULL', message: 'server is full, try again later' };
    }
    let code: RoomCode;
    do code = generateRoomCode(this.deps.rng);
    while (this.rooms.has(code));
    const { config, store } = this.deps;
    const room = new Room({
      code,
      clock: this.clock,
      scheduler: this.scheduler,
      emit: (pid, msg) => this.conns.get(code)?.get(pid)?.send(msg),
      clips: this.deps.clips,
      timings: config.timings,
      options: {
        allowSolo: config.allowSolo,
        allowShortDubbing: config.allowShortDubbing,
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
        }
      },
      onBotAdded: (pid) => this.attach(code, pid, this.newBot(room, pid)),
      isAdmin: () => false, // V05: admin users may add bots without DEV_BOTS
      rng: this.deps.rng,
    });
    const join = room.join(name);
    if ('code' in join) return join;
    this.rooms.set(code, room);
    this.conns.set(code, new Map());
    return { room, join };
  }

  private newBot(room: Room, playerId: PlayerId): BotPlayer {
    const bots = this.bots;
    return new BotPlayer({
      room,
      playerId,
      clock: this.clock,
      scheduler: this.scheduler,
      sounds: bots?.sounds ?? [],
      put: (round, sub, chunk, mime, data) =>
        bots ? bots.put(room.code, round, sub, chunk, mime, data) : Promise.resolve(),
      rng: this.deps.rng,
      onError: bots?.onError,
    });
  }

  /** Registers `conn` as the player's socket, closing any previous one (token reconnect). */
  attach(code: RoomCode, playerId: PlayerId, conn: Connection): void {
    const map = this.conns.get(code);
    if (!map) return;
    const prev = map.get(playerId);
    map.set(playerId, conn);
    if (prev && prev !== conn) prev.close(4000, 'replaced by a new connection');
  }

  /** True if `conn` was the player's current socket (and is now removed). */
  detach(code: RoomCode, playerId: PlayerId, conn: Connection): boolean {
    const map = this.conns.get(code);
    if (map?.get(playerId) !== conn) return false;
    map.delete(playerId);
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
    const map = this.conns.get(code);
    this.conns.delete(code);
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
    for (const code of [...this.rooms.keys()]) await this.dispose(code);
  }
}
