import { describe, expect, it } from 'vitest';
import {
  COLUMNS,
  MAX_NUMBER,
  NUMBERS_PER_ROW,
  NUMBERS_PER_TICKET,
  ROWS,
  columnForNumber,
  columnRange,
  generateTicket,
  validateTicket,
} from '../src/games/tambola/ticket.js';
import { seededRandom } from '../src/utils/random.js';

describe('columnRange / columnForNumber', () => {
  it('bands numbers the way housie does', () => {
    expect(columnRange(0)).toEqual({ min: 1, max: 9 });
    expect(columnRange(4)).toEqual({ min: 40, max: 49 });
    expect(columnRange(8)).toEqual({ min: 80, max: 90 });
  });

  it('maps every number 1-90 back into its own column', () => {
    for (let n = 1; n <= MAX_NUMBER; n += 1) {
      const col = columnForNumber(n);
      const { min, max } = columnRange(col);
      expect(n).toBeGreaterThanOrEqual(min);
      expect(n).toBeLessThanOrEqual(max);
    }
  });

  it('rejects numbers outside the range', () => {
    expect(() => columnForNumber(0)).toThrow();
    expect(() => columnForNumber(91)).toThrow();
  });
});

describe('generateTicket', () => {
  // Layout is a constraint-satisfaction problem; a handful of samples would
  // hide a rare backtracking failure.
  it('produces a structurally valid ticket 2000 times over', () => {
    for (let i = 0; i < 2000; i += 1) {
      const ticket = generateTicket();
      const errors = validateTicket(ticket);
      expect(errors, `iteration ${i}: ${errors.join('; ')}`).toEqual([]);
    }
  });

  it('always has 3 rows of exactly 5 numbers', () => {
    const ticket = generateTicket();
    expect(ticket.grid).toHaveLength(ROWS);
    for (const row of ticket.grid) {
      expect(row).toHaveLength(COLUMNS);
      expect(row.filter((c) => c !== null)).toHaveLength(NUMBERS_PER_ROW);
    }
    expect(ticket.numbers).toHaveLength(NUMBERS_PER_TICKET);
  });

  it('keeps every column between 1 and 3 numbers, ascending', () => {
    for (let i = 0; i < 200; i += 1) {
      const ticket = generateTicket();
      for (let col = 0; col < COLUMNS; col += 1) {
        const cells = ticket.grid.map((r) => r[col]).filter((n): n is number => n != null);
        expect(cells.length).toBeGreaterThanOrEqual(1);
        expect(cells.length).toBeLessThanOrEqual(3);
        expect([...cells].sort((a, b) => a - b)).toEqual(cells);
      }
    }
  });

  it('never repeats a number on one ticket', () => {
    for (let i = 0; i < 200; i += 1) {
      const { numbers } = generateTicket();
      expect(new Set(numbers).size).toBe(numbers.length);
    }
  });

  it('is reproducible from a seed', () => {
    const a = generateTicket(seededRandom(42));
    const b = generateTicket(seededRandom(42));
    expect(a.grid).toEqual(b.grid);
  });

  it('produces different tickets from different seeds', () => {
    const a = generateTicket(seededRandom(1));
    const b = generateTicket(seededRandom(2));
    expect(a.grid).not.toEqual(b.grid);
  });
});

describe('validateTicket', () => {
  it('catches a row with the wrong count', () => {
    const ticket = generateTicket();
    const row = ticket.grid[0] as (number | null)[];
    const firstFilled = row.findIndex((c) => c !== null);
    row[firstFilled] = null;
    expect(validateTicket(ticket).join(' ')).toContain('row 0 has 4 numbers');
  });

  it('catches a number in the wrong column', () => {
    const ticket = generateTicket();
    (ticket.grid[0] as (number | null)[])[0] = 55;
    expect(validateTicket(ticket).join(' ')).toContain('outside 1-9');
  });
});
