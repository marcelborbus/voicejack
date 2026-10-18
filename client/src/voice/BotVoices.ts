import type { PlayerId, S2COf } from '@dub/shared';

/**
 * v1.2 #47: plays the server bots' "voice" (`{t:'botVoice'}`): bots have no WebRTC, so the
 * server names a pool snippet and every client plays it through WebAudio, routed like that
 * player's voice. `route(id)` is the live policy: null = not audible at all (voice gated by the
 * phase, a dub is playing, not a bot), else mute (local or by the host) and volume. Changing the
 * policy mid-line (`apply()`) mutes, re-levels or stops what is playing.
 */

export interface BotVoiceRoute {
  muted: boolean;
  /** 0–1. */
  volume: number;
}

/** The slice of WebAudio this needs (faked in tests). */
export interface BotAudioContext {
  readonly state: string;
  readonly destination: unknown;
  createBufferSource(): BotSourceNode;
  createGain(): BotGainNode;
}
export interface BotSourceNode {
  buffer: unknown;
  onended: (() => void) | null;
  connect(node: BotGainNode): unknown;
  start(): void;
  stop(): void;
  disconnect(): void;
}
export interface BotGainNode {
  gain: { value: number };
  connect(node: unknown): unknown;
  disconnect(): void;
}

export interface BotVoicesDeps {
  /** The app AudioContext, or null without WebAudio. */
  ctx(): BotAudioContext | null;
  /** Fetch + decode one snippet. */
  load(url: string): Promise<unknown>;
  route(id: PlayerId): BotVoiceRoute | null;
  /** Something started or stopped (speaking indicators). */
  onChange?(): void;
}

/** Only our own server's snippet path is ever fetched. */
const URL_OK = /^\/api\/bot-sounds\/[0-9a-f]{24}\.webm$/;

interface Live {
  src: BotSourceNode;
  gain: BotGainNode;
}

export class BotVoices {
  private readonly cache = new Map<string, Promise<unknown>>();
  private readonly live = new Map<PlayerId, Live>();
  private disposed = false;
  /** Lines actually started (e2e / debugging). */
  played = 0;

  constructor(private readonly deps: BotVoicesDeps) {}

  private load(url: string): Promise<unknown> {
    let p = this.cache.get(url);
    if (!p) {
      p = this.deps.load(url).catch(() => {
        this.cache.delete(url);
        return null;
      });
      this.cache.set(url, p);
      if (this.cache.size > 120) this.cache.delete(this.cache.keys().next().value!);
    }
    return p;
  }

  /** Plays one line if the bot is audible now (and still is once the snippet is loaded). */
  async play(msg: S2COf<'botVoice'>): Promise<boolean> {
    if (this.disposed || !URL_OK.test(msg.soundUrl)) return false;
    const pre = this.deps.route(msg.playerId);
    if (!pre || pre.muted) return false;
    const buffer = await this.load(msg.soundUrl);
    const r = this.deps.route(msg.playerId);
    const ctx = this.deps.ctx();
    if (this.disposed || !buffer || !r || r.muted || !ctx || ctx.state !== 'running') return false;
    this.stop(msg.playerId);
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    src.buffer = buffer;
    gain.gain.value = r.volume;
    src.connect(gain);
    gain.connect(ctx.destination);
    const entry: Live = { src, gain };
    src.onended = () => {
      if (this.live.get(msg.playerId) !== entry) return;
      this.live.delete(msg.playerId);
      gain.disconnect();
      this.deps.onChange?.();
    };
    src.start();
    this.live.set(msg.playerId, entry);
    this.played++;
    this.deps.onChange?.();
    return true;
  }

  /** Re-applies the routing to every line in flight (mute, volume, phase gate). */
  apply(): void {
    let changed = false;
    for (const [id, l] of [...this.live]) {
      const r = this.deps.route(id);
      if (!r) {
        this.stop(id);
        changed = true;
      } else {
        const v = r.muted ? 0 : r.volume;
        if (l.gain.gain.value !== v) {
          l.gain.gain.value = v;
          changed = true;
        }
      }
    }
    if (changed) this.deps.onChange?.();
  }

  /** Bots currently audible (speaking indicator). */
  speaking(): PlayerId[] {
    return [...this.live.keys()].filter((id) => {
      const r = this.deps.route(id);
      return !!r && !r.muted && r.volume > 0;
    });
  }

  private stop(id: PlayerId): void {
    const l = this.live.get(id);
    if (!l) return;
    this.live.delete(id);
    l.src.onended = null;
    try {
      l.src.stop();
    } catch {
      /* already stopped */
    }
    l.src.disconnect();
    l.gain.disconnect();
  }

  stopAll(): void {
    const any = this.live.size > 0;
    for (const id of [...this.live.keys()]) this.stop(id);
    if (any) this.deps.onChange?.();
  }

  dispose(): void {
    this.disposed = true;
    this.stopAll();
    this.cache.clear();
  }
}
