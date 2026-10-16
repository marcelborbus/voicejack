import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../constants.js';
import type { RoomCode } from '../protocol/common.js';
import { randInt, type Rng } from './rng.js';

/** 6 characters from `ROOM_CODE_ALPHABET` (no 0/O/1/I/L). */
export function generateRoomCode(rng: Rng = Math.random): RoomCode {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[randInt(rng, ROOM_CODE_ALPHABET.length)];
  }
  return code;
}
