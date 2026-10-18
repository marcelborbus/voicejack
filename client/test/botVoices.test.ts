import type { PlayerPublic, S2COf } from '@dub/shared';
import { describe, expect, it } from 'vitest';
import {
  BotVoices,
  type BotAudioContext,
  type BotGainNode,
  type BotSourceNode,
  type BotVoiceRoute,
} from '../src/voice/BotVoices';
import { botVoiceRoute, voiceGate } from '../src/voice/voicePolicy';

function bot(id: string, extra: Partial<PlayerPublic> = {}): PlayerPublic {
  return {
    id,
    name: id,
    isHost: false,
    connected: true,
    micOk: true,
    ready: true,
    dubDone: false,
    totalScore: 0,
    isBot: true,
    ...extra,
  };
}

class FakeGain implements BotGainNode {
  gain = { value: 1 };
  connected: unknown[] = [];
  connect(n: unknown) {
    this.connected.push(n);
    return n;
  }
  disconnect() {
    this.connected = [];
  }
}
class FakeSource implements BotSourceNode {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  connect(n: BotGainNode) {
    return n;
  }
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  disconnect() {}
  end() {
    this.onended?.();
  }
}
function fakeCtx() {
  const sources: FakeSource[] = [];
  const gains: FakeGain[] = [];
  const ctx: BotAudioContext & { state: string } = {
    state: 'running',
    destination: 'speakers',
    createBufferSource: () => {
      const s = new FakeSource();
      sources.push(s);
      return s;
    },
    createGain: () => {
      const g = new FakeGain();
      gains.push(g);
      return g;
    },
  };
  return { ctx, sources, gains };
}

const URL = `/api/bot-sounds/${'ab'.repeat(12)}.webm`;
const line = (playerId: string, soundUrl = URL): S2COf<'botVoice'> => ({
  t: 'botVoice',
  playerId,
  soundUrl,
  durationMs: 4000,
});

function setup() {
  const routes = new Map<string, BotVoiceRoute | null>();
  const f = fakeCtx();
  const loads: string[] = [];
  let changes = 0;
  const v = new BotVoices({
    ctx: () => f.ctx,
    load: async (url) => {
      loads.push(url);
      return { decoded: url };
    },
    route: (id) => routes.get(id) ?? null,
    onChange: () => void changes++,
  });
  return { v, routes, f, loads, changes: () => changes };
}

describe('botVoiceRoute (v1.2 #47)', () => {
  const on = voiceGate('LOBBY', false);
  it('routes a bot like a peer: local mute, host mute, volume', () => {
    expect(botVoiceRoute(on, null, bot('b'), false, undefined)).toEqual({
      muted: false,
      volume: 1,
    });
    expect(botVoiceRoute(on, null, bot('b'), true, 0.5)).toEqual({ muted: true, volume: 0.5 });
    expect(botVoiceRoute(on, null, bot('b', { mutedByHost: true }), false, 2)).toEqual({
      muted: true,
      volume: 1,
    });
  });
  it('never plays while voice is gated, over a PLAYING dub, or for a human', () => {
    expect(botVoiceRoute(voiceGate('DUBBING', false), null, bot('b'), false, 1)).toBeNull();
    // Self-mute only stops sending: bots stay audible.
    expect(botVoiceRoute(voiceGate('LOBBY', true), null, bot('b'), false, 1)).not.toBeNull();
    expect(botVoiceRoute(on, 'PLAYING', bot('b'), false, 1)).toBeNull();
    expect(botVoiceRoute(on, 'LOCKED', bot('b'), false, 1)).not.toBeNull();
    expect(botVoiceRoute(on, null, bot('h', { isBot: false }), false, 1)).toBeNull();
    expect(botVoiceRoute(on, null, undefined, false, 1)).toBeNull();
  });
});

describe('BotVoices', () => {
  it('plays a line through a gain at the peer volume and reports speaking', async () => {
    const h = setup();
    h.routes.set('b1', { muted: false, volume: 0.4 });
    expect(await h.v.play(line('b1'))).toBe(true);
    expect(h.f.sources[0]!.started).toBe(true);
    expect(h.f.sources[0]!.buffer).toEqual({ decoded: URL });
    expect(h.f.gains[0]!.gain.value).toBe(0.4);
    expect(h.f.gains[0]!.connected).toEqual(['speakers']);
    expect(h.v.speaking()).toEqual(['b1']);
    expect(h.v.played).toBe(1);
    // The snippet is fetched once and cached.
    h.f.sources[0]!.end();
    expect(h.v.speaking()).toEqual([]);
    expect(await h.v.play(line('b1'))).toBe(true);
    expect(h.loads).toEqual([URL]);
    expect(h.changes()).toBeGreaterThanOrEqual(3);
  });

  it('volume and mute changes apply mid-line; a closed gate stops it', async () => {
    const h = setup();
    h.routes.set('b1', { muted: false, volume: 1 });
    await h.v.play(line('b1'));
    h.routes.set('b1', { muted: false, volume: 0.25 });
    h.v.apply();
    expect(h.f.gains[0]!.gain.value).toBe(0.25);
    h.routes.set('b1', { muted: true, volume: 0.25 });
    h.v.apply();
    expect(h.f.gains[0]!.gain.value).toBe(0);
    expect(h.v.speaking()).toEqual([]);
    h.routes.set('b1', null); // DUBBING / a dub starts PLAYING
    h.v.apply();
    expect(h.f.sources[0]!.stopped).toBe(true);
  });

  it('skips muted / gated bots and foreign urls; one line per bot at a time', async () => {
    const h = setup();
    h.routes.set('m', { muted: true, volume: 1 });
    expect(await h.v.play(line('m'))).toBe(false);
    expect(await h.v.play(line('nobody'))).toBe(false); // route null
    h.routes.set('b', { muted: false, volume: 1 });
    expect(await h.v.play(line('b', 'https://evil.example/x.webm'))).toBe(false);
    expect(await h.v.play(line('b', '/api/rooms/X/chunks/1'))).toBe(false);
    expect(h.loads).toEqual([]);
    expect(h.f.sources).toHaveLength(0);
    await h.v.play(line('b'));
    await h.v.play(line('b'));
    expect(h.f.sources[0]!.stopped).toBe(true);
    expect(h.v.speaking()).toEqual(['b']);
    // Suspended audio: nothing starts.
    h.f.ctx.state = 'suspended';
    expect(await h.v.play(line('b'))).toBe(false);
    h.v.dispose();
    expect(h.f.sources.every((s) => s.stopped)).toBe(true);
  });
});
