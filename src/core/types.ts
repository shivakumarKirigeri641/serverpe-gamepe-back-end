/**
 * The contract every game on the platform implements. The services layer,
 * the draw worker and the WhatsApp adapter only ever talk to this interface,
 * so adding a second game means adding a file under src/games/ and registering
 * it — no changes to transport, scheduling or persistence.
 */

export type GameKey = string;

export interface EngineConfigBase {
  /** Deterministic replay seed. Omit for crypto randomness. */
  seed?: number;
}

/** One player's board: a Tambola ticket, a bingo card, a hand of cards. */
export interface Entry<TPayload = unknown> {
  entryNo: number;
  payload: TPayload;
}

export interface DrawResult<TState> {
  state: TState;
  /** The value revealed this tick, or null when nothing is left to draw. */
  value: number | null;
  seq: number;
  /** True once no further ticks are meaningful. */
  finished: boolean;
}

export type ClaimOutcome = { ok: true; claimType: string } | { ok: false; claimType: string; reason: string };

export interface ClaimContext {
  /** Values drawn so far, in draw order. */
  drawn: readonly number[];
  /** Claim types already awarded in this game. */
  alreadyAwarded: readonly string[];
}

export interface ClaimDefinition {
  key: string;
  label: string;
  /** Order shown in the claim menu. */
  order: number;
  /** Share of the prize pool, 0..1. Should sum to 1 across a game's claims. */
  prizeShare: number;
}

export interface GameEngine<
  TState = unknown,
  TEntryPayload = unknown,
  TConfig extends EngineConfigBase = EngineConfigBase,
> {
  readonly key: GameKey;
  readonly displayName: string;
  readonly description: string;
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly maxEntriesPerPlayer: number;
  /** What one player's board is called in chat: "ticket", "card", "hand". */
  readonly entryNoun: string;

  /** Claim types this game supports, in menu order. */
  claims(): readonly ClaimDefinition[];

  defaultConfig(): TConfig;

  createState(config: TConfig): TState;

  /** Builds a board for a player joining the lobby. */
  createEntry(state: TState, entryNo: number, config: TConfig): Entry<TEntryPayload>;

  /** Advances the game by one reveal. Pure: returns the next state. */
  draw(state: TState, config: TConfig): DrawResult<TState>;

  /** Validates a claim against what has actually been drawn. */
  validateClaim(entry: Entry<TEntryPayload>, claimType: string, ctx: ClaimContext): ClaimOutcome;

  /** True when every prize is gone or the deck is exhausted. */
  isFinished(state: TState, awarded: readonly string[]): boolean;

  /** Player-facing rules, shown by the `help` command. */
  helpText(): string;

  /**
   * The question put to a player when a value is revealed, with its two
   * answers. Lives here because only the engine knows what a "value" means.
   */
  ackPrompt(value: number): { question: string; yes: string; no: string };

  /** WhatsApp-ready rendering, kept in the engine because layout is game-specific. */
  renderEntry(entry: Entry<TEntryPayload>, drawn: readonly number[]): string;

  /**
   * Optional graphical board. Engines that implement it get an image message
   * instead of a text one; those that do not fall back to renderEntry.
   */
  renderEntryImage?(
    entry: Entry<TEntryPayload>,
    drawn: readonly number[],
    opts: { roomCode?: string; brand?: string; latest?: number | null; totalNumbers?: number },
  ): Promise<Buffer>;
  renderDraw(result: DrawResult<TState>, state: TState, config?: TConfig): string;
}
