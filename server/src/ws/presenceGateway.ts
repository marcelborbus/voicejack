import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import {
  PRESENCE_WS_PATH,
  WS_MAX_MESSAGE_BYTES,
  parsePresenceC2S,
  type PresenceS2C,
} from '@dub/shared';
import type { AppDeps } from '../http/app.js';
import type { Presence, PresenceClient } from '../presence/Presence.js';
import type { Matchmaker } from '../match/Matchmaker.js';
import { TokenBucket, WS_RATE } from '../security/rateLimit.js';
import { HEARTBEAT_MS, originAllowed } from './gateway.js';

/** `/ws/presence` (V07): same Origin check, rate limit and size cap as the room gateway. */
export function register(app: FastifyInstance, deps: AppDeps): void {
  const presence = deps.presence;
  if (!presence) return;
  app.get(
    PRESENCE_WS_PATH,
    {
      websocket: true,
      preValidation: async (req, reply) => {
        if (!originAllowed(req)) {
          await reply.status(403).send({ error: 'INVALID', message: 'bad origin' });
        }
      },
    },
    (socket, req) => {
      const userId = deps.accounts?.userIdFromCookie(req.headers.cookie) ?? null;
      new PresenceSession(socket, presence, req.log, userId, deps.matchmaker ?? null, req.ip);
    },
  );
}

let socketSeq = 0;

class PresenceSession implements PresenceClient {
  /** Queue identity for anonymous sockets (V08). */
  private readonly socketKey = `p${++socketSeq}`;
  private readonly bucket = new TokenBucket(WS_RATE.perSec, WS_RATE.burst);
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private readonly remove: () => void;
  private alive = true;
  private closed = false;

  constructor(
    private readonly ws: WebSocket,
    presence: Presence,
    private readonly log: FastifyInstance['log'],
    readonly userId: string | null,
    private readonly matchmaker: Matchmaker | null = null,
    private readonly ip: string | null = null,
  ) {
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
    ws.on('error', (e) => this.log.debug({ err: e }, 'presence ws error'));
    this.remove = presence.add(this, userId);
    matchmaker?.connect(this);
  }

  send(msg: PresenceS2C): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    this.ws.close(code, reason);
  }

  private onMessage(data: Buffer, isBinary: boolean): void {
    if (this.closed) return;
    if (!this.bucket.take()) {
      this.send({ t: 'error', code: 'RATE_LIMITED', message: 'too many messages' });
      this.close(1008, 'rate limited');
      return;
    }
    if (isBinary || data.length > WS_MAX_MESSAGE_BYTES) {
      this.send({ t: 'error', code: 'INVALID', message: 'expected a JSON text frame' });
      return;
    }
    const msg = parsePresenceC2S(data.toString('utf8'));
    if (!msg) {
      this.send({ t: 'error', code: 'INVALID', message: 'malformed message' });
      return;
    }
    switch (msg.t) {
      case 'ping':
        this.send({ t: 'pong', c: msg.c, s: Date.now() });
        return;
      case 'queueJoin': {
        if (!this.matchmaker) {
          this.send({ t: 'error', code: 'INVALID', message: 'matchmaking is off' });
          return;
        }
        const r = this.matchmaker.join(this, {
          userId: this.userId,
          socketKey: this.socketKey,
          ip: this.ip,
          name: msg.name,
          mode: msg.mode,
        });
        if (!r.ok) this.send({ t: 'error', code: r.code, message: r.message });
        return;
      }
      case 'queueLeave':
        this.matchmaker?.leave(this);
        return;
      // TODO(V10): dm / invite → presence.sendToUser(...)
    }
  }

  private onClose(): void {
    this.closed = true;
    clearInterval(this.heartbeat);
    this.matchmaker?.disconnect(this);
    this.remove();
  }
}
