import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import {
  LIMITS,
  PROTOCOL_VERSION,
  RTC_MAX_BYTES,
  WS_MAX_MESSAGE_BYTES,
  WS_PATH,
  parseC2S,
  type C2SOf,
  type ErrorCode,
  type PlayerId,
  type S2C,
} from '@dub/shared';
import type { AppDeps } from '../http/app.js';
import type { Connection, RoomManager } from '../room/RoomManager.js';
import type { Room } from '../room/Room.js';
import { TokenBucket, WS_RATE } from '../security/rateLimit.js';

/** Close if no `hello` arrives in time; ws-level heartbeat to detect dead peers. */
export const HELLO_TIMEOUT_MS = 10_000;
export const HEARTBEAT_MS = 25_000;

/** Same-host check. Requests without Origin (non-browser clients) are allowed. */
export function originAllowed(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const fwd = req.headers['x-forwarded-host'];
  const candidates = [req.headers.host, ...(Array.isArray(fwd) ? fwd : fwd ? [fwd] : [])];
  return candidates.some((h) => h !== undefined && h.split(',')[0]!.trim() === host);
}

export function register(app: FastifyInstance, deps: AppDeps): void {
  const rooms = deps.rooms;
  if (!rooms) return;
  app.get(
    WS_PATH,
    {
      websocket: true,
      preValidation: async (req, reply) => {
        if (!originAllowed(req)) {
          await reply.status(403).send({ error: 'INVALID', message: 'bad origin' });
        }
      },
    },
    (socket, req) => {
      // The session cookie rides on the upgrade request; resolved once per socket.
      const userId = deps.accounts?.userIdFromCookie(req.headers.cookie) ?? null;
      new Session(socket, rooms, deps, req.log, userId);
    },
  );
}

class Session implements Connection {
  private room: Room | null = null;
  private playerId: PlayerId | null = null;
  private readonly bucket = new TokenBucket(WS_RATE.perSec, WS_RATE.burst);
  private helloTimer: ReturnType<typeof setTimeout> | null;
  private heartbeat: ReturnType<typeof setInterval>;
  private alive = true;
  private closed = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly rooms: RoomManager,
    private readonly deps: AppDeps,
    private readonly log: FastifyInstance['log'],
    /** Account behind the upgrade's `vj_session` cookie (never sent to other players). */
    private readonly userId: string | null = null,
  ) {
    this.helloTimer = setTimeout(() => this.close(4008, 'hello timeout'), HELLO_TIMEOUT_MS);
    this.heartbeat = setInterval(() => {
      if (!this.alive) {
        ws.terminate();
        return;
      }
      this.alive = false;
      ws.ping();
    }, HEARTBEAT_MS);
    ws.on('pong', () => (this.alive = true));
    ws.on('message', (data, isBinary) => this.onMessage(data as Buffer, isBinary));
    ws.on('close', () => this.onClose());
    ws.on('error', (e) => this.log.debug({ err: e }, 'ws error'));
  }

  send(msg: S2C): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    this.ws.close(code, reason);
  }

  private error(code: ErrorCode, message: string, fatal = false): void {
    this.send(fatal ? { t: 'error', code, message, fatal } : { t: 'error', code, message });
    if (fatal) this.close(4000 + 100, code);
  }

  private onMessage(data: Buffer, isBinary: boolean): void {
    if (this.closed) return;
    if (!this.bucket.take()) {
      this.send({ t: 'error', code: 'RATE_LIMITED', message: 'too many messages' });
      this.close(1008, 'rate limited');
      return;
    }
    if (isBinary || data.length > WS_MAX_MESSAGE_BYTES) {
      this.error('INVALID', 'expected a JSON text frame');
      return;
    }
    const msg = parseC2S(data.toString('utf8'));
    if (!msg) {
      this.error('INVALID', 'malformed message');
      return;
    }
    switch (msg.t) {
      case 'hello':
        this.hello(msg);
        return;
      case 'ping':
        this.send({ t: 'pong', c: msg.c, s: Date.now() });
        return;
    }
    if (!this.room || !this.playerId) {
      this.error('INVALID', 'send hello first');
      return;
    }
    if (msg.t === 'rtc') {
      this.relay(msg);
      return;
    }
    if (msg.t === 'leave') {
      const { room, playerId } = this;
      this.rooms.detach(room.code, playerId, this);
      room.leave(playerId);
      this.close(1000, 'left');
      return;
    }
    const e = this.room.handle(this.playerId, msg);
    if (e) this.error(e.code, e.message);
  }

  private hello(msg: C2SOf<'hello'>): void {
    if (this.room) {
      this.error('INVALID', 'already joined');
      return;
    }
    if (msg.v !== PROTOCOL_VERSION) {
      this.error('VERSION', `server speaks protocol v${PROTOCOL_VERSION}, please reload`, true);
      return;
    }
    const room = this.rooms.get(msg.code);
    if (!room) {
      this.error('ROOM_NOT_FOUND', 'no such room', true);
      return;
    }
    let playerId = msg.token ? room.authenticate(msg.token) : null;
    let token = msg.token;
    if (!playerId) {
      if (!msg.name) {
        this.error(
          msg.token ? 'BAD_TOKEN' : 'INVALID',
          msg.token ? 'unknown token' : 'name required',
          true,
        );
        return;
      }
      const j = room.join(msg.name);
      if ('code' in j) {
        this.error(j.code, j.message, true);
        return;
      }
      playerId = j.playerId;
      token = j.token;
    }
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    this.room = room;
    this.playerId = playerId;
    this.rooms.attach(room.code, playerId, this);
    if (this.userId) this.linkUser(room, playerId, msg.name);
    this.send({
      t: 'welcome',
      v: PROTOCOL_VERSION,
      playerId,
      token: token!,
      serverNow: Date.now(),
      iceServers: this.deps.config.iceServers,
      limits: { ...LIMITS },
    });
    room.connect(playerId);
  }

  /** Links the room player to the cookie's account and remembers the name for next visit. */
  private linkUser(room: Room, playerId: PlayerId, helloName: string | undefined): void {
    const name = room.linkUser(playerId, this.userId!);
    const display = helloName?.trim() || name;
    if (!display) return;
    try {
      this.deps.accounts?.setDisplayName(this.userId!, display);
    } catch (e) {
      this.log.warn({ err: e }, 'saving display name failed');
    }
  }

  private relay(msg: C2SOf<'rtc'>): void {
    const { room, playerId } = this;
    if (!room || !playerId) return;
    if (msg.to === playerId || !room.hasPlayer(msg.to)) {
      this.error('INVALID', 'unknown peer');
      return;
    }
    const payload: S2C = { t: 'rtc', from: playerId, data: msg.data };
    if (Buffer.byteLength(JSON.stringify(msg.data)) > RTC_MAX_BYTES) {
      this.error('LIMIT', 'signal too large');
      return;
    }
    this.rooms.connection(room.code, msg.to)?.send(payload);
  }

  private onClose(): void {
    this.closed = true;
    if (this.helloTimer) clearTimeout(this.helloTimer);
    clearInterval(this.heartbeat);
    const { room, playerId } = this;
    if (room && playerId && this.rooms.detach(room.code, playerId, this)) {
      room.disconnect(playerId);
    }
  }
}
