import { create } from 'zustand';
import { presence } from '@/net/presence';
import { setToken } from '@/state/storage';

export type QueueStatus = 'idle' | 'joining' | 'queued';

export interface QueueState {
  status: QueueStatus;
  position: number | null;
  size: number;
  /** Local `Date.now()` at which the wait started (from the server's `waitedMs`). */
  since: number | null;
  /** Set by `matchFound`; the Home page navigates to `/r/<code>` and clears it. */
  match: string | null;
  error: string | null;
}

const initial: QueueState = {
  status: 'idle',
  position: null,
  size: 0,
  since: null,
  match: null,
  error: null,
};

/** Public matchmaking queue (V08), driven by `/ws/presence`. */
export const useQueue = create<QueueState>(() => ({ ...initial }));

let wired = false;
let lastName = '';

function wire(): void {
  if (wired) return;
  wired = true;
  presence.on('queue', (m) =>
    useQueue.setState({
      status: 'queued',
      position: m.position ?? null,
      size: m.size,
      since: Date.now() - m.waitedMs,
      error: null,
    }),
  );
  presence.on('queueLeft', () => useQueue.setState({ ...initial }));
  presence.on('matchFound', (m) => {
    // Stored like any room token: the room socket joins as this player.
    setToken(m.code, m.token);
    useQueue.setState({ ...initial, match: m.code });
  });
  presence.on('error', (m) => {
    if (useQueue.getState().status === 'idle') return;
    useQueue.setState({ ...initial, error: m.message });
  });
}

/** Starts listening for queue messages (so a server-side requeue is picked up anywhere). */
export function wireQueue(): void {
  wire();
  presence.start();
}

/** `queueJoin`. Retries once the presence socket is open. */
export function joinQueue(name: string): void {
  wireQueue();
  lastName = name;
  useQueue.setState({ ...initial, status: 'joining', since: Date.now() });
  const trySend = (left: number) => {
    if (useQueue.getState().status !== 'joining') return;
    if (presence.send({ t: 'queueJoin', name: lastName })) return;
    if (left <= 0) {
      useQueue.setState({ ...initial, error: 'Could not reach the server. Try again.' });
      return;
    }
    setTimeout(() => trySend(left - 1), 500);
  };
  trySend(20);
}

export function leaveQueue(): void {
  presence.send({ t: 'queueLeave' });
  useQueue.setState({ ...initial });
}

export function clearMatch(): void {
  useQueue.setState({ match: null });
}

export function clearQueueError(): void {
  useQueue.setState({ error: null });
}

wire();
