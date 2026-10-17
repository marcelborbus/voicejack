import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AddFromRoomBodySchema,
  InviteBodySchema,
  ReportBodySchema,
  RequestActionBodySchema,
  RoomCodeSchema,
  SendMessageBodySchema,
  friendRoutes,
  type AddFromRoomResponse,
  type FriendsResponse,
  type MessagesResponse,
  type RoomRelationsResponse,
  type SendMessageResponse,
} from '@dub/shared';
import { sendError, type AppDeps } from '../http/app.js';
import { readCookie, SESSION_COOKIE } from '../accounts/cookies.js';
import { FriendsError } from '../friends/Friends.js';

class BadRequest extends Error {}
/** `schema.safeParse(v).data`, or a 400. */
function parse<T>(
  schema: { safeParse(v: unknown): { success: boolean; data?: T } },
  v: unknown,
): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new BadRequest();
  return r.data as T;
}
function idParam(v: unknown): string {
  if (typeof v !== 'string' || !/^[\w-]{1,64}$/.test(v)) throw new BadRequest();
  return v;
}
function beforeParam(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new BadRequest();
  return n;
}
const LIMIT = { max: 120, timeWindow: 60_000 };

/**
 * V10 `/api/friends/*` (registered users only; shapes in `shared/src/protocol/friends.ts`).
 * App-level limits (30 requests/day, 20 DMs/min, 10 invites/min) live in `Friends`.
 */
export function register(app: FastifyInstance, deps: AppDeps): void {
  const { accounts, friends } = deps;
  if (!accounts || !friends) return;

  type Handler = (me: string, req: FastifyRequest) => unknown;
  const handle =
    (fn: Handler) =>
    async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      reply.header('Cache-Control', 'no-store');
      const s = accounts.session(readCookie(req.headers.cookie, SESSION_COOKIE));
      if (!s) return reply.status(401).send(sendError('BAD_TOKEN', 'no session'));
      if (s.user.kind !== 'registered') {
        return reply.status(403).send(sendError('INVALID', 'sign in to use friends'));
      }
      try {
        return (await fn(s.user.id, req)) ?? { ok: true };
      } catch (e) {
        if (e instanceof FriendsError)
          return reply.status(e.status).send(sendError(e.code, e.message));
        if (e instanceof BadRequest)
          return reply.status(400).send(sendError('INVALID', 'bad request'));
        throw e;
      }
    };
  const opts = { config: { rateLimit: LIMIT } };
  const userId = (req: FastifyRequest) => idParam((req.params as { userId?: unknown }).userId);
  const ref = (req: FastifyRequest) => idParam((req.params as { ref?: unknown }).ref);

  app.get(
    friendRoutes.friends,
    opts,
    handle((me): FriendsResponse => friends.list(me)),
  );

  app.get(
    friendRoutes.room,
    opts,
    handle((me, req): RoomRelationsResponse => {
      const code = parse<string>(RoomCodeSchema, (req.params as { code?: unknown }).code);
      return { players: friends.roomRelations(me, code) };
    }),
  );

  app.post(
    friendRoutes.fromRoom,
    opts,
    handle((me, req): AddFromRoomResponse => {
      const b = parse(AddFromRoomBodySchema, req.body);
      return { result: friends.addFromRoom(me, b.code, b.playerId) };
    }),
  );

  app.post(
    friendRoutes.request,
    opts,
    handle((me, req) => {
      friends.requestAction(me, ref(req), parse(RequestActionBodySchema, req.body).action);
    }),
  );

  app.delete(
    friendRoutes.block,
    opts,
    handle((me, req) => friends.unblock(me, ref(req))),
  );
  app.delete(
    friendRoutes.friend,
    opts,
    handle((me, req) => friends.remove(me, userId(req))),
  );
  app.post(
    friendRoutes.blockFriend,
    opts,
    handle((me, req) => friends.blockFriend(me, userId(req))),
  );

  app.get(
    friendRoutes.messages,
    opts,
    handle((me, req): MessagesResponse => {
      const before = beforeParam((req.query as { before?: unknown }).before);
      return friends.messages(me, userId(req), before);
    }),
  );
  app.post(
    friendRoutes.messages,
    opts,
    handle((me, req): SendMessageResponse => {
      const { body } = parse(SendMessageBodySchema, req.body);
      return { message: friends.sendDm(me, userId(req), body) };
    }),
  );
  app.post(
    friendRoutes.read,
    opts,
    handle((me, req) => void friends.markRead(me, userId(req))),
  );
  app.post(
    friendRoutes.invite,
    opts,
    handle((me, req) => friends.invite(me, userId(req), parse(InviteBodySchema, req.body).code)),
  );
  app.post(
    friendRoutes.report,
    { config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
    handle((me, req) => {
      const b = parse(ReportBodySchema, req.body);
      friends.report(me, userId(req), b.reason, b.messageId);
      req.log.info({ reporter: me }, 'dm report filed');
    }),
  );
}
