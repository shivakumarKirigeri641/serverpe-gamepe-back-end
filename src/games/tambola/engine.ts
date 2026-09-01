import { env } from '../../config/env.js';
import type {
  ClaimContext,
  ClaimDefinition,
  ClaimOutcome,
  DrawResult,
  EngineConfigBase,
  Entry,
  GameEngine,
} from '../../core/types.js';
import { cryptoRandom, seededRandom, shuffle } from '../../utils/random.js';
import { formatCall } from './nicknames.js';
import { CLAIM_DEFINITIONS, TAMBOLA_CLAIMS, checkPattern, isTambolaClaim } from './patterns.js';
import { renderTicketPng } from './ticket-image.js';
import { COLUMNS, MAX_NUMBER, ROWS, generateTicket, type Ticket } from './ticket.js';

export const TAMBOLA_KEY = 'tambola';

export interface TambolaConfig extends EngineConfigBase {
  /** Numbers per game. 90 for standard housie. */
  maxNumber: number;
  /** Claim types in play this round. */
  enabledClaims: string[];
  /** A wrong claim removes the player from claiming (a "bogey"). */
  penaliseFalseClaims: boolean;
  /** Announce traditional caller nicknames alongside each number. */
  useNicknames: boolean;
}

export interface TambolaState {
  /** Pre-shuffled draw order, fixed at game creation so a round is replayable. */
  sequence: number[];
  /** How many of `sequence` have been revealed. */
  cursor: number;
}

export type TambolaEntryPayload = Ticket;

function drawnSet(drawn: readonly number[]): Set<number> {
  return new Set(drawn);
}

export class TambolaEngine implements GameEngine<TambolaState, TambolaEntryPayload, TambolaConfig> {
  readonly key = TAMBOLA_KEY;
  readonly displayName = 'Tambola';
  readonly description = 'Classic housie — 90 numbers, 3x9 tickets, six prizes.';
  readonly minPlayers = 1;
  // The engine itself has no upper bound — ninety numbers and a ticket each
  // work for any number of people. The real limit is how fast a called number
  // can reach everybody, so it lives in configuration (MAX_PLAYERS_PER_GAME)
  // and is measured against the fan-out rather than asserted here.
  readonly maxPlayers = env.MAX_PLAYERS_PER_GAME;
  readonly maxEntriesPerPlayer = 6;
  readonly entryNoun = 'ticket';

  helpText(): string {
    return [
      '*How to play Tambola*',
      '',
      'Every player gets a 3x9 ticket with 15 numbers.',
      'The bot calls numbers one at a time. Tap to say whether the number is on your ticket.',
      '',
      '*Prizes*',
      '• *Early Five* — first five numbers marked',
      '• *Top / Middle / Bottom Line* — a full row',
      '• *Four Corners* — the four corner numbers',
      '• *Full House* — the whole ticket. Ends the game.',
    ].join('\n');
  }

  ackPrompt(value: number): { question: string; yes: string; no: string } {
    return {
      question: `Is *${value}* on your ticket?`,
      yes: 'Yes, I have it',
      no: 'Not on my ticket',
    };
  }

  claims(): readonly ClaimDefinition[] {
    return CLAIM_DEFINITIONS;
  }

  defaultConfig(): TambolaConfig {
    return {
      maxNumber: MAX_NUMBER,
      enabledClaims: CLAIM_DEFINITIONS.map((c) => c.key),
      penaliseFalseClaims: false,
      useNicknames: true,
    };
  }

  createState(config: TambolaConfig): TambolaState {
    const rng = config.seed === undefined ? cryptoRandom : seededRandom(config.seed);
    const pool = Array.from({ length: config.maxNumber }, (_, i) => i + 1);
    return { sequence: shuffle(pool, rng), cursor: 0 };
  }

  createEntry(_state: TambolaState, entryNo: number, config: TambolaConfig): Entry<TambolaEntryPayload> {
    // Tickets are independent of the draw sequence, so a late joiner in the
    // lobby gets a ticket the same way the first player did.
    const rng = config.seed === undefined ? cryptoRandom : seededRandom(config.seed + entryNo * 7919);
    return { entryNo, payload: generateTicket(rng) };
  }

