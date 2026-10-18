import { createHash } from 'node:crypto';
import { routes, voiceAllowed, type Phase, type PlayerId, type ShowcaseStatus } from '@dub/shared';
import { Timers } from '../room/timers.js';
import type { Clock, Scheduler } from '../room/types.js';
import type { BotSound } from './BotPlayer.js';

/**
 * v1.2 #47: bots "talk" in voice phases. Bots have no WebRTC; instead the server picks a
 * snippet of the bot sound pool now and then and broadcasts `{t:'botVoice'}` to the room, and
 * each client plays it like that player's voice (mute / volume / host mute apply).
 *
 * One scheduler per room. Every bot has its own timer (a random 6–20 s gap after its last
 * line), and the room is serialized: a bot whose turn comes while another one is still talking
 * waits until that one is done (plus a short pause). Bots talk only while voice is allowed
 * (`voiceAllowed`: never in DUBBING) and, in SHOWCASE, only between dubs (LOADING / LOCKED),
 * never while one PLAYs. Host-muted bots skip their turn.
 */

/** Tuning (ms); exported for tests. */
export const BOT_VOICE = {
  /** Pause after a bot's own line before its next one. */
  gapMs: [6000, 20_000],
  /** First line after the bot joined. */
  firstMs: [1500, 8000],
  /** Pause after another bot's line when the turn came during it. */
  afterOtherMs: [400, 1500],
  /** Re-check while the phase does not allow talking. */
  retryMs: [1000, 3000],
} as const;

/** What the scheduler reads from the room at each turn (`null` = room gone). */
export interface BotVoiceRoomState {
  phase: Phase;
  showcaseStatus: ShowcaseStatus | null;
  bots: readonly { id: PlayerId; mutedByHost: boolean }[];
}

export interface BotVoiceDeps {
  clock: Clock;
  scheduler: Scheduler;
  state(): BotVoiceRoomState | null;
  sounds(): readonly BotSound[];
  speak(playerId: PlayerId, sound: BotSound): void;
  rng?: () => number;
}

/** May a bot start a line now? */
export function botMayTalk(phase: Phase, showcaseStatus: ShowcaseStatus | null): boolean {
  if (!voiceAllowed(phase, showcaseStatus)) return false;
  return phase !== 'SHOWCASE' || showcaseStatus !== 'PLAYING';
}

const keys = new WeakMap<BotSound, string>();

/** Content-addressed key of a pool snippet (`<sha256 prefix>.webm`), cached per object. */
export function botSoundKey(sound: BotSound): string {
  let k = keys.get(sound);
  if (!k) {
    k = `${createHash('sha256').update(sound.data).digest('hex').slice(0, 24)}.webm`;
    keys.set(sound, k);
  }
  return k;
}

/** Public URL of a pool snippet (`GET /api/bot-sounds/:key`). */
export function botSoundUrl(sound: BotSound): string {
  return routes.botSound.replace(':key', botSoundKey(sound));
}

export class BotVoiceScheduler {
  private readonly timers: Timers;
  private readonly rng: () => number;
  private readonly bots = new Set<PlayerId>();
  private busyUntil = 0;
  private disposed = false;

  constructor(private readonly deps: BotVoiceDeps) {
    this.timers = new Timers(deps.scheduler);
    this.rng = deps.rng ?? Math.random;
  }

  private between([lo, hi]: readonly [number, number]): number {
    return lo + this.rng() * (hi - lo);
  }

  /** Picks up bots that joined (call after a bot was added). Bots that left drop out on turn. */
  sync(): void {
    if (this.disposed) return;
    const s = this.deps.state();
    if (!s) return this.dispose();
    for (const b of s.bots) {
      if (this.bots.has(b.id)) continue;
      this.bots.add(b.id);
      this.schedule(b.id, this.between(BOT_VOICE.firstMs));
    }
  }

  get size(): number {
    return this.bots.size;
  }

  private schedule(id: PlayerId, ms: number): void {
    this.timers.set(id, ms, () => this.turn(id));
  }

  private turn(id: PlayerId): void {
    if (this.disposed) return;
    const s = this.deps.state();
    if (!s) return this.dispose();
    const bot = s.bots.find((b) => b.id === id);
    if (!bot) {
      this.bots.delete(id);
      return;
    }
    if (!botMayTalk(s.phase, s.showcaseStatus)) {
      this.schedule(id, this.between(BOT_VOICE.retryMs));
      return;
    }
    const now = this.deps.clock.now();
    if (now < this.busyUntil) {
      this.schedule(id, this.busyUntil - now + this.between(BOT_VOICE.afterOtherMs));
      return;
    }
    const pool = this.deps.sounds();
    if (bot.mutedByHost || pool.length === 0) {
      this.schedule(id, this.between(BOT_VOICE.gapMs));
      return;
    }
    const sound = pool[Math.floor(this.rng() * pool.length)]!;
    this.busyUntil = now + sound.durationMs;
    this.deps.speak(id, sound);
    this.schedule(id, sound.durationMs + this.between(BOT_VOICE.gapMs));
  }

  dispose(): void {
    this.disposed = true;
    this.timers.clearAll();
    this.bots.clear();
  }
}
