import type { PresenceS2C } from '@dub/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backoffDelay, type WebSocketLike } from '../src/net/socket';
import { HIDDEN_PAUSE_MS, PresenceSocket } from '../src/net/presence';

class FakeWs implements WebSocketLike {
  static all: FakeWs[] = [];
  readyState = 0;
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(readonly url: string) {
    FakeWs.all.push(this);
  }
  send() {}
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  recv(msg: PresenceS2C) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: '' });
  }
}

class FakeDoc {
  hidden = false;
  private fns = new Set<() => void>();
  addEventListener(_: string, fn: () => void) {
    this.fns.add(fn);
  }
  removeEventListener(_: string, fn: () => void) {
    this.fns.delete(fn);
  }
  set(hidden: boolean) {
    this.hidden = hidden;
    for (const fn of this.fns) fn();
  }
}

const last = () => FakeWs.all.at(-1)!;

function make(doc = new FakeDoc()) {
  const fetchStats = vi.fn(async () => ({ online: 7, inGame: 2, rooms: 1 }));
  const p = new PresenceSocket({
    createSocket: (url) => new FakeWs(url),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
    ready: () => Promise.resolve(),
    fetchStats,
    doc: doc as unknown as Document,
    url: () => 'ws://x/ws/presence',
  });
  return { p, doc, fetchStats };
}

describe('PresenceSocket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWs.all = [];
  });
  afterEach(() => vi.useRealTimers());

  it('connects after the profile is ready and exposes counts', async () => {
    const { p } = make();
    const seen = vi.fn();
    p.subscribeCounts(seen);
    p.start();
    p.start(); // idempotent
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWs.all).toHaveLength(1);
    last().open();
    last().recv({ t: 'counts', online: 3, inGame: 1, lookingForGame: 0 });
    expect(p.counts).toEqual({ online: 3, inGame: 1, lookingForGame: 0 });
    expect(seen).toHaveBeenCalledTimes(1);
    p.stop();
  });

  it('reconnects with backoff and falls back to /api/stats before the first push', async () => {
    const { p, fetchStats } = make();
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    last().drop();
    expect(p.status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchStats).toHaveBeenCalledTimes(1);
    expect(p.counts).toEqual({ online: 7, inGame: 2, lookingForGame: 0 });
    await vi.advanceTimersByTimeAsync(backoffDelay(0) - 1);
    expect(FakeWs.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWs.all).toHaveLength(2);
    last().drop();
    await vi.advanceTimersByTimeAsync(backoffDelay(1));
    expect(FakeWs.all).toHaveLength(3);
    expect(fetchStats).toHaveBeenCalledTimes(1);
    p.stop();
  });

  it('pauses after the tab is hidden for 5 minutes and resumes when visible', async () => {
    const { p, doc } = make();
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    last().open();
    doc.set(true);
    await vi.advanceTimersByTimeAsync(HIDDEN_PAUSE_MS - 1);
    expect(last().closed).toBe(false);
    doc.set(false); // short absence: nothing happens
    doc.set(true);
    await vi.advanceTimersByTimeAsync(HIDDEN_PAUSE_MS);
    expect(last().closed).toBe(true);
    expect(p.status).toBe('paused');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWs.all).toHaveLength(1); // no reconnect while paused
    doc.set(false);
    expect(FakeWs.all).toHaveLength(2);
    p.stop();
  });
});
