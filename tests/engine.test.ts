import { beforeEach, describe, expect, it } from 'vitest';
import { TambolaEngine, type TambolaConfig } from '../src/games/tambola/engine.js';
import { TAMBOLA_CLAIMS, cornerNumbers } from '../src/games/tambola/patterns.js';
import { generateTicket } from '../src/games/tambola/ticket.js';
import { seededRandom } from '../src/utils/random.js';
import type { Entry } from '../src/core/types.js';

const engine = new TambolaEngine();

function config(overrides: Partial<TambolaConfig> = {}): TambolaConfig {
  return { ...engine.defaultConfig(), seed: 7, ...overrides };
}

function entryFor(seed = 99): Entry<ReturnType<typeof generateTicket>> {
  return { entryNo: 1, payload: generateTicket(seededRandom(seed)) };
}

describe('draw sequence', () => {
  it('reveals all 90 numbers exactly once, then stops', () => {
    const cfg = config();
    let state = engine.createState(cfg);
    const seen: number[] = [];

    for (let i = 0; i < 90; i += 1) {
      const result = engine.draw(state, cfg);
      expect(result.value).not.toBeNull();
      seen.push(result.value as number);
      state = result.state;
    }

    expect(new Set(seen).size).toBe(90);
    expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: 90 }, (_, i) => i + 1));

    const exhausted = engine.draw(state, cfg);
    expect(exhausted.value).toBeNull();
    expect(exhausted.finished).toBe(true);
  });

  it('is replayable from the same seed', () => {
    const a = engine.createState(config({ seed: 123 }));
    const b = engine.createState(config({ seed: 123 }));
    expect(a.sequence).toEqual(b.sequence);
  });

  it('does not mutate the state it is given', () => {
    const cfg = config();
    const state = engine.createState(cfg);
    engine.draw(state, cfg);
    expect(state.cursor).toBe(0);
  });
});

describe('claim validation', () => {
  const cfg = config();
  let entry: Entry<ReturnType<typeof generateTicket>>;

  beforeEach(() => {
    entry = entryFor();
  });

  it('rejects a claim when nothing has been called', () => {
    const outcome = engine.validateClaim(entry, TAMBOLA_CLAIMS.FULL_HOUSE, {
      drawn: [],
      alreadyAwarded: [],
    });
    expect(outcome.ok).toBe(false);
  });

  it('awards Full House only when all 15 numbers are called', () => {
    const all = entry.payload.numbers;
    const short = engine.validateClaim(entry, TAMBOLA_CLAIMS.FULL_HOUSE, {
      drawn: all.slice(0, 14),
      alreadyAwarded: [],
    });
    expect(short.ok).toBe(false);

    const full = engine.validateClaim(entry, TAMBOLA_CLAIMS.FULL_HOUSE, {
      drawn: all,
      alreadyAwarded: [],
    });
    expect(full.ok).toBe(true);
  });

  it('awards Early Five on the fifth marked number, not the fourth', () => {
    const numbers = entry.payload.numbers;
    expect(
      engine.validateClaim(entry, TAMBOLA_CLAIMS.EARLY_FIVE, {
        drawn: numbers.slice(0, 4),
        alreadyAwarded: [],
      }).ok,
    ).toBe(false);

    expect(
      engine.validateClaim(entry, TAMBOLA_CLAIMS.EARLY_FIVE, {
        drawn: numbers.slice(0, 5),
        alreadyAwarded: [],
      }).ok,
    ).toBe(true);
  });

  it('does not count numbers that are not on the ticket toward Early Five', () => {
    const offTicket = Array.from({ length: 90 }, (_, i) => i + 1)
      .filter((n) => !entry.payload.numbers.includes(n))
      .slice(0, 20);

    expect(
      engine.validateClaim(entry, TAMBOLA_CLAIMS.EARLY_FIVE, { drawn: offTicket, alreadyAwarded: [] }).ok,
    ).toBe(false);
  });

  it('awards Top Line for the top row only', () => {
    const topRow = (entry.payload.grid[0] as (number | null)[]).filter((n): n is number => n !== null);
    const middleRow = (entry.payload.grid[1] as (number | null)[]).filter((n): n is number => n !== null);

    expect(engine.validateClaim(entry, TAMBOLA_CLAIMS.TOP_LINE, { drawn: topRow, alreadyAwarded: [] }).ok).toBe(
      true,
    );
    expect(
      engine.validateClaim(entry, TAMBOLA_CLAIMS.MIDDLE_LINE, { drawn: topRow, alreadyAwarded: [] }).ok,
    ).toBe(false);
    expect(
      engine.validateClaim(entry, TAMBOLA_CLAIMS.MIDDLE_LINE, { drawn: middleRow, alreadyAwarded: [] }).ok,
    ).toBe(true);
  });

  it('uses the outermost filled cells for Four Corners', () => {
    const corners = cornerNumbers(entry.payload);
    expect(corners).toHaveLength(4);
    expect(
      engine.validateClaim(entry, TAMBOLA_CLAIMS.FOUR_CORNERS, { drawn: corners, alreadyAwarded: [] }).ok,
    ).toBe(true);
    expect(
      engine.validateClaim(entry, TAMBOLA_CLAIMS.FOUR_CORNERS, {
        drawn: corners.slice(0, 3),
        alreadyAwarded: [],
      }).ok,
    ).toBe(false);
  });

  it('refuses a prize that has already been won', () => {
    const outcome = engine.validateClaim(entry, TAMBOLA_CLAIMS.TOP_LINE, {
      drawn: entry.payload.numbers,
      alreadyAwarded: [TAMBOLA_CLAIMS.TOP_LINE],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toMatch(/already been won/i);
  });

  it('rejects an unknown claim type', () => {
    expect(engine.validateClaim(entry, 'jackpot', { drawn: [], alreadyAwarded: [] }).ok).toBe(false);
  });
});

describe('game completion', () => {
  it('ends as soon as Full House is awarded', () => {
    const cfg = config();
    const state = engine.createState(cfg);
    expect(engine.isFinished(state, [])).toBe(false);
    expect(engine.isFinished(state, [TAMBOLA_CLAIMS.TOP_LINE])).toBe(false);
    expect(engine.isFinished(state, [TAMBOLA_CLAIMS.FULL_HOUSE])).toBe(true);
  });

  it('ends when the numbers run out', () => {
    const cfg = config();
    const state = engine.createState(cfg);
    expect(engine.isFinished({ ...state, cursor: 90 }, [])).toBe(true);
  });
});

describe('prize shares', () => {
  it('sum to the whole pot', () => {
    const total = engine.claims().reduce((sum, c) => sum + c.prizeShare, 0);
    expect(total).toBeCloseTo(1, 6);
  });
});

describe('rendering', () => {
  it('marks called numbers and reports progress', () => {
    const entry = entryFor(5);
    const rendered = engine.renderEntry(entry, entry.payload.numbers.slice(0, 3));
    expect(rendered).toContain('```');
    expect(rendered).toContain('3/15 marked');
  });

  it('announces the number before its nickname', () => {
    const cfg = config();
    const state = engine.createState(cfg);
    const result = engine.draw(state, cfg);
    const text = engine.renderDraw(result, result.state, cfg);
    expect(text).toContain(`*${result.value}*`);
  });
});
