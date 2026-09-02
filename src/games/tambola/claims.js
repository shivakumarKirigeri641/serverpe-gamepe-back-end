/**
 * Prize definitions and claim validation.
 *
 * Claims are validated against the numbers that were actually DRAWN, not
 * against what the player marked on screen. That mirrors physical tambola -
 * you cross out your own ticket, but the host checks your claim against the
 * board - and it means a mis-tap or a missed number can never silently void a
 * legitimate win forty minutes later.
 *
 * Pure module: no database, no clock.
 */
import { rowNumbers, cornerNumbers, NUMBERS_PER_TICKET } from './ticket.js';

export const JALDI_5_TARGET = 5;

/**
 * Prize order is menu order. prizeShare is carried for the future sponsorship
 * model; it sums to 1 and is unused while the platform is free.
 */
export const CLAIMS = [
  { key: 'jaldi5',      label: 'Jaldi 5',     order: 1, prizeShare: 0.10, hint: 'any 5 numbers on your ticket' },
  { key: 'top_line',    label: 'Top Line',    order: 2, prizeShare: 0.15, hint: 'all 5 numbers in the first row' },
  { key: 'middle_line', label: 'Middle Line', order: 3, prizeShare: 0.15, hint: 'all 5 numbers in the middle row' },
  { key: 'bottom_line', label: 'Bottom Line', order: 4, prizeShare: 0.15, hint: 'all 5 numbers in the last row' },
  { key: 'corners',     label: 'Corners',     order: 5, prizeShare: 0.10, hint: 'the 4 corner numbers' },
  { key: 'full_house',  label: 'Full House',  order: 6, prizeShare: 0.35, hint: 'every number on your ticket' },
];

export const CLAIM_KEYS = CLAIMS.map((c) => c.key);

/** The claim that ends the game when awarded. */
export const FINAL_CLAIM = 'full_house';

export function getClaim(key) {
  return CLAIMS.find((c) => c.key === key) ?? null;
}

/**
 * The specific numbers a claim needs. Jaldi 5 has no fixed set - it is "any
 * five" - so it returns null and is handled separately.
 */
export function requiredNumbers(grid, claimKey) {
  switch (claimKey) {
    case 'top_line':    return rowNumbers(grid, 0);
    case 'middle_line': return rowNumbers(grid, 1);
    case 'bottom_line': return rowNumbers(grid, 2);
    case 'corners':     return cornerNumbers(grid);
    case 'full_house':  return grid.flat().filter((n) => n !== null);
    case 'jaldi5':      return null;
    default:            return undefined;
  }
}

/**
 * Is this claim satisfied by what has been drawn so far?
 *
 * @param {(number|null)[][]} grid    the player's ticket
 * @param {string} claimKey
 * @param {Set<number>|Iterable<number>} drawn  numbers called so far
 * @returns {{ ok: boolean, reason?: string, missing?: number[] }}
 */
export function isSatisfied(grid, claimKey, drawn) {
  const called = drawn instanceof Set ? drawn : new Set(drawn);

  if (claimKey === 'jaldi5') {
    const marked = grid.flat().filter((n) => n !== null && called.has(n));
    return marked.length >= JALDI_5_TARGET
      ? { ok: true }
      : { ok: false, reason: `only ${marked.length} of your numbers have been called, ${JALDI_5_TARGET} are needed` };
  }

  const required = requiredNumbers(grid, claimKey);
  if (required === undefined) return { ok: false, reason: `unknown prize "${claimKey}"` };

  const missing = required.filter((n) => !called.has(n));
  if (missing.length === 0) return { ok: true };
  return {
    ok: false,
    missing,
    reason: missing.length === 1
      ? `${missing[0]} has not been called yet`
      : `${missing.length} of those numbers have not been called yet`,
  };
}

/**
 * Full validation of an attempted claim, including whether the prize is still
 * available. The database's unique index is the real arbiter when two players
 * claim at the same instant - this is the fast path that rejects the obvious
 * cases before a transaction is opened.
 *
 * @param {object} params
 * @param {(number|null)[][]} params.grid
 * @param {string} params.claimKey
 * @param {Iterable<number>} params.drawn
 * @param {Iterable<string>} params.alreadyAwarded  prize keys already won
 */
export function validateClaim({ grid, claimKey, drawn, alreadyAwarded = [] }) {
  const claim = getClaim(claimKey);
  if (!claim) return { ok: false, claimKey, reason: `unknown prize "${claimKey}"` };

  if (new Set(alreadyAwarded).has(claimKey)) {
    return { ok: false, claimKey, reason: `${claim.label} has already been won` };
  }

  const result = isSatisfied(grid, claimKey, drawn);
  return result.ok
    ? { ok: true, claimKey, label: claim.label }
    : { ok: false, claimKey, label: claim.label, reason: result.reason, missing: result.missing };
}

/**
 * Which prizes this player could claim right now. The board shows all six
 * buttons at all times and highlights these, so a player learns the game by
 * watching rather than by reading rules.
 */
export function eligibleClaims(grid, drawn, alreadyAwarded = []) {
  const won = new Set(alreadyAwarded);
  return CLAIMS.filter((c) => !won.has(c.key) && isSatisfied(grid, c.key, drawn).ok).map((c) => c.key);
}

/**
 * The game is over when Full House is won, or when all 90 numbers have been
 * called and there is nothing left to draw. Without the second condition an
 * inattentive table would leave a game running forever.
 */
export function isGameOver({ alreadyAwarded = [], drawnCount = 0 }) {
  if (new Set(alreadyAwarded).has(FINAL_CLAIM)) return { over: true, reason: 'full_house' };
  if (drawnCount >= 90) return { over: true, reason: 'numbers_exhausted' };
  return { over: false };
}

/** Sanity check used by the tests: prize shares must add up to a whole pot. */
export function totalPrizeShare() {
  return Number(CLAIMS.reduce((sum, c) => sum + c.prizeShare, 0).toFixed(6));
}

export { NUMBERS_PER_TICKET };
