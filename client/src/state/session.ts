import type { C2S, RoomCode, S2CType, S2COf } from '@dub/shared';
import { errorText } from '@/net/errors';
import { defaultWsUrl, RoomSocket, type SocketDeps } from '@/net/socket';
import { toast } from '@/lib/toast';
import { initialRoomState, useRoomStore } from './room';
import { getToken, setToken } from './storage';

/**
 * The one live room session of this tab. A module singleton so that phase components, the
 * editor (T15) and voice (T18) can send without prop drilling.
 */
let socket: RoomSocket | null = null;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;
let unsubs: (() => void)[] = [];
const stickies = new Map<string, C2S>();

type AnyListener = (msg: never) => void;
const globalListeners = new Map<S2CType, Set<AnyListener>>();

export interface JoinOptions {
  /** Required when there is no stored token for the room. */
  name?: string;
  url?: string;
  deps?: Partial<SocketDeps>;
}

/**
 * Opens (or reuses) the session for `code`. Safe under React StrictMode: a `releaseRoom()`
 * followed immediately by `joinRoom()` for the same room keeps the existing socket, so no
 * duplicate player is created.
 */
export function joinRoom(code: RoomCode, opts: JoinOptions = {}): RoomSocket {
  if (releaseTimer) {
    clearTimeout(releaseTimer);
    releaseTimer = null;
  }
  if (socket && socket.code === code && socket.status !== 'closed') return socket;
  teardown(false);

  const s = new RoomSocket({
    url: opts.url ?? defaultWsUrl(),
    code,
    getToken: () => getToken(code),
    onToken: (token) => setToken(code, token),
    name: opts.name,
    deps: opts.deps,
  });
  socket = s;
  for (const [k, m] of stickies) s.setSticky(k, m);
  useRoomStore.setState({ ...initialRoomState, code, status: 'connecting' });

  unsubs = [
    s.onStatus((status, fatal) => {
      if (socket !== s) return;
      useRoomStore.setState({ status, fatal });
      if (fatal?.code === 'BAD_TOKEN') setToken(code, null);
    }),
    s.on('welcome', (m) =>
      useRoomStore.setState({ playerId: m.playerId, iceServers: m.iceServers, limits: m.limits }),
    ),
    s.on('state', (m) => {
      const cur = useRoomStore.getState().snapshot;
      if (cur && cur.code === m.state.code && m.state.rev < cur.rev) return;
      useRoomStore.setState({ snapshot: m.state });
    }),
    s.on('voteAck', (m) =>
      useRoomStore.setState({ lastVoteAck: { submissionId: m.submissionId, score: m.score } }),
    ),
    s.on('error', (m) => {
      if (s.fatal) return; // shown by the fatal screen
      toast(errorText(m.code, m.message), {
        variant: 'error',
        description: m.code === 'INVALID' ? m.message : undefined,
      });
    }),
  ];
  // Fan out every message type to global listeners (they survive socket re-creation).
  for (const type of [
    'welcome',
    'state',
    'pong',
    'rtc',
    'voteAck',
    'error',
    'kicked',
    'botVoice',
  ] as const) {
    unsubs.push(
      s.on(type, (m) => {
        const set = globalListeners.get(type);
        if (set) for (const fn of [...set]) (fn as (x: typeof m) => void)(m);
      }),
    );
  }
  s.connect();
  return s;
}

/** Ends the session on the next tick unless `joinRoom` re-acquires it (StrictMode remount). */
export function releaseRoom(): void {
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    teardown(false);
    useRoomStore.setState({ ...initialRoomState });
  }, 0);
}

/** Explicit "Leave room": tells the server and forgets the token. */
export function leaveRoom(): void {
  const code = socket?.code;
  teardown(true);
  if (code) setToken(code, null);
  useRoomStore.setState({ ...initialRoomState });
}

function teardown(sendLeave: boolean): void {
  for (const u of unsubs) u();
  unsubs = [];
  socket?.close(sendLeave);
  socket = null;
}

export function getSocket(): RoomSocket | null {
  return socket;
}

/** Send a client message. Returns false (and drops it) when not connected. */
export function send(msg: C2S): boolean {
  return socket?.send(msg) ?? false;
}

/** Re-sent after every (re)connect, e.g. `setSticky('mic', {t:'micStatus', ok})`. */
export function setSticky(key: string, msg: C2S | null): void {
  if (msg) stickies.set(key, msg);
  else stickies.delete(key);
  socket?.setSticky(key, msg);
}

/** Subscribe to a server message type for as long as you like (across reconnects). */
export function onServerMessage<T extends S2CType>(
  type: T,
  fn: (msg: S2COf<T>) => void,
): () => void {
  let set = globalListeners.get(type);
  if (!set) globalListeners.set(type, (set = new Set()));
  const f = fn as AnyListener;
  set.add(f);
  return () => set.delete(f);
}

/** Server epoch ms → `performance.now()` ms (uses the min-RTT clock estimate). */
export function serverToPerf(serverTs: number): number {
  return socket ? socket.serverToPerf(serverTs) : serverTs - (Date.now() - performance.now());
}

/** Best estimate of the server's current epoch ms. */
export function serverNow(): number {
  return socket ? socket.serverNow() : Date.now();
}
