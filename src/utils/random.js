/**
 * Randomness with an optional seed.
 *
 * Every game stores the seed it was created with, so any disputed round can be
 * regenerated number-for-number and ticket-for-ticket. That is also what makes
 * the tests in src/temp deterministic.
 */
import { randomInt as cryptoRandomInt } from 'node:crypto';

/** Deterministic PRNG (mulberry32). Fast, tiny, good enough for a game. */
export function makeRng(seed) {
  if (seed === undefined || seed === null) {
    return () => cryptoRandomInt(0, 2 ** 31) / 2 ** 31;
  }
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random integer in [min, max] inclusive. */
export function randomInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Fisher-Yates. Returns a new array; never mutates the input. */
export function shuffle(items, rng) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A fresh seed for a new game. */
export function newSeed() {
  return cryptoRandomInt(0, 2 ** 31 - 1);
}