  draw(state: TambolaState, _config: TambolaConfig): DrawResult<TambolaState> {
    if (state.cursor >= state.sequence.length) {
      return { state, value: null, seq: state.cursor, finished: true };
    }
    const value = state.sequence[state.cursor] as number;
    const next: TambolaState = { sequence: state.sequence, cursor: state.cursor + 1 };
    return {
      state: next,
      value,
      seq: next.cursor,
      finished: next.cursor >= next.sequence.length,
    };
  }

  validateClaim(entry: Entry<TambolaEntryPayload>, claimType: string, ctx: ClaimContext): ClaimOutcome {
    if (!isTambolaClaim(claimType)) {
      return { ok: false, claimType, reason: 'Unknown claim type.' };
    }
    if (ctx.alreadyAwarded.includes(claimType)) {
      return { ok: false, claimType, reason: 'That prize has already been won.' };
    }

    const check = checkPattern(entry.payload, claimType, drawnSet(ctx.drawn));
    if (!check.satisfied) {
      // Name the prize and describe the player's own ticket.
      //
      // The old wording — "3 number(s) still to be called" — read as though the
      // game had numbers left to call, rather than the player needing three
      // more of theirs, and never said which prize was refused. Somebody who
      // has just tapped Claim and been told no deserves to know what for.
      const label = CLAIM_DEFINITIONS.find((c) => c.key === claimType)?.label ?? claimType;
      const short = check.needed - check.matched;

      return {
        ok: false,
        claimType,
        reason:
          `*${label}* is not ready yet — you have ${check.matched} of the ${check.needed} ` +
          `numbers it needs. ${short} more of your numbers ${short === 1 ? 'has' : 'have'} ` +
          `to be called.`,
      };
    }
    return { ok: true, claimType };
  }

  isFinished(state: TambolaState, awarded: readonly string[]): boolean {
    if (awarded.includes(TAMBOLA_CLAIMS.FULL_HOUSE)) return true;
    return state.cursor >= state.sequence.length;
  }

  renderEntry(entry: Entry<TambolaEntryPayload>, drawn: readonly number[]): string {
    const called = drawnSet(drawn);
    const lines: string[] = [];
    for (let r = 0; r < ROWS; r += 1) {
      let line = '';
      for (let c = 0; c < COLUMNS; c += 1) {
        const cell = (entry.payload.grid[r] as (number | null)[])[c] ?? null;
        if (cell === null) {
          line += '  ·';
        } else if (called.has(cell)) {
          line += `*${String(cell).padStart(2, ' ')}`;
        } else {
          line += ` ${String(cell).padStart(2, ' ')}`;
        }
      }
      lines.push(line);
    }
    const marked = entry.payload.numbers.filter((n) => called.has(n)).length;
    return [`Ticket #${entry.entryNo}`, '```', ...lines, '```', `_* = called · ${marked}/15 marked_`].join(
      '\n',
    );
  }

  async renderEntryImage(
    entry: Entry<TambolaEntryPayload>,
    drawn: readonly number[],
    opts: { roomCode?: string; brand?: string; latest?: number | null; totalNumbers?: number },
  ): Promise<Buffer> {
    return renderTicketPng(entry.payload, drawn, {
      entryNo: entry.entryNo,
      roomCode: opts.roomCode,
      brand: opts.brand,
      latest: opts.latest ?? null,
      totalNumbers: opts.totalNumbers ?? MAX_NUMBER,
    });
  }

  renderDraw(result: DrawResult<TambolaState>, _state: TambolaState, config?: TambolaConfig): string {
    if (result.value === null) return 'All numbers have been called.';
    const call = formatCall(result.value, config?.useNicknames ?? true);
    return `${call}
_${result.seq} of ${result.state.sequence.length} called_`;
  }
}

export const tambolaEngine = new TambolaEngine();
