/**
 * Tambola ticket generation.
 *
 * A legal ticket is 3 rows x 9 columns holding exactly 15 numbers, where:
 *   - every row has exactly 5 numbers
 *   - every column has 1, 2 or 3 numbers (never 0)
 *   - column j only ever holds numbers from its own decade
 *       col 0 -> 1..9, col 1 -> 10..19, ... col 7 -> 70..79, col 8 -> 80..90
 *   - within a column, numbers increase downwards
 *
 * Naive "pick 15 random numbers" fails these constraints almost every time,
 * so we pick the SHAPE first (how many numbers per column, and which rows they
 * sit in) and only then fill in values. The shape search is a small
 * backtracker, which is what guarantees the "exactly 5 per row" rule instead
 * of hoping for it.
 *
 * Pure module: no database, no network, no clock.
 */
import { shuffle } from '../../utils/random.js';

export const ROWS = 3;
export const COLUMNS = 9;
export const NUMBERS_PER_TICKET = 15;
export const NUMBERS_PER_ROW = 5;
export const MAX_NUMBER = 90;

/** Inclusive [low, high] range of numbers allowed in each column. */
export function columnRange(col) {
  if (col === 0) return [1, 9];
  if (col === COLUMNS - 1) return [80, 90];
  return [col * 10, col * 10 + 9];
}

/**
 * How many numbers each column holds: 9 columns, each at least 1, summing to
 * 15. Start every column at 1 and scatter the remaining 6, capping at 3.
 */
function pickColumnCounts(rng) {
  const counts = new Array(COLUMNS).fill(1);
  let remaining = NUMBERS_PER_TICKET - COLUMNS;
  while (remaining > 0) {
    const candidates = [];
    for (let c = 0; c < COLUMNS; c++) if (counts[c] < ROWS) candidates.push(c);
    const col = shuffle(candidates, rng)[0];
    counts[col]++;
    remaining--;
  }
  return counts;
}

/**
 * Decides which rows each column occupies, such that every row ends up with
 * exactly 5 numbers.
 *
 * Columns are visited most-constrained-first (a column of 3 has no choice at
 * all), which prunes the search almost immediately. Returns null if this
 * particular set of counts admits no valid layout, and the caller retries.
 */
function assignRows(counts, rng) {
  const order = counts
    .map((count, col) => ({ count, col }))
    .sort((a, b) => b.count - a.count);

  const capacity = new Array(ROWS).fill(NUMBERS_PER_ROW);
  const layout = new Array(COLUMNS);

  const choicesFor = (count) => {
    if (count === 3) return [[0, 1, 2]];
    if (count === 2) return shuffle([[0, 1], [0, 2], [1, 2]], rng);
    return shuffle([[0], [1], [2]], rng);
  };

  function place(i) {
    if (i === order.length) return capacity.every((c) => c === 0);
    const { count, col } = order[i];
    for (const rows of choicesFor(count)) {
      if (rows.some((r) => capacity[r] === 0)) continue;
      for (const r of rows) capacity[r]--;
      layout[col] = rows;
      if (place(i + 1)) return true;
      for (const r of rows) capacity[r]++;
    }
    return false;
  }

  return place(0) ? layout : null;
}

/**
 * Builds one ticket.
 *
 * @param {() => number} rng  from makeRng(); seed it for reproducible tickets
 * @returns {{ grid: (number|null)[][], numbers: number[] }}
 *          grid is 3x9 with nulls in the blanks; numbers is all 15, sorted.
 */
export function generateTicket(rng) {
  let layout = null;
  let counts = null;

  // pickColumnCounts can occasionally produce a shape with no legal row
  // assignment. Retrying is far simpler than constraining the counts up front,
  // and in practice this loop runs once.
  for (let attempt = 0; attempt < 200 && !layout; attempt++) {
    counts = pickColumnCounts(rng);
    layout = assignRows(counts, rng);
  }
  if (!layout) throw new Error('Could not lay out a valid ticket');

  const grid = Array.from({ length: ROWS }, () => new Array(COLUMNS).fill(null));

  for (let col = 0; col < COLUMNS; col++) {
    const [low, high] = columnRange(col);
    const pool = [];
    for (let n = low; n <= high; n++) pool.push(n);

    // Numbers must increase down a column, so sort the picks before placing.
    const picked = shuffle(pool, rng).slice(0, counts[col]).sort((a, b) => a - b);
    const rows = [...layout[col]].sort((a, b) => a - b);
    rows.forEach((row, i) => {
      grid[row][col] = picked[i];
    });
  }

  const numbers = grid.flat().filter((n) => n !== null).sort((a, b) => a - b);
  return { grid, numbers };
}

/** The numbers in one row, left to right. */
export function rowNumbers(grid, row) {
  return grid[row].filter((n) => n !== null);
}

/**
 * The four corners: leftmost and rightmost number of the top row, and of the
 * bottom row. Blank cells mean the corners are rarely in columns 0 and 8.
 */
export function cornerNumbers(grid) {
  const top = rowNumbers(grid, 0);
  const bottom = rowNumbers(grid, ROWS - 1);
  return [top[0], top[top.length - 1], bottom[0], bottom[bottom.length - 1]];
}

/**
 * Checks every rule a ticket must satisfy. Used by the tests, and cheap enough
 * to assert on in development when a ticket is created.
 */
export function validateTicket(ticket) {
  const errors = [];
  const { grid } = ticket;

  if (grid.length !== ROWS) errors.push(`expected ${ROWS} rows, got ${grid.length}`);
  grid.forEach((row, r) => {
    if (row.length !== COLUMNS) errors.push(`row ${r} has ${row.length} columns`);
    const filled = row.filter((n) => n !== null).length;
    if (filled !== NUMBERS_PER_ROW) errors.push(`row ${r} has ${filled} numbers, expected ${NUMBERS_PER_ROW}`);
  });

  for (let col = 0; col < COLUMNS; col++) {
    const [low, high] = columnRange(col);
    const values = grid.map((row) => row[col]).filter((n) => n !== null);
    if (values.length < 1 || values.length > ROWS) {
      errors.push(`column ${col} holds ${values.length} numbers, expected 1..${ROWS}`);
    }
    for (const v of values) {
      if (v < low || v > high) errors.push(`column ${col} holds ${v}, outside ${low}..${high}`);
    }
    for (let i = 1; i < values.length; i++) {
      if (values[i] <= values[i - 1]) errors.push(`column ${col} is not increasing downwards`);
    }
  }

  const all = grid.flat().filter((n) => n !== null);
  if (all.length !== NUMBERS_PER_TICKET) {
    errors.push(`ticket holds ${all.length} numbers, expected ${NUMBERS_PER_TICKET}`);
  }
  if (new Set(all).size !== all.length) errors.push('ticket holds a duplicate number');

  return errors;
}
