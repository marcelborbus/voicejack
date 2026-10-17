import { useEffect } from 'react';
import { create } from 'zustand';
import { paths, type MeResponse, type MeUser } from '@dub/shared';

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

/** Fills an empty name field with the profile's last name once it is known. */
export function usePrefillName(name: string, setName: (n: string) => void): void {
  const displayName = useMe((s) => s.user?.displayName ?? null);
  useEffect(() => {
    if (displayName && !name) setName(displayName);
    // Only when the profile arrives; never overwrite what the user typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayName]);
}
