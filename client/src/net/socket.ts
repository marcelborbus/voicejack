import {
  clockOffset,
  PROTOCOL_VERSION,
  type C2S,
  type ClockSample,
  type ErrorCode,
  type RoomCode,
  type S2C,
  type S2CType,
  type S2COf,
} from '@dub/shared';

/** Minimal surface of the browser WebSocket we use (lets tests inject a fake). */
export interface WebSocketLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type WebSocketFactory = (url: string) => WebSocketLike;

export interface SocketDeps {
  createSocket: WebSocketFactory;
  /** Monotonic client clock in ms (performance.now). */
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
}

export type ConnStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface FatalError {
  code: ErrorCode | 'KICKED';
  message: string;
}

export interface RoomSocketOptions {
  url: string;
  code: RoomCode;
  /** Read at every (re)connect, so a token stored after `welcome` is reused. */
  getToken: () => string | null;
  /** Called with the token from `welcome`. */
  onToken: (token: string) => void;
  /** Name for the first hello when there is no token. */
  name?: string;
  deps?: Partial<SocketDeps>;
}

type Listener<T extends S2CType> = (msg: S2COf<T>) => void;
type StatusListener = (status: ConnStatus, fatal: FatalError | null) => void;

/** Backoff: 0.5 s, 1 s, 2 s, 4 s, then 5 s. */
export const BACKOFF_MS = [500, 1000, 2000, 4000, 5000] as const;
export function backoffDelay(attempt: number): number {
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
}

export const PING_BURST = 5;
export const PING_BURST_SPACING_MS = 120;
export const PING_INTERVAL_MS = 10_000;
/** Keep the most recent samples; the estimate uses the min-RTT one among them. */
export const MAX_CLOCK_SAMPLES = 12;

/** Errors that end the session: no point in reconnecting. */
const FATAL_CODES: ReadonlySet<ErrorCode> = new Set([
  'ROOM_NOT_FOUND',
  'ROOM_FULL',
  'GAME_IN_PROGRESS',
  'BAD_TOKEN',
  'VERSION',
]);

