/**
 * Where a player can be in the WhatsApp conversation.
 *
 * Kept in its own module because both the conversation handler and the
 * end-of-game announcer need it, and having them import each other would be a
 * cycle - the announcer parks players in AWAITING_FEEDBACK, and the handler is
 * what reads them back out of it.
 */
export const STATES = {
  NEW: 'new',
  AWAITING_CONSENT: 'awaiting_consent',
  MENU: 'menu',
  AWAITING_PLAYER_COUNT: 'awaiting_player_count',
  AWAITING_PLAN: 'awaiting_plan',
  AWAITING_JOIN_CODE: 'awaiting_join_code',
  IN_LOBBY: 'in_lobby',
  IN_GAME: 'in_game',
  /** Rated the game, or about to - a free-text reply here becomes a comment. */
  AWAITING_FEEDBACK: 'awaiting_feedback',
  AWAITING_FEEDBACK_COMMENT: 'awaiting_feedback_comment',
};
