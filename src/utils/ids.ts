import { randomBytes, randomInt } from 'node:crypto';

/** Ambiguous glyphs (0/O, 1/I/L) removed so codes survive being read aloud. */
const ROOM_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** Every room code is exactly this long; validation depends on it. */
export const ROOM_CODE_LENGTH = 6;

export function generateRoomCode(length = ROOM_CODE_LENGTH): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)];
  }
  return out;
}

/** True if `value` could be a room code. Case-insensitive, spaces ignored. */
export function looksLikeRoomCode(value: string): boolean {
  const cleaned = value.replace(/\s+/g, '').toUpperCase();
  if (cleaned.length !== ROOM_CODE_LENGTH) return false;
  return [...cleaned].every((ch) => ROOM_ALPHABET.includes(ch));
}

export function generateToken(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}
