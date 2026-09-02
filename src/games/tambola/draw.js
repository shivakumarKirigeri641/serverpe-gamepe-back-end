/**
 * The draw sequence.
 *
 * All 90 numbers are shuffled ONCE when a game is created and stored on the
 * game row. Each tick just advances a cursor - nothing is random at draw time.
 * Two things fall out of that: a disputed game can be replayed exactly, and a
 * duplicated or delayed tick can never produce a number out of order, because
 * position N of the sequence is fixed the moment the game exists.
 *
 * Pure module: no database, no clock.
 */
import { makeRng, shuffle } from '../../utils/random.js';

export const TOTAL_NUMBERS = 90;

/** The shuffled order of 1..90 for one game. */
export function createSequence(seed) {
  const all = Array.from({ length: TOTAL_NUMBERS }, (_, i) => i + 1);
  return shuffle(all, makeRng(seed));
}

/**
 * The draw at a given cursor position.
 *
 * @param {number[]} sequence
 * @param {number} cursor  how many numbers have already been revealed
 * @returns {{ value: number|null, seq: number, finished: boolean }}
 *          seq is 1-based: the first number drawn is seq 1.
 */
export function drawAt(sequence, cursor) {
  if (cursor >= sequence.length) {
    return { value: null, seq: cursor, finished: true };
  }
  const value = sequence[cursor];
  const seq = cursor + 1;
  return { value, seq, finished: seq >= sequence.length };
}

/** Everything revealed so far, in call order. */
export function drawnSoFar(sequence, cursor) {
  return sequence.slice(0, cursor);
}

/** Verifies a stored sequence has not been tampered with or truncated. */
export function isValidSequence(sequence) {
  if (!Array.isArray(sequence) || sequence.length !== TOTAL_NUMBERS) return false;
  const seen = new Set(sequence);
  if (seen.size !== TOTAL_NUMBERS) return false;
  for (let n = 1; n <= TOTAL_NUMBERS; n++) if (!seen.has(n)) return false;
  return true;
}
