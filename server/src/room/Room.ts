import { randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import {
  DUBBING_SECONDS_RANGE,
  NORMAL_SETTINGS,
  ROUNDS_RANGE,
  SHORT_DUBBING_MIN_SECONDS,
  availableClipCount,
  buildFinal,
  buildRoundResult,
  collectTags,
  paths,
  pickClip,
  shuffle,
  validateManifest,
  type C2S,
  type ChunkMeta,
  type ChunkRef,
  type ClipInfo,
  type FinalResult,
  type GameSettings,
  type Phase,
  type PlayerId,
  type PlayerPublic,
  type RoomCode,
  type RoomInfoResponse,
  type RoomSnapshot,
  type RoundResult,
  type ShowcaseItem,
  type SubmissionId,
} from '@dub/shared';
import { Timers } from './timers.js';
import type { Outcome, RoomDeps, RoomError, Submission } from './types.js';

interface PlayerState {
  id: PlayerId;
  name: string;
  token: string;
  seq: number;
  connected: boolean;
  disconnectedAt: number | null;
  micOk: boolean;
  ready: boolean;
  dubDone: boolean;
  totalScore: number;
}

interface RoundState {
  round: number;
  clip: ClipInfo;
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
  private readonly usedClipIds = new Set<string>();
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

  constructor(deps: RoomDeps) {
    this.deps = deps;
    this.code = deps.code;
    this.timers = new Timers(deps.scheduler);
    this.rng = deps.rng ?? Math.random;
    this.newId = deps.newId ?? (() => nanoid(12));
    this.newToken = deps.newToken ?? (() => randomBytes(32).toString('base64url'));
    this.createdAt = deps.clock.now();
    this.emptySinceAt = this.createdAt;
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
  get connectedCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }
  /** Epoch ms since the room has had no connected player, or null. */
  get emptySince(): number | null {
    return this.connectedCount === 0 ? this.emptySinceAt : null;
  }
  get revision(): number {
    return this.rev;
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

  authenticate(token: string): PlayerId | null {
    return this.tokens.get(token) ?? null;
  }

  info(): RoomInfoResponse {
    return {
      code: this.code,
      phase: this.phase,
      playerCount: this.players.size,
      maxPlayers: this.deps.options.maxPlayers,
      joinable: this.phase === 'LOBBY' && this.players.size < this.deps.options.maxPlayers,
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
    };
    this.players.set(p.id, p);
    this.tokens.set(p.token, p.id);
    if (!this.hostId) this.hostId = p.id;
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
    this.changed();
    return null;
  }

  private setReady(p: PlayerState, ready: boolean): Outcome {
    if (this.phase !== 'LOBBY') return err('BAD_PHASE', 'not in lobby');
    if (ready && !p.micOk) return err('INVALID', 'mic check required before ready');
    p.ready = ready;
    this.changed();
    return null;
  }

  private updateSettings(p: PlayerState, patch: Partial<GameSettings>): Outcome {
    if (p.id !== this.hostId) return err('NOT_HOST', 'only the host can change settings');
    if (this.phase !== 'LOBBY') return err('BAD_PHASE', 'not in lobby');
    const merged: GameSettings = { ...this.settings, ...patch };
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
      const known = new Set(collectTags(this.deps.clips));
      const tags = [...new Set(merged.tags)];
      if (tags.some((t) => !known.has(t))) return err('INVALID', 'unknown tag');
      next = { mode: 'extended', rounds, dubbingSeconds, tags };
    }
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

  private kick(p: PlayerState, target: PlayerId): Outcome {
    if (p.id !== this.hostId) return err('NOT_HOST', 'only the host can kick');
    if (this.phase !== 'LOBBY') return err('BAD_PHASE', 'not in lobby');
    if (target === p.id || !this.players.has(target)) return err('INVALID', 'cannot kick');
    this.deps.emit(target, { t: 'kicked' });
    this.remove(target, 'kick');
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
    const avail = this.availableClips();
    if (avail < this.settings.rounds) {
      out.push(
        `only ${avail} clip${avail === 1 ? '' : 's'} available for ${this.settings.rounds} rounds`,
      );
    }
    return out;
  }

  private availableClips(): number {
    return availableClipCount(this.deps.clips, this.settings.tags, this.usedClipIds);
  }

  private startGame(p: PlayerState): Outcome {
    if (p.id !== this.hostId) return err('NOT_HOST', 'only the host can start');
    if (this.phase !== 'LOBBY') return err('BAD_PHASE', 'not in lobby');
    const blockers = this.startBlockers();
    if (blockers.length > 0) return err('START_BLOCKED', blockers.join('; '));
    for (const q of this.players.values()) {
      q.totalScore = 0;
      this.timers.clear(`drop:${q.id}`);
    }
    this.rounds = [];
    this.results = [];
    this.final = null;
    this.startRound(0);
    return null;
  }

  // ---------------------------------------------------------------- dubbing

  private startRound(r: number): void {
    const clip = pickClip(this.deps.clips, this.settings.tags, this.usedClipIds, this.rng);
    if (!clip) {
      this.enterFinal();
      return;
    }
    this.usedClipIds.add(clip.id);
    const state: RoundState = {
      round: r,
      clip,
      subs: new Map(),
      byPlayer: new Map(),
      finalized: false,
    };
    for (const q of this.players.values()) {
      const sub: Submission = {
        id: this.newId(),
        playerId: q.id,
        round: r,
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
    const check = validateManifest(chunks, r.clip.durationMs, this.deps.options.limits);
    if (!check.ok) return err('INVALID', check.reason);
    sub.manifest = check.chunks;
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
    const clip = this.rounds[this.round]!.clip;
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
      r.clip,
      [...r.subs.values()].map((s) => ({
        submissionId: s.id,
        playerId: s.playerId,
        name: this.players.get(s.playerId)?.name ?? '?',
        empty: (s.chunks?.length ?? 0) === 0,
        votes: s.votes,
      })),
    );
    for (const e of result.entries) {
      const q = this.players.get(e.playerId);
      if (q) q.totalScore += e.points;
    }
    this.results[r.round] = result;
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
    this.phase = 'FINAL';
    this.phaseEndsAt = null;
    this.showcase = null;
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

  private remove(id: PlayerId, reason: 'kick' | 'drop' | 'leave'): void {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.tokens.delete(p.token);
    this.timers.clear(`drop:${id}`);
    if (this.connectedCount === 0 && p.connected) this.emptySinceAt = this.deps.clock.now();
    if (id === this.hostId) {
      const next = this.earliest((q) => q.connected) ?? this.earliest(() => true);
      this.hostId = next?.id ?? '';
      this.timers.clear('hostMigrate');
    }
    this.deps.onPlayerRemoved?.(id, reason);
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
    const next = this.earliest((q) => q.connected);
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
    this.rev++;
    for (const p of this.players.values()) if (p.connected) this.sendSnapshot(p.id);
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
      hostId: this.hostId,
      settings: { ...this.settings, tags: [...this.settings.tags] },
      availableTags: collectTags(this.deps.clips),
      clipCount: this.availableClips(),
      players: this.publicPlayers(),
      round: this.round,
      totalRounds: this.settings.rounds,
      phaseEndsAt: this.phaseEndsAt,
      clip: r && this.phase !== 'LOBBY' && this.phase !== 'FINAL' ? r.clip : null,
      showcase: this.showcaseItem(),
      roundResult: this.phase === 'ROUND_RESULTS' ? (this.results[this.round] ?? null) : null,
      final: this.phase === 'FINAL' ? this.final : null,
      you: {
        playerId: id,
        submissionId: sub && this.phase !== 'LOBBY' && this.phase !== 'FINAL' ? sub.id : null,
        manifest: sub && this.phase === 'DUBBING' ? sub.manifest : [],
        uploaded:
          sub && this.phase === 'DUBBING'
            ? sub.manifest.filter((c) => isUploaded(sub.id, c.id)).map((c) => c.id)
            : [],
        vote: item ? (sc!.votes.get(id) ?? null) : null,
        isOwnItem: item ? item.playerId === id : false,
        canStart: id === this.hostId && blockers.length === 0,
        startBlockers: blockers,
      },
    };
  }
}
