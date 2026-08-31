import { randomInt } from 'node:crypto';

export interface RandomSource {
  /** Returns an integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
}

export const cryptoRandom: RandomSource = {
  int: (maxExclusive: number) => randomInt(maxExclusive),
};

/**
 * Deterministic mulberry32 PRNG. Used by tests and by seeded games so a round
 * can be replayed exactly for dispute resolution.
 */
export function seededRandom(seed: number): RandomSource {
  let a = seed >>> 0;
  return {
    int(maxExclusive: number): number {
      a += 0x6d2b79f5;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      const unit = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      return Math.floor(unit * maxExclusive);
    },
  };
}

export function shuffle<T>(items: readonly T[], rng: RandomSource = cryptoRandom): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = rng.int(i + 1);
    const tmp = arr[i] as T;
    arr[i] = arr[j] as T;
    arr[j] = tmp;
  }
  return arr;
}
