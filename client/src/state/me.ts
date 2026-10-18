import { useCallback, useEffect, useState } from 'react';
import { create } from 'zustand';
import { paths, type MeResponse, type MeUser } from '@dub/shared';
import { defaultPlayerName, prefillName, roomOnlyNameOf, type NameField } from './playerName';
import { getSavedName } from './storage';

/**
 * The browser's profile (V03). `GET /api/me` creates a guest account + HttpOnly session
 * cookie on the first visit, so it is requested once on app load (before any room socket
 * opens, the cookie links the room player to the account).
 */
interface MeState {
  user: MeUser | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
}

export const useMe = create<MeState>(() => ({ user: null, status: 'idle' }));

let inflight: Promise<MeUser | null> | null = null;

/** Loads (or reloads with `force`) the profile; never throws. */
export function loadMe(force = false): Promise<MeUser | null> {
  if (inflight && !force) return inflight;
  useMe.setState({ status: 'loading' });
  inflight = fetch(paths.me(), { credentials: 'same-origin' })
    .then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { user } = (await r.json()) as MeResponse;
      useMe.setState({ user, status: 'ready' });
      return user;
    })
    .catch(() => {
      useMe.setState({ status: 'error' });
      return null;
    });
  return inflight;
}

if (typeof window !== 'undefined' && typeof fetch === 'function') void loadMe();

/**
 * A player-name field (Home, invite prompt) that starts with the default name and follows the
 * profile while it loads or changes (sign-in, account rename), until the user edits it (#41).
 */
export function usePlayerName(): {
  name: string;
  /** For user edits (typing, dice): stops the prefill. */
  setName: (n: string) => void;
  /** Registered user's account name when `name` is a different, room-only name. */
  accountName: string | null;
} {
  const user = useMe((s) => s.user);
  const [field, setField] = useState<NameField>(() => ({
    value: defaultPlayerName(user, getSavedName()),
    edited: false,
  }));
  useEffect(() => {
    setField((f) => prefillName(f, user, getSavedName()));
  }, [user]);
  return {
    name: field.value,
    setName: useCallback((value: string) => setField({ value, edited: true }), []),
    accountName: roomOnlyNameOf(user, field.value),
  };
}
