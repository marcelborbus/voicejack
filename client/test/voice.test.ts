import type { Phase, PlayerPublic } from '@dub/shared';
import { describe, expect, it } from 'vitest';
import { desiredPeers, diffPeers, isPolite, remoteMuted, voiceGate } from '../src/voice/voicePolicy';

function player(id: string, connected = true): PlayerPublic {
  return { id, name: id, isHost: false, connected, micOk: true, ready: false, dubDone: false, totalScore: 0 };
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
