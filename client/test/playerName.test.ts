import { describe, expect, it } from 'vitest';
import type { MeUser } from '@dub/shared';
import { defaultPlayerName, prefillName, roomOnlyNameOf } from '../src/state/playerName';

const user = (kind: MeUser['kind'], displayName: string | null): MeUser => ({
  id: 'u1',
  kind,
  displayName,
  email: kind === 'registered' ? 'a@example.org' : null,
  elo: 1000,
  publicGamesPlayed: 0,
});

// #41: which name the Home / invite name fields start with, and when the prefill may change it.
describe('defaultPlayerName', () => {
  it('registered: the account name wins over the last room name in this browser', () => {
    expect(defaultPlayerName(user('registered', 'Marcel'), 'Room Name')).toBe('Marcel');
  });
  it('registered without a name: falls back to the last-used name', () => {
    expect(defaultPlayerName(user('registered', null), 'Room Name')).toBe('Room Name');
  });
  it('guest: the last-used name (browser first, then the profile)', () => {
    expect(defaultPlayerName(user('guest', 'Server Name'), 'Local Name')).toBe('Local Name');
    expect(defaultPlayerName(user('guest', 'Server Name'), '')).toBe('Server Name');
    expect(defaultPlayerName(null, 'Local Name')).toBe('Local Name');
    expect(defaultPlayerName(null, '')).toBe('');
  });
});

describe('prefillName', () => {
  it('an untouched field follows the profile as it loads and changes', () => {
    let f = { value: 'Old Room Name', edited: false };
    f = prefillName(f, user('registered', 'Marcel'), 'Old Room Name');
    expect(f).toEqual({ value: 'Marcel', edited: false });
    // Renamed in the account menu → the field follows.
    f = prefillName(f, user('registered', 'Marcel B'), 'Old Room Name');
    expect(f.value).toBe('Marcel B');
  });
  it('never clobbers what the user typed (or rolled with the dice)', () => {
    const typed = { value: 'Mor', edited: true };
    expect(prefillName(typed, user('registered', 'Marcel'), '')).toBe(typed);
    const cleared = { value: '', edited: true };
    expect(prefillName(cleared, user('guest', 'Gus'), 'Gus')).toBe(cleared);
  });
  it('keeps the same object when nothing changes', () => {
    const f = { value: 'Gus', edited: false };
    expect(prefillName(f, user('guest', 'Gus'), 'Gus')).toBe(f);
  });
});

describe('roomOnlyNameOf', () => {
  it('names the account when a registered user plays under a different name', () => {
    expect(roomOnlyNameOf(user('registered', 'Marcel'), 'Morgan Freeman')).toBe('Marcel');
    expect(roomOnlyNameOf(user('registered', 'Marcel'), ' Marcel ')).toBeNull();
    expect(roomOnlyNameOf(user('registered', 'Marcel'), '  ')).toBeNull();
    expect(roomOnlyNameOf(user('guest', 'Gus'), 'Other')).toBeNull();
    expect(roomOnlyNameOf(null, 'Other')).toBeNull();
  });
});
