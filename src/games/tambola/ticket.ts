import { cryptoRandom, shuffle, type RandomSource } from '../../utils/random.js';

export const ROWS = 3;
export const COLUMNS = 9;
export const NUMBERS_PER_ROW = 5;
export const NUMBERS_PER_TICKET = ROWS * NUMBERS_PER_ROW; // 15
export const MAX_NUMBER = 90;

/** null = blank cell. Row-major, 3x9. */
export type TicketGrid = (number | null)[][];

export interface Ticket {
  grid: TicketGrid;
  /** Every number on the ticket, ascending. Convenience for claim checks. */
  numbers: number[];
}

/** Inclusive [min, max] for each column. Column 0 is 1-9, column 8 is 80-90. */
export function columnRange(col: number): { min: number; max: number } {
  if (col === 0) return { min: 1, max: 9 };
  if (col === COLUMNS - 1) return { min: 80, max: MAX_NUMBER };
  return { min: col * 10, max: col * 10 + 9 };
}

export function columnForNumber(value: number): number {
  if (value < 1 || value > MAX_NUMBER) throw new Error(`Number ${value} is outside 1-${MAX_NUMBER}`);
  if (value <= 9) return 0;
  if (value >= 80) return COLUMNS - 1;
  return Math.floor(value / 10);
}

/**
 * Picks how many numbers each column carries: every column gets at least 1,
 * no column more than 3, totalling 15.
 */
function pickColumnCounts(rng: RandomSource): number[] {
  const counts = new Array<number>(COLUMNS).fill(1);
  let remaining = NUMBERS_PER_TICKET - COLUMNS; // 6 to distribute
  while (remaining > 0) {
    const col = rng.int(COLUMNS);
    const current = counts[col] as number;
    if (current < 3) {
      counts[col] = current + 1;
      remaining -= 1;
    }
  }
  return counts;
}

/**
 * Chooses which rows each column occupies so that every row ends up with
 * exactly 5 numbers. Randomised backtracking — the search space is tiny
 * (9 columns, at most 3 row-subsets each) so this resolves immediately.
 */
function assignRows(counts: readonly number[], rng: RandomSource): number[][] {
  const subsetsBySize: Record<number, number[][]> = {
    1: [[0], [1], [2]],
    2: [
      [0, 1],
      [0, 2],
      [1, 2],
    ],
    3: [[0, 1, 2]],
  };

  const capacity = new Array<number>(ROWS).fill(NUMBERS_PER_ROW);
  const chosen: number[][] = [];

  const search = (col: number): boolean => {
    if (col === COLUMNS) return capacity.every((c) => c === 0);

    const remainingColumns = COLUMNS - col;
    // A row needing more slots than there are columns left can never be filled.
    if (capacity.some((c) => c > remainingColumns)) return false;

    const options = shuffle(subsetsBySize[counts[col] as number] as number[][], rng);
    for (const rows of options) {
      if (rows.some((r) => (capacity[r] as number) === 0)) continue;
      for (const r of rows) capacity[r] = (capacity[r] as number) - 1;
      chosen[col] = rows;
      if (search(col + 1)) return true;
      for (const r of rows) capacity[r] = (capacity[r] as number) + 1;
    }
    return false;
  };

  if (!search(0)) {
    // Unreachable for valid counts, but never hand back a malformed ticket.
    throw new Error('Failed to lay out ticket rows');
  }
  return chosen;
}

function pickColumnNumbers(col: number, count: number, rng: RandomSource): number[] {
  const { min, max } = columnRange(col);
  const pool: number[] = [];
  for (let n = min; n <= max; n += 1) pool.push(n);
  return shuffle(pool, rng)
    .slice(0, count)
    .sort((a, b) => a - b);
}

export function generateTicket(rng: RandomSource = cryptoRandom): Ticket {
  const counts = pickColumnCounts(rng);
  const rowsByColumn = assignRows(counts, rng);

  const grid: TicketGrid = Array.from({ length: ROWS }, () => new Array<number | null>(COLUMNS).fill(null));

  for (let col = 0; col < COLUMNS; col += 1) {
    const rows = (rowsByColumn[col] as number[]).slice().sort((a, b) => a - b);
    const numbers = pickColumnNumbers(col, counts[col] as number, rng);
    rows.forEach((row, i) => {
      (grid[row] as (number | null)[])[col] = numbers[i] as number;
    });
  }

  const numbers = grid
    .flat()
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
  return { grid, numbers };
}

/** Structural validation — used by tests and as a guard on generated tickets. */
export function validateTicket(ticket: Ticket): string[] {
  const errors: string[] = [];
  const { grid } = ticket;

  if (grid.length !== ROWS) errors.push(`expected ${ROWS} rows, got ${grid.length}`);

  grid.forEach((row, i) => {
    if (row.length !== COLUMNS) errors.push(`row ${i} has ${row.length} columns`);
    const filled = row.filter((c) => c !== null).length;
    if (filled !== NUMBERS_PER_ROW)
      errors.push(`row ${i} has ${filled} numbers, expected ${NUMBERS_PER_ROW}`);
  });

  for (let col = 0; col < COLUMNS; col += 1) {
    const cells = grid.map((row) => row[col] ?? null).filter((n): n is number => n !== null);
    if (cells.length < 1 || cells.length > 3) {
      errors.push(`column ${col} has ${cells.length} numbers, expected 1-3`);
    }
    const { min, max } = columnRange(col);
    for (const n of cells) {
      if (n < min || n > max) errors.push(`column ${col} contains ${n}, outside ${min}-${max}`);
    }
    for (let i = 1; i < cells.length; i += 1) {
      if ((cells[i] as number) <= (cells[i - 1] as number)) {
        errors.push(`column ${col} is not ascending`);
      }
    }
  }

  const all = grid.flat().filter((n): n is number => n !== null);
  if (all.length !== NUMBERS_PER_TICKET)
    errors.push(`ticket has ${all.length} numbers, expected ${NUMBERS_PER_TICKET}`);
  if (new Set(all).size !== all.length) errors.push('ticket contains duplicate numbers');

  return errors;
}
