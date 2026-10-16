import WebSocket from 'ws';
import type { C2S, RoomSnapshot, S2C } from '@dub/shared';

/** Minimal test WS client: buffers messages and lets tests await specific ones. */
export class TestSocket {
  readonly ws: WebSocket;
  readonly received: S2C[] = [];
  private waiters: { pred: (m: S2C) => boolean; resolve: (m: S2C) => void }[] = [];
  readonly opened: Promise<void>;
  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(url: string, headers: Record<string, string> = {}) {
    this.ws = new WebSocket(url, { headers });
    this.opened = new Promise((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
      this.ws.once('unexpected-response', (_req, r) => rej(new Error(`HTTP ${r.statusCode}`)));
    });
    this.closed = new Promise((res) =>
      this.ws.once('close', (code, reason) => res({ code, reason: reason.toString() })),
    );
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as S2C;
      this.received.push(m);
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(m)) {
          w.resolve(m);
          return false;
        }
        return true;
      });
    });
  }

  send(m: C2S | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(m));
  }

  /** Resolves with the first message (already received after `since`, or future) matching `pred`. */
  wait<T extends S2C = S2C>(pred: (m: S2C) => boolean, timeoutMs = 3000, since = 0): Promise<T> {
    const hit = this.received.slice(since).find(pred);
    if (hit) return Promise.resolve(hit as T);
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`timeout waiting; got ${JSON.stringify(this.received.slice(-3))}`)),
        timeoutMs,
      );
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m as T);
        },
      });
    });
  }

  /** Next state snapshot satisfying `pred` (checks the latest received one first). */
  async state(
    pred: (s: RoomSnapshot) => boolean = () => true,
    timeoutMs = 3000,
  ): Promise<RoomSnapshot> {
    const last = this.lastState();
    if (last && pred(last)) return last;
    const m = await this.wait(
      (x) => x.t === 'state' && pred(x.state),
      timeoutMs,
      this.received.length,
    );
    return (m as Extract<S2C, { t: 'state' }>).state;
  }

  lastState(): RoomSnapshot | undefined {
    for (let i = this.received.length - 1; i >= 0; i--) {
      const m = this.received[i]!;
      if (m.t === 'state') return m.state;
    }
    return undefined;
  }

  close(): void {
    this.ws.close();
  }
}
