/**
 * Caller nicknames for 1-90.
 *
 * EDIT THIS FILE FREELY — it is meant to be tuned, not treated as canon.
 * There is no single Indian tambola list; every host has their own calls, and
 * a good number of the traditional British ones ("Brighton line", "Torquay in
 * Devon") mean nothing to players here. Where the original was obscure or
 * regional, this list uses a plain digit-based call instead, which always
 * reads correctly.
 *
 * The number is ALWAYS announced first and the nickname second, so a player who
 * has never heard the call still knows exactly which number came up:
 *
 *     🔊 22 — two little ducks
 *
 * Deliberately omitted: calls that depend on British place names, and
 * "Gandhi's breakfast" for 80 — common in some Indian rooms, but likely to
 * land badly with part of your audience. Add it back here if you disagree.
 */

export const NUMBER_NICKNAMES: Readonly<Record<number, string>> = {
  1: "Kelly's eye",
  2: 'one little duck',
  3: 'cup of tea',
  4: 'knock at the door',
  5: 'man alive',
  6: 'half a dozen',
  7: 'lucky seven',
  8: 'garden gate',
  9: "doctor's number",
  10: 'one and nothing',
  11: 'legs eleven',
  12: 'one dozen',
  13: 'unlucky for some',
  14: "Valentine's day",
  15: 'young and keen',
  16: 'sweet sixteen',
  17: 'dancing queen',
  18: 'coming of age',
  19: 'goodbye teens',
  20: 'one score',
  21: 'key of the door',
  22: 'two little ducks',
  23: 'thee and me',
  24: 'two dozen',
  25: 'duck and dive',
  26: 'two and six',
  27: 'gateway to heaven',
  28: 'in a state',
  29: 'rise and shine',
  30: 'three in a row',
  31: 'get up and run',
  32: 'buckle my shoe',
  33: 'all the threes',
  34: 'ask for more',
  35: 'jump and jive',
  36: 'three dozen',
  37: 'more than eleven',
  38: 'birthday cake',
  39: 'thirty-nine steps',
  40: 'life begins',
  41: 'time for fun',
  42: 'four and two',
  43: 'down on your knees',
  44: 'all the fours',
  45: 'halfway there',
  46: 'up to tricks',
  47: 'four and seven',
  48: 'four dozen',
  49: 'rise and shine',
  50: 'half a century',
  51: 'tweak of the thumb',
  52: 'deck of cards',
  53: 'stuck in the tree',
  54: 'clean the floor',
  55: 'all the fives',
  56: 'five and six',
  57: 'Heinz varieties',
  58: 'make them wait',
  59: 'five and nine',
  60: 'five dozen',
  61: "baker's bun",
  62: 'turn the screw',
  63: 'tickle me',
  64: 'almost retired',
  65: 'retirement age',
  66: 'all the sixes',
  67: 'stairway to heaven',
  68: 'saving grace',
  69: 'either way up',
  70: 'three score and ten',
  71: 'bang on the drum',
  72: 'six dozen',
  73: 'queen bee',
  74: 'hit the floor',
  75: 'three quarters',
  76: 'trombones',
  77: 'two little crutches',
  78: "heaven's gate",
  79: 'one more time',
  80: 'eight and nothing',
  81: 'stop and run',
  82: 'straight on through',
  83: 'time for tea',
  84: 'seven dozen',
  85: 'staying alive',
  86: 'between the sticks',
  87: 'eight and seven',
  88: 'two fat ladies',
  89: 'nearly there',
  90: 'top of the shop',
};

export function nicknameFor(value: number): string | undefined {
  return NUMBER_NICKNAMES[value];
}

/** `🔊 *22* — _two little ducks_`, or just the number when calls are off. */
export function formatCall(value: number, useNicknames: boolean): string {
  const nickname = useNicknames ? nicknameFor(value) : undefined;
  return nickname ? `🔊 *${value}* — _${nickname}_` : `🔊 *${value}*`;
}