function defaultDeps(): SocketDeps {
  return {
    createSocket: (url) => new WebSocket(url) as unknown as WebSocketLike,
    now: () => performance.now(),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

/** Default WS URL for the current page (same host, Vite proxies `/ws` in dev). */
export function defaultWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

/**
 * One room session over WebSocket: hello/welcome, reconnect with backoff, clock sync, and a
 * typed message emitter. Knows nothing about React; `state/session.ts` wires it to the store.
 */
export class RoomSocket {
  readonly code: RoomCode;
  private readonly opts: RoomSocketOptions;
  private readonly deps: SocketDeps;
  private ws: WebSocketLike | null = null;
  private attempt = 0;
  private reconnectTimer: unknown = null;
  private pingTimers: unknown[] = [];
  private welcomed = false;
  private stopped = false;
  private _status: ConnStatus = 'idle';
  private _fatal: FatalError | null = null;
  private samples: ClockSample[] = [];
  /** server ≈ client + offset. Coarse value from serverNow until the first pong. */
  private offset = 0;
  private haveOffset = false;
  private _rtt = Number.POSITIVE_INFINITY;
  private readonly listeners = new Map<S2CType, Set<(msg: S2C) => void>>();
  private readonly statusListeners = new Set<StatusListener>();
  private readonly sticky = new Map<string, C2S>();

  constructor(opts: RoomSocketOptions) {
    this.opts = opts;
    this.code = opts.code;
    this.deps = { ...defaultDeps(), ...opts.deps };
  }

  get status(): ConnStatus {
    return this._status;
  }
  get fatal(): FatalError | null {
    return this._fatal;
  }
  get isWelcomed(): boolean {
    return this.welcomed && this._status === 'open';
  }
  /** Current clock offset estimate in ms (server − client). */
  get clockOffsetMs(): number {
    return this.offset;
  }
  get rttMs(): number {
    return this._rtt;
  }

  connect(): void {
    if (this.stopped || this.ws) return;
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const ws = this.deps.createSocket(this.opts.url);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      const token = this.opts.getToken();
      const hello: C2S = token
        ? { t: 'hello', v: PROTOCOL_VERSION, code: this.code, token }
        : { t: 'hello', v: PROTOCOL_VERSION, code: this.code, name: this.opts.name ?? '' };
      ws.send(JSON.stringify(hello));
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws || typeof ev.data !== 'string') return;
      let msg: S2C;
      try {
        msg = JSON.parse(ev.data) as S2C;
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.welcomed = false;
      this.clearPings();
      if (this.stopped) {
        this.setStatus('closed');
        return;
      }
      this.scheduleReconnect();
    };
  }

  /** Leave for good (sends `leave` if possible). */
  close(sendLeave = false): void {
    if (sendLeave) this.send({ t: 'leave' });
    this.stop(null);
  }

  /** Sends if the session is welcomed. Returns false if the message was dropped. */
  send(msg: C2S): boolean {
    const ws = this.ws;
    if (!ws || !this.welcomed || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  /**
   * Remember a message by key and (re)send it after every welcome, e.g. `micStatus`, so state
   * the server forgets on reconnect is restored. Sends immediately when connected.
   */
  setSticky(key: string, msg: C2S | null): void {
    if (msg) {
      this.sticky.set(key, msg);
      this.send(msg);
    } else {
      this.sticky.delete(key);
    }
  }

  on<T extends S2CType>(type: T, fn: Listener<T>): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    const f = fn as unknown as (msg: S2C) => void;
    set.add(f);
    return () => set.delete(f);
  }

  onStatus(fn: StatusListener): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  /** Server epoch ms → local `performance.now()` ms. */
  serverToPerf(serverTs: number): number {
    return serverTs - this.offset;
  }
  perfToServer(perf: number): number {
    return perf + this.offset;
  }
  serverNow(): number {
    return this.deps.now() + this.offset;
  }

  // ---------- internals ----------

  private handle(msg: S2C): void {
    switch (msg.t) {
      case 'welcome':
        this.welcomed = true;
        this.attempt = 0;
        this.opts.onToken(msg.token);
        this.coarseOffset(msg.serverNow);
        this.setStatus('open');
        this.startPings();
        for (const m of this.sticky.values()) this.send(m);
        break;
      case 'state':
        this.coarseOffset(msg.serverNow);
        break;
      case 'pong':
        this.addSample({ c0: msg.c, c1: this.deps.now(), s: msg.s });
        break;
      case 'error':
        if (msg.fatal || (!this.welcomed && FATAL_CODES.has(msg.code))) {
          this.emit(msg);
          this.stop({ code: msg.code, message: msg.message });
          return;
        }
        break;
      case 'kicked':
        this.emit(msg);
        this.stop({ code: 'KICKED', message: 'You were removed from the room by the host.' });
        return;
      default:
        break;
    }
    this.emit(msg);
  }

  private emit(msg: S2C): void {
    const set = this.listeners.get(msg.t);
    if (set) for (const fn of [...set]) fn(msg);
  }

  private coarseOffset(serverNow: number): void {
    if (this.haveOffset) return;
    this.offset = serverNow - this.deps.now();
  }

  private addSample(sample: ClockSample): void {
    this.samples.push(sample);
    if (this.samples.length > MAX_CLOCK_SAMPLES) this.samples.shift();
    const est = clockOffset(this.samples);
    if (est) {
      this.offset = est.offset;
      this._rtt = est.rtt;
      this.haveOffset = true;
    }
  }

  private ping(): void {
    this.send({ t: 'ping', c: this.deps.now() });
  }

  private startPings(): void {
    this.clearPings();
    for (let i = 0; i < PING_BURST; i++) {
      this.pingTimers.push(this.deps.setTimeout(() => this.ping(), i * PING_BURST_SPACING_MS));
    }
    const loop = () => {
      this.ping();
      this.pingTimers.push(this.deps.setTimeout(loop, PING_INTERVAL_MS));
    };
    this.pingTimers.push(this.deps.setTimeout(loop, PING_INTERVAL_MS));
  }

  private clearPings(): void {
    for (const h of this.pingTimers) this.deps.clearTimeout(h);
    this.pingTimers = [];
  }

  private scheduleReconnect(): void {
    const delay = backoffDelay(this.attempt);
    this.attempt++;
    this.setStatus('reconnecting');
    this.reconnectTimer = this.deps.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private stop(fatal: FatalError | null): void {
    this.stopped = true;
    this._fatal = fatal;
    this.clearPings();
    if (this.reconnectTimer != null) this.deps.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    this.welcomed = false;
    if (ws) {
      ws.onclose = null;
      try {
        ws.close(1000, 'bye');
      } catch {
        /* ignore */
      }
    }
    this.setStatus('closed');
  }

  private setStatus(s: ConnStatus): void {
    if (this._status === s && s !== 'closed') return;
    this._status = s;
    for (const fn of [...this.statusListeners]) fn(s, this._fatal);
  }
}
