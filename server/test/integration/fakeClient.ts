import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import {
  PLAYER_TOKEN_HEADER,
  PROTOCOL_VERSION,
  paths,
  type C2S,
  type ChunkMeta,
  type RoomSnapshot,
  type S2C,
} from '@dub/shared';
import { tmpDir } from '../helpers.js';

type Welcome = Extract<S2C, { t: 'welcome' }>;

/**
 * Scripted game client over a real WebSocket + fetch: what a browser tab does, minus media.
 */
export class FakeClient {
  ws: WebSocket | null = null;
  received: S2C[] = [];
  token: string | undefined;
  playerId = '';
  private waiters: { pred: (m: S2C) => boolean; resolve: (m: S2C) => void }[] = [];

  constructor(
    readonly baseUrl: string,
    readonly code: string,
    readonly name: string,
    token?: string,
  ) {
    this.token = token;
  }

  /** Opens the socket and completes `hello` (by token if known, else by name). */
  async connect(): Promise<Welcome> {
    const ws = new WebSocket(this.baseUrl.replace(/^http/, 'ws') + '/ws');
    this.ws = ws;
    ws.on('message', (d) => this.onMessage(JSON.parse(d.toString()) as S2C));
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
    });
    const since = this.received.length;
    this.send({
      t: 'hello',
      v: PROTOCOL_VERSION,
      code: this.code,
      token: this.token,
      name: this.name,
    });
    const w = await this.wait(
      (m) => m.t === 'welcome' || (m.t === 'error' && !!m.fatal),
      5000,
      since,
    );
    if (w.t !== 'welcome') throw new Error(`hello failed: ${JSON.stringify(w)}`);
    this.token = w.token;
    this.playerId = w.playerId;
    return w;
  }

  /** Drops the socket without `leave` (like a closed tab / network loss). */
  async drop(): Promise<void> {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    await new Promise<void>((res) => {
      ws.once('close', () => res());
      ws.terminate();
    });
  }

  send(m: C2S): void {
    this.ws!.send(JSON.stringify(m));
  }

  private onMessage(m: S2C): void {
    this.received.push(m);
    this.waiters = this.waiters.filter((w) => {
      if (!w.pred(m)) return true;
      w.resolve(m);
      return false;
    });
  }

  errors(): Extract<S2C, { t: 'error' }>[] {
    return this.received.filter((m): m is Extract<S2C, { t: 'error' }> => m.t === 'error');
  }

  wait(pred: (m: S2C) => boolean, timeoutMs = 5000, since = 0): Promise<S2C> {
    const hit = this.received.slice(since).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const last = this.lastState();
        reject(
          new Error(
            `${this.name}: timeout; last phase ${last?.phase} showcase ${JSON.stringify(last?.showcase?.status)}; errors ${JSON.stringify(this.errors())}`,
          ),
        );
      }, timeoutMs);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m);
        },
      });
    });
  }

  lastState(): RoomSnapshot | undefined {
    for (let i = this.received.length - 1; i >= 0; i--) {
      const m = this.received[i]!;
      if (m.t === 'state') return m.state;
    }
    return undefined;
  }

  /** Latest snapshot if it matches, else the next one that does. */
  async state(pred: (s: RoomSnapshot) => boolean, timeoutMs = 5000): Promise<RoomSnapshot> {
    const last = this.lastState();
    if (last && pred(last)) return last;
    const m = await this.wait(
      (x) => x.t === 'state' && pred(x.state),
      timeoutMs,
      this.received.length,
    );
    return (m as Extract<S2C, { t: 'state' }>).state;
  }

  async upload(
    round: number,
    chunkId: string,
    bytes: Buffer,
    mime = 'audio/webm;codecs=opus',
  ): Promise<Response> {
    return fetch(this.baseUrl + paths.chunkUpload(this.code, round, chunkId), {
      method: 'POST',
      headers: { 'Content-Type': mime, [PLAYER_TOKEN_HEADER]: this.token! },
      body: new Uint8Array(bytes),
    });
  }

  async download(url: string): Promise<Response> {
    return fetch(this.baseUrl + url, { headers: { [PLAYER_TOKEN_HEADER]: this.token! } });
  }
}

export function chunkMeta(id: string, startMs: number, bytes: number): ChunkMeta {
  return { id, startMs, offsetMs: 10, durationMs: 400, mime: 'audio/webm;codecs=opus', bytes };
}

/**
 * Fixture clips dir with `n` short clips. Uses ffmpeg (1 s testsrc + sine) when available,
 * otherwise dummy bytes; the server never decodes clips.
 */
export function makeFixtureClips(n = 3, durationMs = 1000): string {
  const dir = tmpDir('dub-fixture-clips-');
  let real = true;
  const clips = Array.from({ length: n }, (_, i) => {
    const file = `fixture-${i}.mp4`;
    const out = path.join(dir, file);
    if (real) {
      try {
        execFileSync(
          'ffmpeg',
          [
            '-v',
            'error',
            '-y',
            '-f',
            'lavfi',
            '-i',
            `testsrc2=size=320x180:rate=15:duration=${durationMs / 1000}`,
            '-f',
            'lavfi',
            '-i',
            `sine=frequency=${440 + i * 110}:duration=${durationMs / 1000}`,
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            '-c:a',
            'aac',
            '-shortest',
            out,
          ],
          { stdio: 'ignore', timeout: 15_000 },
        );
      } catch {
        real = false;
      }
    }
    if (!fs.existsSync(out)) fs.writeFileSync(out, Buffer.alloc(2048, i));
    return {
      id: `fixture-${i}`,
      title: `Fixture ${i}`,
      file,
      durationMs,
      width: 320,
      height: 180,
      tags: ['test'],
      attribution: { author: 'Voicejack tests', source: 'ffmpeg lavfi', license: 'CC0' },
    };
  });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ clips }, null, 2));
  return dir;
}
