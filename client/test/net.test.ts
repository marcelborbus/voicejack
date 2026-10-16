import { PROTOCOL_VERSION, type C2S, type RoomSnapshot, type S2C } from '@dub/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  backoffDelay,
  PING_BURST,
  PING_BURST_SPACING_MS,
  PING_INTERVAL_MS,
  RoomSocket,
  type WebSocketLike,
} from '../src/net/socket';
import { normalizeRoomCode } from '../src/state/storage';

class FakeWs implements WebSocketLike {
  static all: FakeWs[] = [];
  readyState = 0;
  sent: C2S[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(readonly url: string) {
    FakeWs.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as C2S);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  // test helpers
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  recv(msg: S2C) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: '' });
  }
  ofType<T extends C2S['t']>(t: T) {
    return this.sent.filter((m) => m.t === t) as Extract<C2S, { t: T }>[];
  }
}

const last = () => FakeWs.all[FakeWs.all.length - 1]!;

const welcome = (token = 'tok-1', serverNow = 1_000_000): S2C => ({
  t: 'welcome',
  v: PROTOCOL_VERSION,
  playerId: 'p1',
  token,
  serverNow,
  iceServers: [],
  limits: {
    maxPlayers: 8,
    maxChunksPerSubmission: 40,
    maxChunkBytes: 1,
    maxSubmissionBytes: 1,
    minChunkMs: 300,
  },
});

let clock = 0;
let token: string | null = null;

