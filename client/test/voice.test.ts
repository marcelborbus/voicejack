import type { Phase, PlayerPublic } from '@dub/shared';
import { describe, expect, it } from 'vitest';
import {
  desiredPeers,
  diffPeers,
  hostMutedIds,
  isPolite,
  peerVolume,
  remoteMuted,
  voiceGate,
} from '../src/voice/voicePolicy';

function player(id: string, connected = true): PlayerPublic {
  return {
    id,
    name: id,
    isHost: false,
    connected,
    micOk: true,
    ready: false,
    dubDone: false,
    totalScore: 0,
  };
}

const PHASES: Phase[] = ['LOBBY', 'DUBBING', 'SHOWCASE', 'ROUND_RESULTS', 'FINAL'];

describe('voiceGate', () => {
  it('allows voice in every phase except DUBBING', () => {
    for (const phase of PHASES) {
      const allowed = phase !== 'DUBBING';
      expect(voiceGate(phase, false)).toEqual({ send: allowed, play: allowed });
    }
  });

  it('is off outside a room phase', () => {
    expect(voiceGate(null, false)).toEqual({ send: false, play: false });
  });

  it('self-mute stops sending but keeps playback', () => {
    expect(voiceGate('LOBBY', true)).toEqual({ send: false, play: true });
    expect(voiceGate('DUBBING', true)).toEqual({ send: false, play: false });
  });
});

describe('remoteMuted', () => {
  it('mutes when playback is gated or the peer is muted locally', () => {
    expect(remoteMuted({ send: true, play: true }, false)).toBe(false);
    expect(remoteMuted({ send: true, play: true }, true)).toBe(true);
    expect(remoteMuted({ send: false, play: false }, false)).toBe(true);
  });
});

describe('isPolite', () => {
  it('the lower id is polite, exactly one side per pair', () => {
    expect(isPolite('a', 'b')).toBe(true);
    expect(isPolite('b', 'a')).toBe(false);
  });
});

describe('desiredPeers / diffPeers', () => {
  const roster = [player('a'), player('b'), player('c', false), player('d')];

  it('wants every other connected player', () => {
    expect([...desiredPeers(roster, 'a')].sort()).toEqual(['b', 'd']);
  });

  it('never wants a server-side bot', () => {
    expect([...desiredPeers([...roster, { ...player('e'), isBot: true }], 'a')].sort()).toEqual([
      'b',
      'd',
    ]);
  });

  it('opens all peers from empty', () => {
    expect(diffPeers([], roster, 'a')).toEqual({ open: ['b', 'd'], close: [] });
  });

  it('closes disconnected and departed peers, opens new ones', () => {
    expect(diffPeers(['b', 'c', 'x'], roster, 'a')).toEqual({ open: ['d'], close: ['c', 'x'] });
  });

  it('is a no-op when in sync', () => {
    expect(diffPeers(new Set(['b', 'd']), roster, 'a')).toEqual({ open: [], close: [] });
  });

  it('never opens a peer to self and closes everything when alone', () => {
    expect(diffPeers(['a', 'b'], [player('a')], 'a')).toEqual({ open: [], close: ['a', 'b'] });
  });
});

describe('desiredPeers in public rooms (V13)', () => {
  const opt = (id: string, on: boolean): PlayerPublic => ({ ...player(id), voiceOptIn: on });

  it('wants nobody until we opted in', () => {
    expect([...desiredPeers([opt('a', false), opt('b', true)], 'a', true)]).toEqual([]);
  });

  it('wants only the other opted-in players', () => {
    const roster = [opt('a', true), opt('b', true), opt('c', false), opt('d', true)];
    expect([...desiredPeers(roster, 'a', true)].sort()).toEqual(['b', 'd']);
    expect(diffPeers(['b', 'c'], roster, 'a', true)).toEqual({ open: ['d'], close: ['c'] });
  });

  it('closes everything when we opt out', () => {
    expect(diffPeers(['b'], [opt('a', false), opt('b', true)], 'a', true)).toEqual({
      open: [],
      close: ['b'],
    });
  });
});

// #43: per-peer mute/volume and the host's "mute for everyone".
describe('host mute and volume', () => {
  it('a player the host muted sends nothing, whatever their own mute says', () => {
    for (const phase of PHASES) {
      expect(voiceGate(phase, false, true).send).toBe(false);
      expect(voiceGate(phase, false, true).play).toBe(phase !== 'DUBBING');
    }
    expect(voiceGate('LOBBY', false, false).send).toBe(true);
  });

  it('everyone else forces a host-muted peer silent, on top of their own mute', () => {
    const gate = voiceGate('LOBBY', false);
    expect(remoteMuted(gate, false, false)).toBe(false);
    expect(remoteMuted(gate, false, true)).toBe(true);
    expect(remoteMuted(gate, true, false)).toBe(true);
    expect(remoteMuted(voiceGate('DUBBING', false), false, false)).toBe(true);
  });

  it('reads host mutes from the snapshot', () => {
    const players = [
      { ...player('a'), mutedByHost: true },
      { ...player('b'), mutedByHost: false },
      player('c'),
    ];
    expect([...hostMutedIds(players)]).toEqual(['a']);
  });

  it('clamps the per-peer volume (default full)', () => {
    expect(peerVolume(undefined)).toBe(1);
    expect(peerVolume(0.4)).toBe(0.4);
    expect(peerVolume(-1)).toBe(0);
    expect(peerVolume(3)).toBe(1);
    expect(peerVolume(Number.NaN)).toBe(1);
  });
});
