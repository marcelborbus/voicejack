import {
  friendPaths,
  type AddFromRoomResponse,
  type ApiError,
  type FriendSearchResponse,
  type FriendSettings,
  type FriendsResponse,
  type MessagesResponse,
  type RequestActionBody,
  type RoomCode,
  type RoomRelationsResponse,
  type SendMessageResponse,
} from '@dub/shared';

/** V10 `/api/friends/*` calls (registered users only). */

export class FriendsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

async function call<T>(url: string, method = 'GET', body?: object): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new FriendsApiError('Could not reach the server.', 0, 'NETWORK');
  }
  if (!r.ok) {
    const e = (await r.json().catch(() => null)) as ApiError | null;
    throw new FriendsApiError(e?.message ?? `HTTP ${r.status}`, r.status, e?.error ?? 'INVALID');
  }
  return (await r.json()) as T;
}

export const friendsApi = {
  list: () => call<FriendsResponse>(friendPaths.friends()),
  roomRelations: (code: RoomCode) => call<RoomRelationsResponse>(friendPaths.room(code)),
  addFromRoom: (code: RoomCode, playerId: string) =>
    call<AddFromRoomResponse>(friendPaths.fromRoom(), 'POST', { code, playerId }),
  search: (q: string) => call<FriendSearchResponse>(friendPaths.search(q)),
  addByRef: (ref: string) => call<AddFromRoomResponse>(friendPaths.add(), 'POST', { ref }),
  settings: () => call<FriendSettings>(friendPaths.settings()),
  setSettings: (body: FriendSettings) =>
    call<FriendSettings>(friendPaths.settings(), 'PATCH', body),
  request: (ref: string, action: RequestActionBody['action']) =>
    call<unknown>(friendPaths.request(ref), 'POST', { action }),
  unblock: (ref: string) => call<unknown>(friendPaths.block(ref), 'DELETE'),
  remove: (userId: string) => call<unknown>(friendPaths.friend(userId), 'DELETE'),
  block: (userId: string) => call<unknown>(friendPaths.blockFriend(userId), 'POST'),
  messages: (userId: string, before?: number) =>
    call<MessagesResponse>(friendPaths.messages(userId, before)),
  send: (userId: string, body: string) =>
    call<SendMessageResponse>(friendPaths.messages(userId), 'POST', { body }),
  read: (userId: string) => call<unknown>(friendPaths.read(userId), 'POST'),
  invite: (userId: string, code: RoomCode) =>
    call<unknown>(friendPaths.invite(userId), 'POST', { code }),
  report: (userId: string, reason: string, messageId?: number) =>
    call<unknown>(friendPaths.report(userId), 'POST', { reason, messageId }),
};
