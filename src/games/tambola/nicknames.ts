/**
 * What the caller says when a number comes up.
 *
 * Tambola in India is not British bingo. "Kelly's eye" and "two fat ladies"
 * mean nothing at a kitty party in Bengaluru, and a caller who sounds imported
 * kills the one thing this product is selling — the feeling of being in the
 * room with everybody else.
 *
 * So these are Hinglish, the way people actually talk: a mix of Hindi and
 * English in one breath, cricket, Bollywood, chai, traffic, exams, shaadi.
 * Written to be read aloud and to raise a groan as often as a laugh, because a
 * caller who is trying slightly too hard is exactly right for housie.
 *
 * Rules followed throughout:
 *  - Latin script only. These go to WhatsApp and into PDFs, and a Devanagari
 *    line would need a font the report may not have.
 *  - Short. It is read in the second before the next number.
 *  - Nothing regional enough to exclude, nothing that mocks anyone.
 *  - No betting or money references anywhere: this is an entertainment-only
 *    product and the caller must not undercut that.
 */

export const NUMBER_NICKNAMES: Readonly<Record<number, string>> = {
  1: 'akela number one',
  2: 'do dost, ek chai',
  3: 'teen patti nahi, tambola',
  4: 'char minar',
  5: 'paanch ka punch',
  6: 'chhakka! sixer',
  7: 'saat samundar paar',
  8: 'aath baje ki chai',
  9: 'nau do gyarah',
  10: 'perfect ten',
  11: 'gyarah, do khambe',
  12: 'baarah baj gaye',
  13: 'unlucky? bilkul nahi',
  14: 'chaudah, Valentine ka din',
  15: 'pandrah August',
  16: 'sweet sixteen',
  17: 'satrah, board exam age',
  18: 'ab tum bade ho gaye',
  19: 'unnees-bees ka farak',
  20: 'bees, twenty-twenty match',
  21: 'ikkis, blackjack!',
  22: 'do battakh, quack quack',
  23: 'teiis, Michael Jordan',
  24: 'chaubis ghante',
  25: 'pachhees, silver jubilee',
  26: 'chhabbis January',
  27: 'sattaais, shaadi ki umar',
  28: 'atthaais, abhi bhi single',
  29: 'untees, February ka bonus',
  30: 'tees, thirty flirty',
  31: 'ikattis, month ka aakhri din',
  32: 'battis, poore daant',
  33: 'tettis crore',
  34: 'chauntis, chalo aage',
  35: 'paintis, mid-life shuru',
  36: 'chhattis ka aankda',
  37: 'saintis, thoda aur',
  38: 'adhtis, almost forty',
  39: 'untaalis, ek kam chaalis',
  40: 'chaalis, life begins',
  41: 'iktaalis, fun time',
  42: 'bayaalis, answer to everything',
  43: 'tentaalis, ghutne pe',
  44: 'chauwaalis, saare chaar',
  45: 'paintaalis, aadha safar',
  46: 'chhiyaalis, shararat',
  47: 'saintaalis, azaadi ka saal',
  48: 'adtaalis, chaar dozen',
  49: 'unchaas, ek kam pachaas',
  50: 'half century! taali bajao',
  51: 'ikyaavan, shagun ka lifafa',
  52: 'bavan, taash ki gaddi',
  53: 'tirpan, chalta hai',
  54: 'chauwan, thoda sabar',
  55: 'pachpan, do nanhi batakhein',
  56: 'chhappan, chhappan inch',
  57: 'sattavan, sauce wala',
  58: 'athaavan, intezaar karo',
  59: 'unsath, retirement paas',
  60: 'saath, senior citizen',
  61: 'iksath, bakery bun',
  62: 'basath, thoda aur',
  63: 'tirsath, gudgudi',
  64: 'chausath, chess ke khaane',
  65: 'painsath, pension time',
  66: 'chhiyaasath, highway 66',
  67: 'sarsath, ho gaya',
  68: 'athsath, chalte raho',
  69: 'unhattar, ulta seedha',
  70: 'sattar, saat dashak',
  71: 'ikhattar, bas thoda',
  72: 'bahattar, chhah dozen',
  73: 'tihattar, aage badho',
  74: 'chauhattar, dhoondte raho',
  75: 'pachhattar, platinum',
  76: 'chhihattar, aur kitna',
  77: 'sat-hattar, do jhande',
  78: 'athhattar, thoda sa aur',
  79: 'unasi, ek kam assi',
  80: 'assi, ghadi ki ghanti',
  81: 'ikyaasi, ruk jao',
  82: 'bayaasi, phir se',
  83: 'tirasi, chalo bhai',
  84: 'chaurasi, saat dozen',
  85: 'pachaasi, thodi der',
  86: 'chhiyaasi, aakhri ke paas',
  87: 'satasi, do mote',
  88: 'atthasi, do laddoo',
  89: 'nawasi, ek kam nabbe',
  90: 'nabbe! top of the house',
};

export function nicknameFor(value: number): string | undefined {
  return NUMBER_NICKNAMES[value];
}

/**
 * How a called number appears in chat.
 *
 * The digits are what a player scans for, so they lead and stay bold; the
 * nickname follows in italics as colour rather than information. A number with
 * no nickname still reads correctly — the caller just says less.
 */
export function formatCall(value: number, useNicknames: boolean): string {
  const nickname = useNicknames ? nicknameFor(value) : undefined;
  return nickname ? `🔊 *${value}* — _${nickname}_` : `🔊 *${value}*`;
}
