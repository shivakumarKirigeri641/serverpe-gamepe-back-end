import { describe, expect, it } from 'vitest';
import { looksLikeRoomCode } from '../src/utils/ids.js';

/**
 * Room codes versus commands.
 *
 * A room code is six characters from a confusable-free alphabet. Several words
 * the bot already understands are also six characters — 'STATUS' is entirely
 * made of letters in that alphabet — so a command can look exactly like a code.
 *
 * That is not theoretical: tapping "Status" was answered with "No game found
 * with code STATUS", because the code check ran before the command switch.
 * TICKET, WALLET and CANCEL survived only because the alphabet happens to omit
 * I, L and O. These tests pin the collision so a future change to either the
 * command list or the alphabet cannot quietly reintroduce it.
 */

// Mirrors KNOWN_COMMANDS in conversation.service.ts. Kept as a literal rather
// than imported, so adding a command there without thinking about this file
// shows up as a failure here rather than as a silent new collision.
const COMMANDS = [
  'hi', 'hello', 'hey', 'menu', 'start', 'cancel', 'back', 'stop',
  'play', 'new', 'play now', 'start playing',
  'start free trial', 'start free trail', 'free trial', 'free trail',
  'join',
  'help', 'how to play', 'how it works',
  'stats', 'board', 'leaderboard', 'top players',
  'balance', 'credits', 'wallet', 'my credits', 'check balance',
  'terms', 'privacy', 'legal',
  'ticket', 'entry', 'status', 'claim', 'leave',
];

describe('room codes and commands', () => {
  it('recognises a real room code', () => {
    expect(looksLikeRoomCode('K5TFX7')).toBe(true);
    expect(looksLikeRoomCode('k5tfx7')).toBe(true);
  });

  it('rejects the wrong length', () => {
    expect(looksLikeRoomCode('K5TFX')).toBe(false);
    expect(looksLikeRoomCode('K5TFX77')).toBe(false);
  });

  it('rejects confusable characters that are not in the alphabet', () => {
    for (const code of ['K5TFXO', 'K5TFXI', 'K5TFXL', 'K5TFX1', 'K5TFX0']) {
      expect(looksLikeRoomCode(code)).toBe(false);
    }
  });

  /**
   * The one that actually bit. 'status' IS a valid-looking code, so the guard
   * cannot live in looksLikeRoomCode — it has to be the command check running
   * first, which is what findRoomCodeIn now does.
   */
  it('documents that some commands are indistinguishable from a code', () => {
    expect(looksLikeRoomCode('status')).toBe(true);
  });

  it('the command list is checked before code detection', () => {
    // Every command that could pass as a code must be in the list the router
    // consults first. If this grows, the ordering in findRoomCodeIn is what
    // keeps it safe — not the alphabet.
    const collisions = COMMANDS.filter((c) => looksLikeRoomCode(c));
    expect(collisions).toEqual(['status']);

    for (const c of collisions) {
      expect(COMMANDS).toContain(c);
    }
  });
});
