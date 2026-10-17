import type { ErrorCode } from '@dub/shared';

/** Human copy for server error codes. */
export const ERROR_TEXT: Record<
  ErrorCode | 'KICKED' | 'VOTE_KICKED' | 'REQUEUED' | 'NETWORK',
  string
> = {
  ROOM_NOT_FOUND: "That room doesn't exist (or the party is over).",
  ROOM_FULL: 'That room is full.',
  GAME_IN_PROGRESS: 'That game has already started. Ask for the next round!',
  BAD_TOKEN: 'Your seat in this room expired. Join again with your name.',
  VERSION: 'Voicejack was updated. Reload the page to continue.',
  NOT_HOST: 'Only the host can do that.',
  BAD_PHASE: "That's not possible right now.",
  INVALID: 'The server did not accept that.',
  RATE_LIMITED: 'Slow down a little!',
  START_BLOCKED: "The game can't start yet.",
  SELF_VOTE: "You can't vote on your own dub.",
  LIMIT: 'Limit reached.',
  KICKED: 'The host removed you from the room.',
  VOTE_KICKED: 'The other players voted you out of this game.',
  REQUEUED: 'You missed the ready check and are back in the queue.',
  NETWORK: 'Could not reach the server. Check your connection.',
};

export function errorText(code: string, fallback?: string): string {
  return (ERROR_TEXT as Record<string, string>)[code] ?? fallback ?? 'Something went wrong.';
}
