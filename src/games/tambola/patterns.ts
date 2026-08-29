import type { ClaimDefinition } from '../../core/types.js';
import type { Ticket } from './ticket.js';

export const TAMBOLA_CLAIMS = {
  EARLY_FIVE: 'early_five',
  TOP_LINE: 'top_line',
  MIDDLE_LINE: 'middle_line',
  BOTTOM_LINE: 'bottom_line',
  FOUR_CORNERS: 'four_corners',
  FULL_HOUSE: 'full_house',
} as const;

export type TambolaClaimType = (typeof TAMBOLA_CLAIMS)[keyof typeof TAMBOLA_CLAIMS];

export const CLAIM_DEFINITIONS: readonly ClaimDefinition[] = [
  { key: TAMBOLA_CLAIMS.EARLY_FIVE, label: 'Early Five', order: 1, prizeShare: 0.1 },
  { key: TAMBOLA_CLAIMS.TOP_LINE, label: 'Top Line', order: 2, prizeShare: 0.1 },
  { key: TAMBOLA_CLAIMS.MIDDLE_LINE, label: 'Middle Line', order: 3, prizeShare: 0.1 },
  { key: TAMBOLA_CLAIMS.BOTTOM_LINE, label: 'Bottom Line', order: 4, prizeShare: 0.1 },
  { key: TAMBOLA_CLAIMS.FOUR_CORNERS, label: 'Four Corners', order: 5, prizeShare: 0.1 },
  { key: TAMBOLA_CLAIMS.FULL_HOUSE, label: 'Full House', order: 6, prizeShare: 0.5 },
];

export function isTambolaClaim(value: string): value is TambolaClaimType {
  return Object.values(TAMBOLA_CLAIMS).includes(value as TambolaClaimType);
}

function rowNumbers(ticket: Ticket, row: number): number[] {
  return (ticket.grid[row] ?? []).filter((n): n is number => n !== null);
}

/** First and last filled cell of the top row and of the bottom row. */
export function cornerNumbers(ticket: Ticket): number[] {
  const top = rowNumbers(ticket, 0);
  const bottom = rowNumbers(ticket, 2);
  return [
    top[0] as number,
    top[top.length - 1] as number,
    bottom[0] as number,
    bottom[bottom.length - 1] as number,
  ];
}

/** Numbers a claim requires. Early Five is special-cased (any five). */
export function requiredNumbers(ticket: Ticket, claim: TambolaClaimType): number[] | null {
  switch (claim) {
    case TAMBOLA_CLAIMS.TOP_LINE:
      return rowNumbers(ticket, 0);
    case TAMBOLA_CLAIMS.MIDDLE_LINE:
      return rowNumbers(ticket, 1);
    case TAMBOLA_CLAIMS.BOTTOM_LINE:
      return rowNumbers(ticket, 2);
    case TAMBOLA_CLAIMS.FOUR_CORNERS:
      return cornerNumbers(ticket);
    case TAMBOLA_CLAIMS.FULL_HOUSE:
      return ticket.numbers;
    case TAMBOLA_CLAIMS.EARLY_FIVE:
      return null;
    default:
      return null;
  }
}

export interface PatternCheck {
  satisfied: boolean;
  matched: number;
  needed: number;
  missing: number[];
}

export function checkPattern(
  ticket: Ticket,
  claim: TambolaClaimType,
  drawn: ReadonlySet<number>,
): PatternCheck {
  if (claim === TAMBOLA_CLAIMS.EARLY_FIVE) {
    const matched = ticket.numbers.filter((n) => drawn.has(n)).length;
    return { satisfied: matched >= 5, matched, needed: 5, missing: [] };
  }

  const required = requiredNumbers(ticket, claim) ?? [];
  const missing = required.filter((n) => !drawn.has(n));
  return {
    satisfied: missing.length === 0,
    matched: required.length - missing.length,
    needed: required.length,
    missing,
  };
}
