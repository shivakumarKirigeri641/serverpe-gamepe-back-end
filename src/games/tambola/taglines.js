/**
 * The call-out line shown with every number.
 *
 * Plain English, and deliberately not jokes. Three reasons:
 *
 *   1. A caller's line has a job - it confirms the number. Hearing "four and
 *      five, forty-five" after seeing 45 is a second chance to catch it, which
 *      matters on a small screen in a noisy room. A punchline does not do that.
 *   2. These are read by strangers of every age at somebody's family gathering.
 *      Neutral travels; humour does not, and a line that lands badly for one
 *      player is worse than no line at all.
 *   3. Topical jokes date. These will read the same in five years.
 *
 * The digits are spelled out before the number itself, which is the long-
 * standing convention for exactly the reason in (1).
 *
 * Edit freely - this file has no logic in it and changing a line cannot break
 * a game. If you add a line, keep it short: it sits under a large number on a
 * phone and has about one line of room.
 */
export const TAGLINES = {
   1: 'On its own, number one. The lowest number on the board.',
   2: 'On its own, number two.',
   3: 'On its own, number three.',
   4: 'On its own, number four.',
   5: 'On its own, number five.',
   6: 'On its own, number six.',
   7: 'On its own, number seven.',
   8: 'On its own, number eight.',
   9: 'On its own, number nine.',
  10: 'One and zero, ten.',
  11: 'Two ones, eleven.',
  12: 'One and two, twelve.',
  13: 'One and three, thirteen.',
  14: 'One and four, fourteen.',
  15: 'One and five, fifteen.',
  16: 'One and six, sixteen.',
  17: 'One and seven, seventeen.',
  18: 'One and eight, eighteen.',
  19: 'One and nine, nineteen.',
  20: 'Two and zero, twenty.',
  21: 'Two and one, twenty-one.',
  22: 'Two twos, twenty-two.',
  23: 'Two and three, twenty-three.',
  24: 'Two and four, twenty-four.',
  25: 'Two and five, twenty-five.',
  26: 'Two and six, twenty-six.',
  27: 'Two and seven, twenty-seven.',
  28: 'Two and eight, twenty-eight.',
  29: 'Two and nine, twenty-nine.',
  30: 'Three and zero, thirty.',
  31: 'Three and one, thirty-one.',
  32: 'Three and two, thirty-two.',
  33: 'Two threes, thirty-three.',
  34: 'Three and four, thirty-four.',
  35: 'Three and five, thirty-five.',
  36: 'Three and six, thirty-six.',
  37: 'Three and seven, thirty-seven.',
  38: 'Three and eight, thirty-eight.',
  39: 'Three and nine, thirty-nine.',
  40: 'Four and zero, forty.',
  41: 'Four and one, forty-one.',
  42: 'Four and two, forty-two.',
  43: 'Four and three, forty-three.',
  44: 'Two fours, forty-four.',
  45: 'Four and five, forty-five. Halfway up the board.',
  46: 'Four and six, forty-six.',
  47: 'Four and seven, forty-seven.',
  48: 'Four and eight, forty-eight.',
  49: 'Four and nine, forty-nine.',
  50: 'Five and zero, fifty.',
  51: 'Five and one, fifty-one.',
  52: 'Five and two, fifty-two.',
  53: 'Five and three, fifty-three.',
  54: 'Five and four, fifty-four.',
  55: 'Two fives, fifty-five.',
  56: 'Five and six, fifty-six.',
  57: 'Five and seven, fifty-seven.',
  58: 'Five and eight, fifty-eight.',
  59: 'Five and nine, fifty-nine.',
  60: 'Six and zero, sixty.',
  61: 'Six and one, sixty-one.',
  62: 'Six and two, sixty-two.',
  63: 'Six and three, sixty-three.',
  64: 'Six and four, sixty-four.',
  65: 'Six and five, sixty-five.',
  66: 'Two sixes, sixty-six.',
  67: 'Six and seven, sixty-seven.',
  68: 'Six and eight, sixty-eight.',
  69: 'Six and nine, sixty-nine.',
  70: 'Seven and zero, seventy.',
  71: 'Seven and one, seventy-one.',
  72: 'Seven and two, seventy-two.',
  73: 'Seven and three, seventy-three.',
  74: 'Seven and four, seventy-four.',
  75: 'Seven and five, seventy-five.',
  76: 'Seven and six, seventy-six.',
  77: 'Two sevens, seventy-seven.',
  78: 'Seven and eight, seventy-eight.',
  79: 'Seven and nine, seventy-nine.',
  80: 'Eight and zero, eighty.',
  81: 'Eight and one, eighty-one.',
  82: 'Eight and two, eighty-two.',
  83: 'Eight and three, eighty-three.',
  84: 'Eight and four, eighty-four.',
  85: 'Eight and five, eighty-five.',
  86: 'Eight and six, eighty-six.',
  87: 'Eight and seven, eighty-seven.',
  88: 'Two eights, eighty-eight.',
  89: 'Eight and nine, eighty-nine.',
  90: 'Nine and zero, ninety. The highest number on the board.',
};

/** Never returns undefined - a missing line must not break the board. */
export function taglineFor(value) {
  return TAGLINES[value] ?? `Number ${value}.`;
}
