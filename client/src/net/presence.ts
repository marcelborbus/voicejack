import { useEffect, useSyncExternalStore } from 'react';
import {
  PRESENCE_WS_PATH,
  STATS_PATH,
  parsePresenceS2C,
  type PresenceC2S,
  type PresenceCounts,
  type PresenceS2C,
  type PresenceS2COf,
  type PresenceS2CType,
  type StatsResponse,
} from '@dub/shared';
import { loadMe } from '@/state/me';
import { backoffDelay, type WebSocketLike } from './socket';

/** Close the socket after the tab has been hidden this long; reopen when it is visible again. */
export const HIDDEN_PAUSE_MS = 5 * 60_000;

export type PresenceStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'paused';

export interface PresenceDeps {
  createSocket: (url: string) => WebSocketLike;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  /** Resolves once the profile cookie exists, so the upgrade carries `vj_session`. */
  ready: () => Promise<unknown>;
  /** `/api/stats` fallback while the socket has not delivered counts. */
  fetchStats: () => Promise<StatsResponse | null>;
  /** null outside a browser (no visibility pausing). */
  doc: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'> | null;
  url: () => string;
}

function defaultDeps(): PresenceDeps {
  return {
    createSocket: (url) => new WebSocket(url) as unknown as WebSocketLike,
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
    ready: () => loadMe(),
    fetchStats: () =>
      fetch(STATS_PATH, { credentials: 'same-origin' })
        .then((r) => (r.ok ? (r.json() as Promise<StatsResponse>) : null))
        .catch(() => null),
    doc: typeof document === 'undefined' ? null : document,
    url: () =>
      `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${PRESENCE_WS_PATH}`,
  };
}

type Listener<T extends PresenceS2CType> = (msg: PresenceS2COf<T>) => void;

/**
 * The global `/ws/presence` connection (V07): one per tab, opened on app start and kept across
 * pages. Reconnects with the room socket's backoff, pauses while the tab is hidden > 5 min.
 * V08/V10 add message types: subscribe with `on(type, fn)` and send with `send(msg)`.
 */
export class PresenceSocket {
  private readonly deps: PresenceDeps;
  private ws: WebSocketLike | null = null;
  private attempt = 0;
  private reconnectTimer: unknown = null;
  private hiddenTimer: unknown = null;
  private started = false;
  private _status: PresenceStatus = 'idle';
  private _counts: PresenceCounts | null = null;
  private fallbackTried = false;
  private readonly countListeners = new Set<() => void>();
  private readonly listeners = new Map<PresenceS2CType, Set<(m: PresenceS2C) => void>>();

  constructor(deps: Partial<PresenceDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  get status(): PresenceStatus {
    return this._status;
  }
  get counts(): PresenceCounts | null {
    return this._counts;
  }

  /** Idempotent. Waits for the profile cookie, then connects. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.deps.doc?.addEventListener('visibilitychange', this.onVisibility);
    this._status = 'connecting';
    void this.deps.ready().finally(() => {
      if (this.started && this._status === 'connecting' && !this.ws) this.connect();
    });
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.deps.doc?.removeEventListener('visibilitychange', this.onVisibility);
    this.clearTimers();
    this.drop();
    this._status = 'idle';
  }

  send(msg: PresenceC2S): boolean {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  on<T extends PresenceS2CType>(type: T, fn: Listener<T>): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    const f = fn as (m: PresenceS2C) => void;
    set.add(f);
    return () => void set.delete(f);
  }

  /** For `useSyncExternalStore`. */
  subscribeCounts = (fn: () => void): (() => void) => {
    this.countListeners.add(fn);
    return () => void this.countListeners.delete(fn);
  };

  private connect(): void {
    this.drop();
    this._status = this.attempt === 0 ? 'connecting' : 'reconnecting';
    const ws = this.deps.createSocket(this.deps.url());
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this._status = 'open';
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws || typeof ev.data !== 'string') return;
      const msg = parsePresenceS2C(ev.data);
      if (msg) this.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.started && this._status !== 'paused') this.scheduleReconnect();
    };
    ws.onerror = () => {};
  }

  private onMessage(msg: PresenceS2C): void {
    if (msg.t === 'counts') {
      const { online, inGame, lookingForGame } = msg;
      this.setCounts({ online, inGame, lookingForGame });
    }
    const set = this.listeners.get(msg.t);
    if (set) for (const fn of [...set]) fn(msg);
  }

  private setCounts(c: PresenceCounts): void {
    this._counts = c;
    for (const fn of [...this.countListeners]) fn();
  }

  private scheduleReconnect(): void {
    this._status = 'reconnecting';
    if (!this._counts && !this.fallbackTried) {
      this.fallbackTried = true;
      void this.deps.fetchStats().then((s) => {
        if (s && !this._counts)
          this.setCounts({ online: s.online, inGame: s.inGame, lookingForGame: 0 });
      });
    }
    const delay = backoffDelay(this.attempt++);
    this.reconnectTimer = this.deps.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.started && this._status === 'reconnecting') this.connect();
    }, delay);
  }

  private readonly onVisibility = (): void => {
    const doc = this.deps.doc;
    if (!doc || !this.started) return;
    if (doc.hidden) {
      if (this.hiddenTimer === null) {
        this.hiddenTimer = this.deps.setTimeout(() => {
          this.hiddenTimer = null;
          this.pause();
        }, HIDDEN_PAUSE_MS);
      }
      return;
    }
    if (this.hiddenTimer !== null) this.deps.clearTimeout(this.hiddenTimer);
    this.hiddenTimer = null;
    if (this._status === 'paused') {
      this.attempt = 0;
      this.connect();
    }
  };

  private pause(): void {
    if (this.reconnectTimer !== null) this.deps.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this._status = 'paused';
    this.drop();
  }

  private drop(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      ws.close(1000, 'bye');
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) this.deps.clearTimeout(this.reconnectTimer);
    if (this.hiddenTimer !== null) this.deps.clearTimeout(this.hiddenTimer);
    this.reconnectTimer = this.hiddenTimer = null;
  }
}

/** The tab's singleton. `startPresence()` runs once at app start (main.tsx). */
export const presence = new PresenceSocket();

export function startPresence(): void {
  presence.start();
}

const getCounts = () => presence.counts;

/** Live counts (null until the first push). Starts the socket if nothing did yet. */
export function usePresenceCounts(): PresenceCounts | null {
  useEffect(() => presence.start(), []);
  return useSyncExternalStore(presence.subscribeCounts, getCounts, getCounts);
}
