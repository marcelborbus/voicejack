import { randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import {
  DUBBING_SECONDS_RANGE,
  MAX_BOTS,
  NORMAL_SETTINGS,
  ROUNDS_RANGE,
  SHORT_DUBBING_MIN_SECONDS,
  assignClips,
  buildFinal,
  buildRoundResult,
  collectTags,
  emptyClipHistory,
  filterClips,
  paths,
  recordClips,
  shuffle,
  validateManifest,
  type C2S,
  type ChunkMeta,
  type ChunkRef,
  type ClipInfo,
  type FinalResult,
  type GameSettings,
  type Phase,
  type ShowcaseStatus,
  type PlayerId,
  type PlayerPublic,
  type PublicRoomState,
  type RoomKind,
  type RoomCode,
  type RoomInfoResponse,
  type RoomSnapshot,
  type RoundResult,
  type ShowcaseItem,
  type SubmissionId,
} from '@dub/shared';
import { pickBotName } from '../bots/names.js';
import { Timers } from './timers.js';
import { countBucket, type AnalyticsEvent, type Dims } from '../analytics/Analytics.js';
import type { Outcome, RemoveReason, RoomDeps, RoomError, Submission } from './types.js';

/** V08: a public game starts once at least this many matched players are ready. */
export const PUBLIC_MIN_READY = 2;

interface PlayerState {
  id: PlayerId;
  name: string;
  token: string;
  /** Account (V03) behind the player's session cookie. Server-side only, never in snapshots. */
  userId?: string;
  seq: number;
  connected: boolean;
  disconnectedAt: number | null;
  micOk: boolean;
  ready: boolean;
  dubDone: boolean;
  totalScore: number;
  /** Server-side bot (V01): driven by a BotPlayer, never host, excluded from Elo. */
  isBot: boolean;
  /** V13, public rooms: opted in to voice (see `voicePeers`). */
  voiceOptIn: boolean;
  /** #43, private rooms: muted for everyone by the host. */
  mutedByHost?: boolean;
  /** V15 analytics: phase of a mid-game disconnect not yet followed by a reconnect. */
  dropPhase?: Phase | null;
  /** V15 analytics: games this player finished in this room (a next start = "played again"). */
  gamesFinished?: number;
  /** V15 analytics: voice opt-in already counted. */
  voiceCounted?: boolean;
}

interface RoundState {
  round: number;
  subs: Map<SubmissionId, Submission>;
  byPlayer: Map<PlayerId, Submission>;
  finalized: boolean;
}

interface ShowcaseState {
  order: Submission[];
  index: number;
  status: ShowcaseItem['status'];
  startAt: number | null;
  lockAt: number | null;
  preloaded: Set<PlayerId>;
  votes: Map<PlayerId, number>;
}

/** What the gateway / REST layer gets for an accepted join. */
export interface JoinResult {
  playerId: PlayerId;
  token: string;
}

const err = (code: RoomError['code'], message: string): RoomError => ({ code, message });

/**
 * The whole game for one room as a pure state machine (PLAN §2.2). No I/O: time, timers and
 * message delivery are injected. Every mutation bumps `rev` and pushes a per-recipient
 * snapshot to every connected player.
 */
export class Room {
  readonly code: RoomCode;
  readonly createdAt: number;
  private readonly deps: RoomDeps;
  private readonly timers: Timers;
  private readonly rng: () => number;
  private readonly newId: () => string;
  private readonly newToken: () => string;

  private rev = 0;
  private seq = 0;
  private phase: Phase = 'LOBBY';
  private hostId: PlayerId = '';
  private settings: GameSettings = { ...NORMAL_SETTINGS, tags: [] };
  private readonly players = new Map<PlayerId, PlayerState>();
  private readonly tokens = new Map<string, PlayerId>();
  /** V14: which clips were dealt to whom; kept across backToLobby (clips don't repeat). */
  private readonly clipHistory = emptyClipHistory();
  private round = -1;
  private phaseEndsAt: number | null = null;
  private rounds: RoundState[] = [];
  private results: RoundResult[] = [];
  private final: FinalResult | null = null;
  private showcase: ShowcaseState | null = null;
  /** DUBBING deadline passed / all done; waiting `uploadGraceMs` before finalize. */
  private closing = false;
  /** Last time the room had no connected players (null while someone is connected). */
  private emptySinceAt: number;
  private disposed = false;
  /** V08: `public` rooms are matchmade and hosted by the server (no human host). */
  readonly kind: RoomKind;
  /** V08 public LOBBY: ready-check deadline (null before it starts and once it ended). */
  private readyEndsAt: number | null = null;
  private readyCheckStarted = false;
  /** V08: kick target → voters. */
  private readonly kickVotes = new Map<PlayerId, Set<PlayerId>>();
  /** V08: `reporter>target` pairs already reported in this room. */
  private readonly reported = new Set<string>();

  constructor(deps: RoomDeps) {
    this.deps = deps;
    this.code = deps.code;
    this.kind = deps.kind ?? 'private';
    this.timers = new Timers(deps.scheduler);
    this.rng = deps.rng ?? Math.random;
    this.newId = deps.newId ?? (() => nanoid(12));
    this.newToken = deps.newToken ?? (() => randomBytes(32).toString('base64url'));
    this.createdAt = deps.clock.now();
    this.emptySinceAt = this.createdAt;
    const lib = deps.library?.defaultId();
    if (lib) this.settings = { ...this.settings, libraryId: lib };
  }

  /** Clips of a library (V05), falling back to the default library, then `deps.clips`. */
  private clipsFor(libraryId: string | undefined): readonly ClipInfo[] {
    const lib = this.deps.library;
    if (lib) {
      const own = libraryId ? lib.clipsOf(libraryId) : null;
      if (own) return own;
      const d = lib.defaultId();
      const dflt = d ? lib.clipsOf(d) : null;
      if (dflt) return dflt;
    }
    return this.deps.clips;
  }

  private get clips(): readonly ClipInfo[] {
    return this.clipsFor(this.settings.libraryId);
  }

  /** Library contents changed (admin): lobbies get fresh clip counts and tags. */
  libraryChanged(): void {
    if (this.phase === 'LOBBY') this.changed();
  }

  // ---------------------------------------------------------------- queries

  get currentPhase(): Phase {
    return this.phase;
  }
  get currentRound(): number {
    return this.round;
  }
  get host(): PlayerId {
    return this.hostId;
  }
  get playerCount(): number {
    return this.players.size;
  }
  /** Connected humans (bots are always connected and do not keep a room alive). */
  get connectedCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.connected && !p.isBot) n++;
    return n;
  }
  get botCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.isBot) n++;
    return n;
  }
  /** Epoch ms since the room has had no connected human player, or null. */
  get emptySince(): number | null {
    return this.connectedCount === 0 ? this.emptySinceAt : null;
  }
  get revision(): number {
    return this.rev;
  }
  /**
   * V13: may these two players exchange WebRTC signaling (and so learn each other's IP)?
   * Private rooms: always. Public rooms: only when both opted in to voice.
   */
  voicePeers(a: PlayerId, b: PlayerId): boolean {
    if (this.kind !== 'public') return true;
    return !!this.players.get(a)?.voiceOptIn && !!this.players.get(b)?.voiceOptIn;
  }

  /** v1.2 #47: does this player hear voice at all (private: everyone; public: opted in)? */
  inVoice(id: PlayerId): boolean {
    const p = this.players.get(id);
    return !!p && (this.kind !== 'public' || p.voiceOptIn);
  }

  /** v1.2 #47: what the bot voice scheduler needs (phase, showcase status, bots). */
  botVoiceState(): {
    phase: Phase;
    showcaseStatus: ShowcaseStatus | null;
    bots: { id: PlayerId; mutedByHost: boolean }[];
  } {
    const bots: { id: PlayerId; mutedByHost: boolean }[] = [];
    for (const q of this.players.values()) {
      if (q.isBot) bots.push({ id: q.id, mutedByHost: this.kind === 'private' && !!q.mutedByHost });
    }
    const showcaseStatus = this.phase === 'SHOWCASE' ? (this.showcase?.status ?? null) : null;
    return { phase: this.phase, showcaseStatus, bots };
  }

  private setVoiceOptIn(p: PlayerState, on: boolean): Outcome {
    if (this.kind !== 'public' || p.voiceOptIn === on) return null;
    p.voiceOptIn = on;
    if (on && !p.isBot && !p.voiceCounted) {
      p.voiceCounted = true;
      this.track('voice_opt_in');
    }
    this.changed();
    return null;
  }

  hasPlayer(id: PlayerId): boolean {
    return this.players.has(id);
  }
  isConnected(id: PlayerId): boolean {
    return this.players.get(id)?.connected ?? false;
  }
  playerIds(): PlayerId[] {
    return [...this.players.keys()];
  }
  /** Links a player to an account (gateway, on hello). Returns the player's name, or null. */
  linkUser(playerId: PlayerId, userId: string): string | null {
    const p = this.players.get(playerId);
    if (!p) return null;
    p.userId = userId;
    return p.name;
  }
  userIdOf(playerId: PlayerId): string | null {
    return this.players.get(playerId)?.userId ?? null;
  }
  /** V06: `userId` plays here and the room's selected library is `libraryId` (clip access). */
  servesLibraryTo(userId: string, libraryId: string): boolean {
    if (this.settings.libraryId !== libraryId) return false;
    for (const p of this.players.values()) if (p.userId === userId) return true;
    return false;
  }

  authenticate(token: string): PlayerId | null {
    return this.tokens.get(token) ?? null;
  }

  info(): RoomInfoResponse {
    return {
      code: this.code,
      phase: this.phase,
      playerCount: this.players.size,
      maxPlayers: this.deps.options.maxPlayers,
      joinable:
        this.kind === 'private' &&
        this.phase === 'LOBBY' &&
        this.players.size < this.deps.options.maxPlayers,
    };
  }

  /**
   * Upload permission for `POST …/rounds/:round/chunks/:id`: allowed during DUBBING of that
   * round, including the upload grace period. Returns the player's submission id.
   */
  uploadTarget(playerId: PlayerId, round: number): { submissionId: SubmissionId } | RoomError {
    if (!this.players.has(playerId)) return err('BAD_TOKEN', 'not in room');
    if (this.phase !== 'DUBBING' || round !== this.round) {
      return err('BAD_PHASE', 'uploads are closed for this round');
    }
    const sub = this.rounds[round]?.byPlayer.get(playerId);
    if (!sub) return err('BAD_PHASE', 'no submission this round');
    return { submissionId: sub.id };
  }

  /**
   * Download permission for a chunk: the owner always; other room members once that round's
   * DUBBING has been finalized.
   */
  canDownload(playerId: PlayerId, round: number, submissionId: SubmissionId): Outcome {
    if (!this.players.has(playerId)) return err('BAD_TOKEN', 'not in room');
    const r = this.rounds[round];
    const sub = r?.subs.get(submissionId);
    if (!r || !sub) return err('INVALID', 'unknown submission');
    if (sub.playerId === playerId || r.finalized) return null;
    return err('BAD_PHASE', 'not available yet');
  }

  // ---------------------------------------------------------------- membership

  /** New player (LOBBY only). The first player becomes host. Starts disconnected. */
  join(rawName: string): JoinResult | RoomError {
    if (this.kind === 'public') {
      return err('GAME_IN_PROGRESS', 'public games are joined through matchmaking');
    }
    return this.addPlayer(rawName);
  }

  /** V08: the matchmaker seats matched players (public rooms, before the ready check). */
  seat(rawName: string, userId?: string): JoinResult | RoomError {
    if (this.kind !== 'public') return err('INVALID', 'not a public room');
    if (this.readyCheckStarted) return err('GAME_IN_PROGRESS', 'match already sealed');
    const r = this.addPlayer(rawName);
    if (!('code' in r) && userId) this.players.get(r.playerId)!.userId = userId;
    return r;
  }

  private addPlayer(rawName: string): JoinResult | RoomError {
    if (this.disposed) return err('ROOM_NOT_FOUND', 'room closed');
    if (this.phase !== 'LOBBY') return err('GAME_IN_PROGRESS', 'game already running');
    if (this.players.size >= this.deps.options.maxPlayers) return err('ROOM_FULL', 'room is full');
    const name = this.uniqueName(rawName.trim());
    const p: PlayerState = {
      id: this.newId(),
      name,
      token: this.newToken(),
      seq: this.seq++,
      connected: false,
      disconnectedAt: this.deps.clock.now(),
      micOk: false,
      ready: false,
      dubDone: false,
      totalScore: 0,
      isBot: false,
      voiceOptIn: false,
    };
    this.players.set(p.id, p);
    this.tokens.set(p.token, p.id);
    if (!this.hostId && this.kind === 'private') this.hostId = p.id;
    this.track('room_seat');
    // A created-but-never-connected player is dropped like a disconnected one.
    this.timers.set(`drop:${p.id}`, this.deps.timings.lobbyDropMs, () => this.dropIfGone(p.id));
    this.changed();
    return { playerId: p.id, token: p.token };
  }

  connect(playerId: PlayerId): Outcome {
    const p = this.players.get(playerId);
    if (!p) return err('BAD_TOKEN', 'unknown player');
    p.connected = true;
    p.disconnectedAt = null;
    p.dropPhase = null;
    this.timers.clear(`drop:${p.id}`);
    this.maybeMigrateHost();
    this.changed();
    return null;
  }

  disconnect(playerId: PlayerId): void {
    const p = this.players.get(playerId);
    if (!p || !p.connected) return;
    p.connected = false;
    p.disconnectedAt = this.deps.clock.now();
    if (!p.isBot && this.inGame()) p.dropPhase = this.phase;
    if (this.connectedCount === 0) this.emptySinceAt = p.disconnectedAt;
    if (this.phase === 'LOBBY') {
      this.timers.set(`drop:${p.id}`, this.deps.timings.lobbyDropMs, () => this.dropIfGone(p.id));
    }
    if (p.id === this.hostId) {
      this.timers.set('hostMigrate', this.deps.timings.hostMigrateMs, () => {
        this.maybeMigrateHost();
        this.changed();
      });
    }
    this.checkProgress();
    this.changed();
  }

  /** Explicit leave: removed in LOBBY, otherwise treated as a disconnect. */
  leave(playerId: PlayerId): void {
    if (this.phase === 'LOBBY') this.remove(playerId, 'leave');
    else this.disconnect(playerId);
  }

  // ---------------------------------------------------------------- messages

  /** Game messages (the gateway handles hello/ping/rtc/leave itself). */
  handle(playerId: PlayerId, msg: C2S): Outcome {
    const p = this.players.get(playerId);
    if (!p) return err('BAD_TOKEN', 'unknown player');
    switch (msg.t) {
      case 'setName':
        return this.setName(p, msg.name);
      case 'micStatus':
        return this.micStatus(p, msg.ok);
      case 'setReady':
        return this.setReady(p, msg.ready);
      case 'updateSettings':
        return this.updateSettings(p, msg.settings);
      case 'kick':
        return this.kick(p, msg.playerId);
      case 'startGame':
        return this.startGame(p);
      case 'manifest':
        return this.setManifest(p, msg.round, msg.chunks);
      case 'dubDone':
        return this.setDubDone(p, msg.round, msg.done);
      case 'preloaded':
        return this.setPreloaded(p, msg.submissionId);
      case 'vote':
        return this.vote(p, msg.submissionId, msg.score);
      case 'advance':
        return this.hostAdvance(p);
      case 'backToLobby':
        return this.backToLobby(p);
      case 'leave':
        this.leave(p.id);
        return null;
      case 'addBot':
        return this.addBot(p);
      case 'removeBot':
        return this.removeBot(p, msg.playerId);
      case 'voteKick':
        return this.voteKick(p, msg.playerId, msg.kick);
      case 'report':
        return this.report(p, msg.playerId, msg.reason);
      case 'voiceOptIn':
        return this.setVoiceOptIn(p, msg.on);
      case 'hostMute':
        return this.hostMute(p, msg.playerId, msg.muted);
      case 'hello':
      case 'ping':
      case 'rtc':
        return err('INVALID', `${msg.t} is handled by the gateway`);
    }
  }

  /** Push a fresh snapshot to one player (e.g. after an upload changed `you.uploaded`). */
  notify(playerId: PlayerId): void {
    if (this.isConnected(playerId)) this.sendSnapshot(playerId);
  }

  /** Re-send the current snapshot to a player without a rev bump (on (re)connect). */
  resend(playerId: PlayerId): void {
    this.sendSnapshot(playerId);
  }

  dispose(): void {
    // V15: a game that never reached FINAL (everyone left, or the 3 h cap): count its drop-offs.
    if (!this.disposed && this.inGame()) this.trackDropoffs();
    this.disposed = true;
    this.timers.clearAll();
  }

  // ---------------------------------------------------------------- lobby

  private setName(p: PlayerState, name: string): Outcome {
    if (this.phase !== 'LOBBY') return err('BAD_PHASE', 'names can only change in the lobby');
    p.name = this.uniqueName(name.trim(), p.id);
    this.changed();
    return null;
  }

  private micStatus(p: PlayerState, ok: boolean): Outcome {
    p.micOk = ok;
    if (!ok) p.ready = false;
    if (!this.maybeStartPublic()) this.changed();
    return null;
  }

  private setReady(p: PlayerState, ready: boolean): Outcome {
    if (this.phase !== 'LOBBY') return err('BAD_PHASE', 'not in lobby');
    if (ready && !p.micOk) return err('INVALID', 'mic check required before ready');
    p.ready = ready;
    if (!this.maybeStartPublic()) this.changed();
    return null;
  }

  private updateSettings(p: PlayerState, patch: Partial<GameSettings>): Outcome {
    if (p.id !== this.hostId) return err('NOT_HOST', 'only the host can change settings');
    if (this.phase !== 'LOBBY') return err('BAD_PHASE', 'not in lobby');
    const merged: GameSettings = { ...this.settings, ...patch };
    const libraryId = merged.libraryId;
    if (patch.libraryId !== undefined && patch.libraryId !== this.settings.libraryId) {
      const lib = this.deps.library;
      if (!lib?.clipsOf(patch.libraryId) || !lib.canUse(patch.libraryId, p.userId)) {
        return err('INVALID', 'unknown library');
      }
    }
    let next: GameSettings;
    if (merged.mode === 'normal') {
      next = { ...NORMAL_SETTINGS, tags: [] };
    } else {
      const { rounds, dubbingSeconds } = merged;
      if (!Number.isInteger(rounds) || rounds < ROUNDS_RANGE.min || rounds > ROUNDS_RANGE.max) {
        return err('INVALID', 'rounds out of range');
      }
      if (!this.validDubbingSeconds(dubbingSeconds)) {
        return err('INVALID', 'dubbing time out of range');
      }
      const known = new Set(collectTags(this.clipsFor(libraryId)));
      let tags = [...new Set(merged.tags)];
      // Tags carried over from another library are dropped; explicitly sent unknown ones fail.
      if (patch.tags && tags.some((t) => !known.has(t))) return err('INVALID', 'unknown tag');
      tags = tags.filter((t) => known.has(t));
      next = { mode: 'extended', rounds, dubbingSeconds, tags };
    }
    if (libraryId !== undefined) next.libraryId = libraryId;
    this.settings = next;
    for (const q of this.players.values()) q.ready = false;
    this.changed();
    return null;
  }

  private validDubbingSeconds(s: number): boolean {
    if (!Number.isInteger(s)) return false;
    const { min, max, step } = DUBBING_SECONDS_RANGE;
    if (s >= min && s <= max && (s - min) % step === 0) return true;
    return this.deps.options.allowShortDubbing && s >= SHORT_DUBBING_MIN_SECONDS && s <= max;
  }

  /** #43: the host mutes a player for everyone (any phase; private rooms only). */
  private hostMute(p: PlayerState, target: PlayerId, muted: boolean): Outcome {
    if (this.kind !== 'private') return err('INVALID', 'public games have no host');
    if (p.id !== this.hostId) return err('NOT_HOST', 'only the host can mute players');
    const t = this.players.get(target);
    // v1.2 #47: bots talk in voice too, so the host may mute them like anyone else.
    if (!t || t.id === p.id) return err('INVALID', 'cannot mute that player');
    if (!!t.mutedByHost === muted) return null;
    t.mutedByHost = muted;
    this.changed();
    return null;
  }

  private kick(p: PlayerState, target: PlayerId): Outcome {
    if (p.id !== this.hostId) return err('NOT_HOST', 'only the host can kick');
    if (this.phase !== 'LOBBY') return err('BAD_PHASE', 'not in lobby');
    if (target === p.id || !this.players.has(target)) return err('INVALID', 'cannot kick');
    this.deps.emit(target, { t: 'kicked' });
    this.remove(target, 'kick');
    return null;
  }

  // ---------------------------------------------------------------- bots (V01)

  /** Bots are a dev test mode: `DEV_BOTS=1` on the server, or (V05) an admin host. */
  private botsAllowed(id: PlayerId): boolean {
    if (this.kind === 'public') return false;
    return (this.deps.options.devBots ?? false) || (this.deps.isAdmin?.(id) ?? false);
  }

  private canManageBots(id: PlayerId): boolean {
    return this.phase === 'LOBBY' && id === this.hostId && this.botsAllowed(id);
  }

  private addBot(p: PlayerState): Outcome {
    if (p.id !== this.hostId) return err('NOT_HOST', 'only the host can add bots');
    if (this.phase !== 'LOBBY') return err('BAD_PHASE', 'not in lobby');
    if (!this.botsAllowed(p.id)) return err('INVALID', 'bots are disabled on this server');
    if (this.botCount >= MAX_BOTS) return err('LIMIT', `at most ${MAX_BOTS} bots`);
    if (this.players.size >= this.deps.options.maxPlayers) return err('ROOM_FULL', 'room is full');
    const taken = new Set([...this.players.values()].map((q) => q.name));
    const bot: PlayerState = {
      id: this.newId(),
      name: this.uniqueName(pickBotName(taken, this.rng)),
      token: this.newToken(),
      seq: this.seq++,
      connected: true,
      disconnectedAt: null,
      micOk: false,
      ready: false,
      dubDone: false,
      totalScore: 0,
      isBot: true,
      voiceOptIn: false,
    };
    this.players.set(bot.id, bot);
    this.tokens.set(bot.token, bot.id);
    this.deps.onBotAdded?.(bot.id);
    this.changed();
    return null;
  }

  /** Removes `target` (must be a bot) or, without a target, the most recently added bot. */
  private removeBot(p: PlayerState, target: PlayerId | undefined): Outcome {
    if (p.id !== this.hostId) return err('NOT_HOST', 'only the host can remove bots');
    if (this.phase !== 'LOBBY') return err('BAD_PHASE', 'not in lobby');
    let bot: PlayerState | undefined;
    if (target !== undefined) bot = this.players.get(target);
    else for (const q of this.players.values()) if (q.isBot && (!bot || q.seq > bot.seq)) bot = q;
    if (!bot?.isBot) return err('INVALID', 'no such bot');
    this.remove(bot.id, 'kick');
    return null;
  }

  private startBlockers(): string[] {
    if (this.phase !== 'LOBBY') return ['game already running'];
    const out: string[] = [];
    const list = [...this.players.values()];
    if (list.length < 2 && !this.deps.options.allowSolo) out.push('need at least 2 players');
    for (const q of list) {
      if (!q.connected) out.push(`${q.name} is offline`);
      else if (!q.micOk) out.push(`${q.name} has not passed the mic check`);
      else if (!q.ready) out.push(`${q.name} is not ready`);
    }
    // V14: every player dubs a different clip, so a round needs one clip per player. Once the
    // library runs out over the rounds, clips are reused (assignClips), so rounds don't count.
    const avail = this.playableClips().length;
    if (avail < list.length) {
      out.push(`only ${avail} clip${avail === 1 ? '' : 's'} for ${list.length} players`);
    }
    return out;
  }

  /** The selected library filtered by the tag setting. */
  private playableClips(): ClipInfo[] {
    return filterClips(this.clips, this.settings.tags, []);
  }

  private startGame(p: PlayerState): Outcome {
    if (p.id !== this.hostId) return err('NOT_HOST', 'only the host can start');
    if (this.phase !== 'LOBBY') return err('BAD_PHASE', 'not in lobby');
    const blockers = this.startBlockers();
    if (blockers.length > 0) return err('START_BLOCKED', blockers.join('; '));
    this.beginGame();
    return null;
  }

  private beginGame(): void {
    const humans = this.humans();
    this.track('game_started', {
      players: humans.length,
      bots: humans.length < this.players.size,
    });
    this.track('game_seat', {}, humans.length);
    this.track('replay_seat', {}, humans.filter((q) => (q.gamesFinished ?? 0) > 0).length);
    for (const q of this.players.values()) {
      q.totalScore = 0;
      this.timers.clear(`drop:${q.id}`);
    }
    this.rounds = [];
    this.results = [];
    this.final = null;
    this.startRound(0);
  }

  // ---------------------------------------------------------------- dubbing

  private startRound(r: number): void {
    // V14: one clip per player, distinct within the round, new to each player where possible.
    const ids = [...this.players.values()].sort((a, b) => a.seq - b.seq).map((q) => q.id);
    const dealt = assignClips(ids, this.playableClips(), this.clipHistory, this.rng);
    if (!dealt) {
      this.enterFinal();
      return;
    }
    recordClips(this.clipHistory, dealt);
    const state: RoundState = {
      round: r,
      subs: new Map(),
      byPlayer: new Map(),
      finalized: false,
    };
    for (const q of this.players.values()) {
      const sub: Submission = {
        id: this.newId(),
        playerId: q.id,
        round: r,
        clip: dealt.get(q.id)!,
        manifest: [],
        chunks: null,
        votes: [],
      };
      state.subs.set(sub.id, sub);
      state.byPlayer.set(q.id, sub);
      q.dubDone = false;
    }
    this.rounds[r] = state;
    this.round = r;
    this.phase = 'DUBBING';
    this.closing = false;
    this.showcase = null;
    const ms = this.settings.dubbingSeconds * 1000;
    this.phaseEndsAt = this.deps.clock.now() + ms;
    this.timers.set('phase', ms, () => this.closeDubbing());
    this.changed();
  }

  private setManifest(p: PlayerState, round: number, chunks: ChunkMeta[]): Outcome {
    if (this.phase !== 'DUBBING' || round !== this.round)
      return err('BAD_PHASE', 'not dubbing this round');
    const r = this.rounds[round]!;
    const sub = r.byPlayer.get(p.id);
    if (!sub) return err('BAD_PHASE', 'no submission this round');
    const check = validateManifest(chunks, sub.clip.durationMs, this.deps.options.limits);
    if (!check.ok) return err('INVALID', check.reason);
    sub.manifest = check.chunks;
    if (!p.isBot) {
      sub.seen ??= new Set();
      // Bounded by the chunk limits per manifest; a re-record replaces a chunk with a new id.
      if (sub.seen.size < 500) for (const c of check.chunks) sub.seen.add(c.id);
    }
    this.changedFor(p.id);
    return null;
  }

  private setDubDone(p: PlayerState, round: number, done: boolean): Outcome {
    if (this.phase !== 'DUBBING' || round !== this.round)
      return err('BAD_PHASE', 'not dubbing this round');
    p.dubDone = done;
    this.checkProgress();
    this.changed();
    return null;
  }

  /** Deadline reached or everyone done: wait `uploadGraceMs`, then finalize. */
  private closeDubbing(): void {
    if (this.phase !== 'DUBBING' || this.closing) return;
    this.closing = true;
    const now = this.deps.clock.now();
    if (this.phaseEndsAt === null || this.phaseEndsAt > now) this.phaseEndsAt = now;
    this.timers.set('phase', this.deps.timings.uploadGraceMs, () => this.finalizeDubbing());
    this.changed();
  }

  private finalizeDubbing(): void {
    const r = this.rounds[this.round]!;
    const isUploaded = this.deps.isUploaded ?? (() => false);
    for (const sub of r.subs.values()) {
      sub.chunks = sub.manifest.filter((c) => isUploaded(sub.id, c.id));
    }
    r.finalized = true;
    this.closing = false;
    this.trackSubmissions(r);
    this.phaseEndsAt = null;
    for (const q of this.players.values()) q.dubDone = false;
    const nonEmpty = [...r.subs.values()].filter((s) => s.chunks!.length > 0);
    if (nonEmpty.length === 0) {
      this.enterRoundResults();
      return;
    }
    this.phase = 'SHOWCASE';
    this.showcase = {
      order: shuffle(nonEmpty, this.rng),
      index: 0,
      status: 'LOADING',
      startAt: null,
      lockAt: null,
      preloaded: new Set(),
      votes: new Map(),
    };
    this.startItem(0);
  }

  // ---------------------------------------------------------------- showcase

  private startItem(index: number): void {
    const sc = this.showcase!;
    sc.index = index;
    sc.status = 'LOADING';
    sc.startAt = null;
    sc.lockAt = null;
    sc.preloaded = new Set();
    sc.votes = new Map();
    this.timers.set('phase', this.deps.timings.preloadMaxMs, () => this.playItem());
    this.changed();
  }

  private setPreloaded(p: PlayerState, submissionId: SubmissionId): Outcome {
    const sc = this.showcase;
    if (this.phase !== 'SHOWCASE' || !sc || sc.status !== 'LOADING')
      return err('BAD_PHASE', 'not loading');
    if (sc.order[sc.index]!.id !== submissionId) return err('BAD_PHASE', 'not the current item');
    sc.preloaded.add(p.id);
    this.checkProgress();
    return null;
  }

  private playItem(): void {
    const sc = this.showcase;
    if (this.phase !== 'SHOWCASE' || !sc || sc.status !== 'LOADING') return;
    const now = this.deps.clock.now();
    const clip = sc.order[sc.index]!.clip; // V14: this item's own clip
    sc.status = 'PLAYING';
    sc.startAt = now + this.deps.timings.playLeadMs;
    sc.lockAt = sc.startAt + clip.durationMs + this.deps.timings.voteGraceMs;
    this.timers.set('phase', sc.lockAt - now, () => this.lockItem());
    this.changed();
  }

  private vote(p: PlayerState, submissionId: SubmissionId, score: number): Outcome {
    const sc = this.showcase;
    if (this.phase !== 'SHOWCASE' || !sc || sc.status !== 'PLAYING')
      return err('BAD_PHASE', 'voting is closed');
    const item = sc.order[sc.index]!;
    if (item.id !== submissionId) return err('BAD_PHASE', 'not the current item');
    if (sc.lockAt !== null && this.deps.clock.now() >= sc.lockAt)
      return err('BAD_PHASE', 'voting is locked');
    if (item.playerId === p.id) return err('SELF_VOTE', 'you cannot rate your own dub');
    if (!Number.isInteger(score) || score < 0 || score > 10)
      return err('INVALID', 'score must be 0..10');
    sc.votes.set(p.id, score);
    this.deps.emit(p.id, { t: 'voteAck', submissionId, score });
    this.changed();
    return null;
  }

  private lockItem(): void {
    const sc = this.showcase;
    if (this.phase !== 'SHOWCASE' || !sc || sc.status !== 'PLAYING') return;
    sc.status = 'LOCKED';
    sc.order[sc.index]!.votes = [...sc.votes.values()];
    this.trackVotes(sc.order[sc.index]!, sc.votes);
    this.timers.set('phase', this.deps.timings.betweenItemsMs, () => {
      if (sc.index + 1 < sc.order.length) this.startItem(sc.index + 1);
      else this.enterRoundResults();
    });
    this.changed();
  }

  // ---------------------------------------------------------------- results

  private enterRoundResults(): void {
    const r = this.rounds[this.round]!;
    const result = buildRoundResult(
      r.round,
      [...r.subs.values()].map((s) => ({
        submissionId: s.id,
        playerId: s.playerId,
        name: this.players.get(s.playerId)?.name ?? '?',
        clip: s.clip,
        empty: (s.chunks?.length ?? 0) === 0,
        votes: s.votes,
      })),
    );
    for (const e of result.entries) {
      const q = this.players.get(e.playerId);
      if (q) q.totalScore += e.points;
    }
    this.results[r.round] = result;
    this.track('round_played');
    this.phase = 'ROUND_RESULTS';
    this.showcase = null;
    const ms = this.deps.timings.roundResultsMs;
    this.phaseEndsAt = this.deps.clock.now() + ms;
    this.timers.set('phase', ms, () => this.advance());
    this.changed();
  }

  private hostAdvance(p: PlayerState): Outcome {
    if (p.id !== this.hostId) return err('NOT_HOST', 'only the host can advance');
    if (this.phase !== 'ROUND_RESULTS') return err('BAD_PHASE', 'not showing results');
    this.advance();
    return null;
  }

  private advance(): void {
    if (this.phase !== 'ROUND_RESULTS') return;
    this.timers.clear('phase');
    if (this.round + 1 < this.settings.rounds) this.startRound(this.round + 1);
    else this.enterFinal();
  }

  private enterFinal(): void {
    this.timers.clear('phase');
    const players = [...this.players.values()]
      .sort((a, b) => a.seq - b.seq)
      .map((q) => ({ playerId: q.id, name: q.name }));
    this.final = buildFinal(players, this.results.filter(Boolean), (round, subId) =>
      this.chunkRefs(round, this.rounds[round]?.subs.get(subId)),
    );
    this.trackFinal();
    this.phase = 'FINAL';
    this.phaseEndsAt = null;
    this.showcase = null;
    this.deps.onFinal?.(
      this.final.standings.map((s) => {
        const q = this.players.get(s.playerId);
        return { ...s, userId: q?.userId ?? null, isBot: q?.isBot ?? false };
      }),
    );
    this.changed();
  }

  private backToLobby(p: PlayerState): Outcome {
    if (p.id !== this.hostId) return err('NOT_HOST', 'only the host can do that');
    if (this.phase !== 'FINAL') return err('BAD_PHASE', 'game not finished');
    this.timers.clear('phase');
    this.phase = 'LOBBY';
    this.round = -1;
    this.phaseEndsAt = null;
    this.rounds = [];
    this.results = [];
    this.final = null;
    this.showcase = null;
    const now = this.deps.clock.now();
    for (const q of [...this.players.values()]) {
      q.totalScore = 0;
      q.ready = false;
      q.dubDone = false;
      if (!q.connected) {
        const left = this.deps.timings.lobbyDropMs - (now - (q.disconnectedAt ?? now));
        this.timers.set(`drop:${q.id}`, left, () => this.dropIfGone(q.id));
      }
    }
    this.changed();
    return null;
  }

  // ---------------------------------------------------------------- public rooms (V08)

  /** Matchmaker: every matched player is seated; the ready check starts now. */
  beginReadyCheck(): void {
    if (this.kind !== 'public' || this.readyCheckStarted || this.phase !== 'LOBBY') return;
    this.readyCheckStarted = true;
    const ms = this.deps.timings.readyCheckMs;
    this.readyEndsAt = this.deps.clock.now() + ms;
    this.timers.set('readyCheck', ms, () => this.endReadyCheck());
    if (!this.maybeStartPublic()) this.changed();
  }

  private isReadyHuman(q: PlayerState): boolean {
    return !q.isBot && q.connected && q.micOk && q.ready;
  }

  /** Public ready check running and everyone is ready: start early. True if it started. */
  private maybeStartPublic(): boolean {
    if (this.kind !== 'public' || this.readyEndsAt === null || this.phase !== 'LOBBY') return false;
    const list = [...this.players.values()];
    if (list.length < PUBLIC_MIN_READY || !list.every((q) => this.isReadyHuman(q))) return false;
    this.timers.clear('readyCheck');
    this.readyEndsAt = null;
    this.beginGame();
    return true;
  }

  /** Deadline: the unready go back to the queue (front); with < 2 ready everyone does. */
  private endReadyCheck(): void {
    if (this.phase !== 'LOBBY' || this.readyEndsAt === null) return;
    this.readyEndsAt = null;
    const all = [...this.players.values()].sort((a, b) => a.seq - b.seq);
    const ready = all.filter((q) => this.isReadyHuman(q));
    const enough = ready.length >= PUBLIC_MIN_READY;
    for (const q of enough ? all.filter((x) => !this.isReadyHuman(x)) : all) {
      const userId = q.userId ?? null;
      this.deps.emit(q.id, { t: 'requeued' });
      this.remove(q.id, 'requeue');
      this.deps.onRequeue?.(q.id, userId);
    }
    if (this.disposed) return;
    if (enough) this.beginGame();
    else this.changed();
  }

  /** Votes needed to kick a connected player: majority of the other connected humans. */
  private kickNeeded(): number {
    return Math.floor(Math.max(0, this.connectedCount - 1) / 2) + 1;
  }

  private voteKick(p: PlayerState, target: PlayerId, kick: boolean): Outcome {
    if (this.kind !== 'public') return err('INVALID', 'vote-kick is only for public games');
    const t = this.players.get(target);
    if (!t || t.id === p.id || t.isBot) return err('INVALID', 'cannot vote on that player');
    let voters = this.kickVotes.get(target);
    if (kick) {
      if (!voters) this.kickVotes.set(target, (voters = new Set()));
      voters.add(p.id);
    } else if (voters) {
      voters.delete(p.id);
      if (voters.size === 0) this.kickVotes.delete(target);
    }
    if (voters && voters.size >= this.kickNeeded()) {
      const userId = t.userId ?? null;
      this.deps.emit(target, { t: 'kicked', by: 'vote' });
      this.remove(target, 'votekick');
      this.deps.onVoteKicked?.(target, userId);
      this.checkProgress();
      return null;
    }
    this.changed();
    return null;
  }

  private report(p: PlayerState, target: PlayerId, reason: string): Outcome {
    if (this.kind !== 'public') return err('INVALID', 'reports are only for public games');
    const t = this.players.get(target);
    if (!t || t.id === p.id || t.isBot) return err('INVALID', 'cannot report that player');
    const key = `${p.id}>${t.id}`;
    if (this.reported.has(key)) return err('LIMIT', 'you already reported that player');
    this.reported.add(key);
    this.deps.onReport?.({
      code: this.code,
      reporterId: p.id,
      reporterName: p.name,
      reporterUserId: p.userId ?? null,
      reportedId: t.id,
      reportedName: t.name,
      reportedUserId: t.userId ?? null,
      reason: reason.trim(),
    });
    this.changedFor(p.id);
    return null;
  }

  private forgetVotes(id: PlayerId): void {
    this.kickVotes.delete(id);
    for (const [target, voters] of this.kickVotes) {
      voters.delete(id);
      if (voters.size === 0) this.kickVotes.delete(target);
    }
  }

  private publicState(id: PlayerId): PublicRoomState | null {
    if (this.kind !== 'public') return null;
    const kickVotes: Record<PlayerId, number> = {};
    const youKickVoted: PlayerId[] = [];
    for (const [target, voters] of this.kickVotes) {
      kickVotes[target] = voters.size;
      if (voters.has(id)) youKickVoted.push(target);
    }
    const prefix = `${id}>`;
    const youReported = [...this.reported]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));
    return {
      readyEndsAt: this.readyEndsAt,
      kickVotes,
      kickNeeded: this.kickNeeded(),
      youKickVoted,
      youReported,
    };
  }

  // ---------------------------------------------------------------- analytics (V15)

  /** Aggregate counter; only the room kind and coarse values, never ids or the room code. */
  private track(event: AnalyticsEvent, dims: Dims = {}, by = 1): void {
    if (by > 0) this.deps.analytics?.track(event, { kind: this.kind, ...dims }, by);
  }

  private humans(): PlayerState[] {
    return [...this.players.values()].filter((q) => !q.isBot);
  }

  private inGame(): boolean {
    return this.phase === 'DUBBING' || this.phase === 'SHOWCASE' || this.phase === 'ROUND_RESULTS';
  }

  private trackDropoffs(): void {
    for (const q of this.humans()) {
      if (q.dropPhase) this.track('dropoff', { phase: q.dropPhase });
      q.dropPhase = null;
    }
  }

  /** At finalize: takes / re-records per human submission, clip picks and completion. */
  private trackSubmissions(r: RoundState): void {
    for (const sub of r.subs.values()) {
      if (this.players.get(sub.playerId)?.isBot !== false) continue;
      const takes = sub.chunks?.length ?? 0;
      const seen = sub.seen?.size ?? 0;
      this.track('submission', {
        takes: countBucket(takes),
        rerecords: countBucket(Math.max(0, seen - sub.manifest.length)),
      });
      this.track('clip_dealt', { clip: sub.clip.id });
      if (takes > 0) this.track('clip_dubbed', { clip: sub.clip.id });
    }
  }

  /** At lock: human votes (score histogram) and per-clip vote sums for human dubs. */
  private trackVotes(item: Submission, votes: Map<PlayerId, number>): void {
    const authorHuman = this.players.get(item.playerId)?.isBot === false;
    let n = 0;
    let sum = 0;
    for (const [voter, score] of votes) {
      if (this.players.get(voter)?.isBot !== false) continue;
      this.track('vote', { score });
      n++;
      sum += score;
    }
    if (authorHuman && n > 0) {
      this.track('clip_votes', { clip: item.clip.id }, n);
      this.track('clip_vote_sum', { clip: item.clip.id }, sum);
    }
  }

  private trackFinal(): void {
    const humans = this.humans();
    this.track('game_finished', {
      rounds: this.results.filter(Boolean).length,
      players: humans.length,
    });
    this.track('finish_seat', {}, humans.filter((q) => q.connected).length);
    this.trackDropoffs();
    for (const q of humans) q.gamesFinished = (q.gamesFinished ?? 0) + 1;
  }

  // ---------------------------------------------------------------- internals

  /** Early phase transitions that depend on who is connected. */
  private checkProgress(): void {
    const connected = [...this.players.values()].filter((q) => q.connected);
    if (this.phase === 'DUBBING' && !this.closing && connected.length > 0) {
      const subs = this.rounds[this.round]!.byPlayer;
      const relevant = connected.filter((q) => subs.has(q.id));
      if (relevant.length > 0 && relevant.every((q) => q.dubDone)) this.closeDubbing();
    } else if (
      this.phase === 'SHOWCASE' &&
      this.showcase?.status === 'LOADING' &&
      connected.length > 0
    ) {
      const sc = this.showcase;
      if (connected.every((q) => sc.preloaded.has(q.id))) this.playItem();
    }
  }

  private dropIfGone(id: PlayerId): void {
    const p = this.players.get(id);
    if (!p || p.connected || this.phase !== 'LOBBY') return;
    this.remove(id, 'drop');
  }

  private remove(id: PlayerId, reason: RemoveReason): void {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.tokens.delete(p.token);
    this.timers.clear(`drop:${id}`);
    this.forgetVotes(id);
    if (this.connectedCount === 0 && p.connected) this.emptySinceAt = this.deps.clock.now();
    if (id === this.hostId) {
      const next = this.earliest((q) => q.connected && !q.isBot) ?? this.earliest((q) => !q.isBot);
      this.hostId = next?.id ?? '';
      this.timers.clear('hostMigrate');
    }
    this.deps.onPlayerRemoved?.(id, reason);
    // Bots never outlive the last human (otherwise they would keep an empty room alive).
    if (!p.isBot && ![...this.players.values()].some((q) => !q.isBot)) {
      for (const q of [...this.players.values()]) this.remove(q.id, 'leave');
      return;
    }
    if (this.maybeStartPublic()) return;
    this.changed();
  }

  private earliest(pred: (q: PlayerState) => boolean): PlayerState | undefined {
    let best: PlayerState | undefined;
    for (const q of this.players.values()) if (pred(q) && (!best || q.seq < best.seq)) best = q;
    return best;
  }

  /** Host disconnected longer than `hostMigrateMs` → earliest-joined connected player. */
  private maybeMigrateHost(): void {
    const host = this.players.get(this.hostId);
    if (!host || host.connected || host.disconnectedAt === null) return;
    if (this.deps.clock.now() - host.disconnectedAt < this.deps.timings.hostMigrateMs) return;
    const next = this.earliest((q) => q.connected && !q.isBot);
    if (next) {
      this.hostId = next.id;
      this.timers.clear('hostMigrate');
    }
  }

  private uniqueName(name: string, self?: PlayerId): string {
    const taken = new Set(
      [...this.players.values()].filter((q) => q.id !== self).map((q) => q.name),
    );
    if (!taken.has(name)) return name;
    for (let i = 2; ; i++) {
      const suffix = ` ${i}`;
      const candidate = name.slice(0, 20 - suffix.length) + suffix;
      if (!taken.has(candidate)) return candidate;
    }
  }

  private chunkRefs(round: number, sub: Submission | undefined): ChunkRef[] {
    if (!sub?.chunks) return [];
    return sub.chunks.map((c) => ({ ...c, url: paths.chunk(this.code, round, sub.id, c.id) }));
  }

  private changed(): void {
    if (this.disposed) return;
    this.enforceLibrary();
    this.rev++;
    for (const p of this.players.values()) if (p.connected) this.sendSnapshot(p.id);
  }

  /**
   * V06: a private library stays selected only while its owner hosts. In the lobby a library
   * the host may not use (owner left and the host migrated, disabled or deleted by an admin)
   * falls back to the default; a running game keeps going.
   */
  private enforceLibrary(): void {
    const lib = this.deps.library;
    const id = this.settings.libraryId;
    if (!lib || !id || this.phase !== 'LOBBY') return;
    if (lib.canUse(id, this.players.get(this.hostId)?.userId) && lib.clipsOf(id)) return;
    const { libraryId: _old, ...rest } = this.settings;
    const d = lib.defaultId();
    this.settings = { ...rest, tags: [], ...(d && d !== id ? { libraryId: d } : {}) };
  }

  /** Mutation only visible to one player (own manifest). */
  private changedFor(id: PlayerId): void {
    this.rev++;
    this.notify(id);
  }

  private sendSnapshot(id: PlayerId): void {
    const state = this.snapshotFor(id);
    if (state) this.deps.emit(id, { t: 'state', state, serverNow: this.deps.clock.now() });
  }

  private publicPlayers(): PlayerPublic[] {
    return [...this.players.values()]
      .sort((a, b) => a.seq - b.seq)
      .map((q) => ({
        id: q.id,
        name: q.name,
        isHost: q.id === this.hostId,
        connected: q.connected,
        micOk: q.micOk,
        ready: q.ready,
        dubDone: q.dubDone,
        totalScore: q.totalScore,
        isBot: q.isBot,
        ...(this.kind === 'public' && { voiceOptIn: q.voiceOptIn }),
        // A muted player who becomes host is unmuted (nobody could unmute them otherwise).
        ...(this.kind === 'private' && { mutedByHost: !!q.mutedByHost && q.id !== this.hostId }),
      }));
  }

  private showcaseItem(): ShowcaseItem | null {
    const sc = this.showcase;
    if (this.phase !== 'SHOWCASE' || !sc) return null;
    const item = sc.order[sc.index]!;
    let expected = 0;
    for (const q of this.players.values()) if (q.connected && q.id !== item.playerId) expected++;
    return {
      submissionId: item.id,
      index: sc.index,
      total: sc.order.length,
      clip: item.clip,
      chunks: this.chunkRefs(this.round, item),
      status: sc.status,
      startAt: sc.startAt,
      lockAt: sc.lockAt,
      votesCast: sc.votes.size,
      votersExpected: expected,
    };
  }

  /** Per-recipient snapshot (null for unknown players). */
  snapshotFor(id: PlayerId): RoomSnapshot | null {
    const p = this.players.get(id);
    if (!p) return null;
    const r = this.round >= 0 ? this.rounds[this.round] : undefined;
    const sub = r?.byPlayer.get(id);
    const sc = this.phase === 'SHOWCASE' ? this.showcase : null;
    const item = sc?.order[sc.index];
    const isUploaded = this.deps.isUploaded ?? (() => false);
    const blockers = this.phase === 'LOBBY' ? this.startBlockers() : [];
    return {
      rev: this.rev,
      code: this.code,
      phase: this.phase,
      kind: this.kind,
      public: this.publicState(id),
      hostId: this.hostId,
      settings: { ...this.settings, tags: [...this.settings.tags] },
      availableTags: collectTags(this.clips),
      clipCount: this.playableClips().length,
      players: this.publicPlayers(),
      round: this.round,
      totalRounds: this.settings.rounds,
      phaseEndsAt: this.phaseEndsAt,
      showcase: this.showcaseItem(),
      roundResult: this.phase === 'ROUND_RESULTS' ? (this.results[this.round] ?? null) : null,
      final: this.phase === 'FINAL' ? this.final : null,
      you: {
        playerId: id,
        submissionId: sub && this.phase !== 'LOBBY' && this.phase !== 'FINAL' ? sub.id : null,
        clip: sub && this.phase !== 'LOBBY' && this.phase !== 'FINAL' ? sub.clip : null,
        manifest: sub && this.phase === 'DUBBING' ? sub.manifest : [],
        uploaded:
          sub && this.phase === 'DUBBING'
            ? sub.manifest.filter((c) => isUploaded(sub.id, c.id)).map((c) => c.id)
            : [],
        vote: item ? (sc!.votes.get(id) ?? null) : null,
        isOwnItem: item ? item.playerId === id : false,
        canStart: id === this.hostId && blockers.length === 0,
        startBlockers: blockers,
        canManageBots: this.canManageBots(id),
      },
    };
  }
}