function makeSocket(name?: string) {
  return new RoomSocket({
    url: 'ws://test/ws',
    code: 'ABCDEF',
    getToken: () => token,
    onToken: (t) => {
      token = t;
    },
    name,
    deps: {
      createSocket: (url) => new FakeWs(url),
      now: () => clock,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWs.all = [];
  clock = 0;
  token = null;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('RoomSocket hello/welcome', () => {
  it('sends hello with name when there is no token, then stores the token', () => {
    const s = makeSocket('Ada');
    s.connect();
    expect(s.status).toBe('connecting');
    last().open();
    expect(last().sent[0]).toEqual({
      t: 'hello',
      v: PROTOCOL_VERSION,
      code: 'ABCDEF',
      name: 'Ada',
    });
    last().recv(welcome('secret'));
    expect(token).toBe('secret');
    expect(s.status).toBe('open');
    expect(s.isWelcomed).toBe(true);
  });

  it('sends hello with the stored token', () => {
    token = 'stored';
    const s = makeSocket('Ignored');
    s.connect();
    last().open();
    expect(last().sent[0]).toEqual({
      t: 'hello',
      v: PROTOCOL_VERSION,
      code: 'ABCDEF',
      token: 'stored',
    });
  });

  it('drops sends before welcome', () => {
    const s = makeSocket('Ada');
    s.connect();
    last().open();
    expect(s.send({ t: 'setReady', ready: true })).toBe(false);
    last().recv(welcome());
    expect(s.send({ t: 'setReady', ready: true })).toBe(true);
    expect(last().ofType('setReady')).toHaveLength(1);
  });

  it('emits typed messages to listeners', () => {
    const s = makeSocket('Ada');
    const states: RoomSnapshot[] = [];
    s.on('state', (m) => states.push(m.state));
    s.connect();
    last().open();
    last().recv(welcome());
    last().recv({ t: 'state', state: { rev: 3 } as RoomSnapshot, serverNow: 1 });
    expect(states.map((x) => x.rev)).toEqual([3]);
  });
});

describe('RoomSocket reconnect', () => {
  it('backs off 0.5 → 1 → 2 → 4 → 5 s (capped)', () => {
    expect([0, 1, 2, 3, 4, 5, 10].map(backoffDelay)).toEqual([
      500, 1000, 2000, 4000, 5000, 5000, 5000,
    ]);
  });

  it('reconnects with backoff and reuses the token from welcome', () => {
    const s = makeSocket('Ada');
    s.connect();
    last().open();
    last().recv(welcome('tok-A'));
    last().drop();
    expect(s.status).toBe('reconnecting');
    expect(FakeWs.all).toHaveLength(1);
    vi.advanceTimersByTime(499);
    expect(FakeWs.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWs.all).toHaveLength(2);
    // second attempt fails before open → next delay is 1 s
    last().drop();
    vi.advanceTimersByTime(999);
    expect(FakeWs.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWs.all).toHaveLength(3);
    last().open();
    expect(last().sent[0]).toEqual({
      t: 'hello',
      v: PROTOCOL_VERSION,
      code: 'ABCDEF',
      token: 'tok-A',
    });
    last().recv(welcome('tok-A'));
    expect(s.status).toBe('open');
    // welcome resets the backoff
    last().drop();
    vi.advanceTimersByTime(500);
    expect(FakeWs.all).toHaveLength(4);
  });

  it('re-sends sticky messages after every welcome', () => {
    const s = makeSocket('Ada');
    s.setSticky('mic', { t: 'micStatus', ok: true });
    s.connect();
    last().open();
    last().recv(welcome());
    expect(last().ofType('micStatus')).toEqual([{ t: 'micStatus', ok: true }]);
    last().drop();
    vi.advanceTimersByTime(500);
    last().open();
    last().recv(welcome());
    expect(last().ofType('micStatus')).toHaveLength(1);
  });

  it('stops for good on a fatal error', () => {
    const s = makeSocket('Ada');
    const statuses: string[] = [];
    s.onStatus((st, fatal) => statuses.push(`${st}:${fatal?.code ?? ''}`));
    s.connect();
    last().open();
    last().recv({ t: 'error', code: 'ROOM_NOT_FOUND', message: 'nope', fatal: true });
    expect(s.status).toBe('closed');
    expect(s.fatal?.code).toBe('ROOM_NOT_FOUND');
    expect(statuses.at(-1)).toBe('closed:ROOM_NOT_FOUND');
    vi.advanceTimersByTime(60_000);
    expect(FakeWs.all).toHaveLength(1);
  });

  it('treats join errors before welcome as fatal even without the flag', () => {
    const s = makeSocket('Ada');
    s.connect();
    last().open();
    last().recv({ t: 'error', code: 'GAME_IN_PROGRESS', message: 'x' });
    expect(s.fatal?.code).toBe('GAME_IN_PROGRESS');
  });

  it('keeps going on non-fatal errors', () => {
    const s = makeSocket('Ada');
    const errors: string[] = [];
    s.on('error', (m) => errors.push(m.code));
    s.connect();
    last().open();
    last().recv(welcome());
    last().recv({ t: 'error', code: 'NOT_HOST', message: 'x' });
    expect(errors).toEqual(['NOT_HOST']);
    expect(s.status).toBe('open');
  });

  it('stops on kicked', () => {
    const s = makeSocket('Ada');
    s.connect();
    last().open();
    last().recv(welcome());
    last().recv({ t: 'kicked' });
    expect(s.fatal?.code).toBe('KICKED');
    expect(last().closed).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(FakeWs.all).toHaveLength(1);
  });

  it('close() does not reconnect', () => {
    const s = makeSocket('Ada');
    s.connect();
    last().open();
    last().recv(welcome());
    s.close(true);
    expect(last().ofType('leave')).toHaveLength(1);
    expect(s.status).toBe('closed');
    vi.advanceTimersByTime(10_000);
    expect(FakeWs.all).toHaveLength(1);
  });
});

describe('RoomSocket clock sync', () => {
  function connected() {
    const s = makeSocket('Ada');
    s.connect();
    last().open();
    clock = 100;
    last().recv(welcome('t', 1_000_000));
    return s;
  }

  it('uses serverNow as a coarse offset before any pong', () => {
    const s = connected();
    expect(s.clockOffsetMs).toBe(1_000_000 - 100);
  });

  it('sends a burst of pings on connect, then one every 10 s', () => {
    connected();
    vi.advanceTimersByTime(PING_BURST_SPACING_MS * (PING_BURST - 1));
    expect(last().ofType('ping')).toHaveLength(PING_BURST);
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(last().ofType('ping')).toHaveLength(PING_BURST + 1);
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(last().ofType('ping')).toHaveLength(PING_BURST + 2);
  });

  it('picks the min-RTT pong and maps server time to performance time', () => {
    const s = connected();
    // RTT 80 ms: offset = 5080 - (1000 + 1080)/2 = 4040
    clock = 1080;
    last().recv({ t: 'pong', c: 1000, s: 5080 });
    expect(s.clockOffsetMs).toBe(4040);
    // RTT 20 ms (better): offset = 5110 - (1100 + 1120)/2 = 4000
    clock = 1120;
    last().recv({ t: 'pong', c: 1100, s: 5110 });
    expect(s.clockOffsetMs).toBe(4000);
    expect(s.rttMs).toBe(20);
    // worse sample does not override
    clock = 1500;
    last().recv({ t: 'pong', c: 1300, s: 9999 });
    expect(s.clockOffsetMs).toBe(4000);
    expect(s.serverToPerf(10_000)).toBe(6000);
    expect(s.perfToServer(6000)).toBe(10_000);
    clock = 2000;
    expect(s.serverNow()).toBe(6000);
    // a later state.serverNow must not clobber the precise estimate
    last().recv({ t: 'state', state: { rev: 1 } as RoomSnapshot, serverNow: 123 });
    expect(s.clockOffsetMs).toBe(4000);
  });

  it('stops pinging when disconnected', () => {
    connected();
    last().drop();
    const ws = FakeWs.all[0]!;
    const n = ws.sent.length;
    vi.advanceTimersByTime(400); // before the reconnect timer
    expect(ws.sent.length).toBe(n);
  });
});

describe('normalizeRoomCode', () => {
  it('accepts codes, lowercase, separators and invite URLs', () => {
    expect(normalizeRoomCode('abcdef')).toBe('ABCDEF');
    expect(normalizeRoomCode(' AB-CD EF ')).toBe('ABCDEF');
    expect(normalizeRoomCode('https://dub.borbus.eu/r/XYZ234')).toBe('XYZ234');
    expect(normalizeRoomCode('https://dub.borbus.eu/r/XYZ234?x=1')).toBe('XYZ234');
  });
  it('rejects bad codes', () => {
    expect(normalizeRoomCode('ABC')).toBeNull();
    expect(normalizeRoomCode('ABCDE0')).toBeNull(); // 0 not in alphabet
    expect(normalizeRoomCode('ABCDEFG')).toBeNull();
  });
});

describe('session (store wiring)', () => {
  it('reuses the socket across release+join (StrictMode) and fills the store', async () => {
    const { joinRoom, releaseRoom, leaveRoom, onServerMessage } =
      await import('../src/state/session');
    const { useRoomStore } = await import('../src/state/room');
    const deps = {
      createSocket: (url: string) => new FakeWs(url),
      now: () => clock,
    };
    const a = joinRoom('ABCDEF', { name: 'Ada', url: 'ws://t/ws', deps });
    releaseRoom();
    const b = joinRoom('ABCDEF', { name: 'Ada', url: 'ws://t/ws', deps });
    expect(b).toBe(a);
    vi.advanceTimersByTime(10);
    expect(FakeWs.all).toHaveLength(1);
    const rtc: string[] = [];
    const off = onServerMessage('rtc', (m) => rtc.push(m.from));
    last().open();
    last().recv(welcome());
    last().recv({
      t: 'state',
      state: { rev: 2, code: 'ABCDEF', phase: 'LOBBY' } as RoomSnapshot,
      serverNow: 1,
    });
    last().recv({
      t: 'state',
      state: { rev: 1, code: 'ABCDEF', phase: 'DUBBING' } as RoomSnapshot,
      serverNow: 1,
    });
    last().recv({ t: 'rtc', from: 'p2', data: { kind: 'candidate', candidate: null } });
    const st = useRoomStore.getState();
    expect(st.status).toBe('open');
    expect(st.playerId).toBe('p1');
    expect(st.snapshot?.rev).toBe(2); // stale rev ignored
    expect(rtc).toEqual(['p2']);
    off();
    leaveRoom();
    expect(last().ofType('leave')).toHaveLength(1);
    expect(useRoomStore.getState().code).toBeNull();
  });
});
