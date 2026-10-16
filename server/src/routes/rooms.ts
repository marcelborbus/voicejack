import type { FastifyInstance } from 'fastify';
import {
  CreateRoomBodySchema,
  ROOM_CODE_REGEX,
  routes,
  type CreateRoomResponse,
  type RoomInfoResponse,
} from '@dub/shared';
import { sendError, type AppDeps } from '../http/app.js';
import { RATE_LIMITS } from '../security/rateLimit.js';

export function register(app: FastifyInstance, deps: AppDeps): void {
  const rooms = deps.rooms;
  if (!rooms) return;

  app.post(routes.rooms, { config: { rateLimit: RATE_LIMITS.createRoom } }, async (req, reply) => {
    const body = CreateRoomBodySchema.safeParse(req.body);
    if (!body.success)
      return reply.status(400).send(sendError('INVALID', 'name must be 1-20 characters'));
    const r = rooms.create(body.data.name);
    if ('code' in r && 'message' in r) return reply.status(503).send(sendError(r.code, r.message));
    const res: CreateRoomResponse = {
      code: r.room.code,
      playerId: r.join.playerId,
      token: r.join.token,
    };
    return reply.status(201).send(res);
  });

  app.get<{ Params: { code: string } }>(
    routes.room,
    { config: { rateLimit: RATE_LIMITS.roomInfo } },
    async (req, reply) => {
      const code = req.params.code.toUpperCase();
      const room = ROOM_CODE_REGEX.test(code) ? rooms.get(code) : undefined;
      if (!room) return reply.status(404).send(sendError('ROOM_NOT_FOUND', 'no such room'));
      const info: RoomInfoResponse = room.info();
      return info;
    },
  );
}
