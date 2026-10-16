import {
  paths,
  type ApiError,
  type CreateRoomResponse,
  type ErrorCode,
  type RoomCode,
  type RoomInfoResponse,
} from '@dub/shared';

export class ApiRequestError extends Error {
  readonly code: ErrorCode | 'NETWORK';
  readonly status: number;
  constructor(code: ErrorCode | 'NETWORK', message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiRequestError('NETWORK', 'Could not reach the server.', 0);
  }
  if (!res.ok) {
    let body: Partial<ApiError> = {};
    try {
      body = (await res.json()) as Partial<ApiError>;
    } catch {
      /* not JSON */
    }
    const code =
      body.error ??
      (res.status === 429 ? 'RATE_LIMITED' : res.status === 404 ? 'ROOM_NOT_FOUND' : 'INVALID');
    throw new ApiRequestError(code, body.message ?? res.statusText, res.status);
  }
  return (await res.json()) as T;
}

export function createRoom(name: string): Promise<CreateRoomResponse> {
  return request<CreateRoomResponse>(paths.rooms(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function getRoomInfo(code: RoomCode): Promise<RoomInfoResponse> {
  return request<RoomInfoResponse>(paths.room(code));
}
