/**
 * Tap Bakra in Hindi.
 *
 * ── Why this is a lexicon and not a translation call ──────────────────────
 *
 * A mistranslated option here is not a typo, it is a wrong answer. The player
 * has five seconds, one reading, and no way to appeal - so every word a
 * question can show is listed by hand and checked against the English it
 * replaces. Nothing is translated at runtime.
 *
 * ── What is translated and what is not ────────────────────────────────────
 *
 * Common nouns become Hindi (MANGO -> आम). Proper nouns - cities, festivals,
 * dishes - are transliterated rather than translated, because that is what
 * they are called in Hindi (MUMBAI -> मुंबई, DIWALI -> दिवाली, IDLI -> इडली).
 * Numbers become Devanagari digits.
 *
 * ── One thing Hindi loses ─────────────────────────────────────────────────
 *
 * The lookalike traps are English spelling jokes: BAT/BAG, MOON/NOON,
 * RICE/RISE. Translated, they stop looking alike and simply read as ordinary
 * questions - a little easier, never wrong. Building Devanagari lookalikes is
 * a separate piece of work and is deliberately not faked here.
 *
 * NEEDS A NATIVE REVIEW before launch. It is careful, not authoritative.
 */

/** Devanagari digits, for numbers shown as options. */
const DIGITS = ['०', '१', '२', '३', '४', '५', '६', '७', '८', '९'];
export const toDevanagari = (text) =>
  String(text).replace(/[0-9]/g, (d) => DIGITS[Number(d)]);

/** Every token the bank can put on a button. */
export const WORDS = {
  // animals
  TIGER: 'बाघ', ELEPHANT: 'हाथी', MONKEY: 'बंदर', PEACOCK: 'मोर', COW: 'गाय',
  CAMEL: 'ऊँट', SNAKE: 'साँप', PARROT: 'तोता', LION: 'शेर', GOAT: 'बकरा',
  HORSE: 'घोड़ा', RABBIT: 'खरगोश', CROW: 'कौआ', FISH: 'मछली', DEER: 'हिरण',
  BUFFALO: 'भैंस', SQUIRREL: 'गिलहरी', DOG: 'कुत्ता', CAT: 'बिल्ली', MOUSE: 'चूहा',

  // fruit
  MANGO: 'आम', BANANA: 'केला', GUAVA: 'अमरूद', PAPAYA: 'पपीता', APPLE: 'सेब',
  ORANGE: 'संतरा', GRAPES: 'अंगूर', LYCHEE: 'लीची', JACKFRUIT: 'कटहल',
  POMEGRANATE: 'अनार', WATERMELON: 'तरबूज', COCONUT: 'नारियल', LEMON: 'नींबू',
  CHIKOO: 'चीकू', 'CUSTARD APPLE': 'सीताफल',

  // food
  IDLI: 'इडली', DOSA: 'डोसा', SAMOSA: 'समोसा', BIRYANI: 'बिरयानी', ROTI: 'रोटी',
  PANEER: 'पनीर', LADDU: 'लड्डू', JALEBI: 'जलेबी', VADA: 'वड़ा', UPMA: 'उपमा',
  CHAPATI: 'चपाती', PONGAL: 'पोंगल', HALWA: 'हलवा', KHEER: 'खीर', PURI: 'पूरी',
  RICE: 'चावल', DAL: 'दाल', CURD: 'दही', PICKLE: 'अचार', CHUTNEY: 'चटनी',

  // colours
  RED: 'लाल', GREEN: 'हरा', BLUE: 'नीला', YELLOW: 'पीला', PURPLE: 'बैंगनी',
  PINK: 'गुलाबी', BROWN: 'भूरा', BLACK: 'काला', WHITE: 'सफ़ेद', GREY: 'स्लेटी',
  GOLDEN: 'सुनहरा',

  // cities
  MUMBAI: 'मुंबई', DELHI: 'दिल्ली', CHENNAI: 'चेन्नई', KOLKATA: 'कोलकाता',
  BENGALURU: 'बेंगलुरु', HYDERABAD: 'हैदराबाद', PUNE: 'पुणे', JAIPUR: 'जयपुर',
  KOCHI: 'कोच्चि', LUCKNOW: 'लखनऊ', INDORE: 'इंदौर', SURAT: 'सूरत',
  NAGPUR: 'नागपुर', MYSURU: 'मैसूरु', PATNA: 'पटना',

  // festivals
  DIWALI: 'दिवाली', HOLI: 'होली', ONAM: 'ओणम', NAVRATRI: 'नवरात्रि',
  DUSSEHRA: 'दशहरा', BAISAKHI: 'बैसाखी', UGADI: 'उगादी', LOHRI: 'लोहड़ी',
  EID: 'ईद', CHRISTMAS: 'क्रिसमस',

  // vehicles
  AUTO: 'ऑटो', BUS: 'बस', TRAIN: 'ट्रेन', CYCLE: 'साइकिल', SCOOTER: 'स्कूटर',
  TRUCK: 'ट्रक', METRO: 'मेट्रो', RICKSHAW: 'रिक्शा', BOAT: 'नाव',
  TRACTOR: 'ट्रैक्टर', JEEP: 'जीप',

  // body
  HAND: 'हाथ', NOSE: 'नाक', EAR: 'कान', EYE: 'आँख', FOOT: 'पैर', KNEE: 'घुटना',
  ELBOW: 'कोहनी', THUMB: 'अंगूठा', TOOTH: 'दाँत', HAIR: 'बाल', FINGER: 'उँगली',

  // shapes
  CIRCLE: 'गोल', SQUARE: 'चौकोर', TRIANGLE: 'त्रिभुज', STAR: 'तारा',
  DIAMOND: 'हीरा', OVAL: 'अंडाकार', ARROW: 'तीर', CROSS: 'क्रॉस',
  HEART: 'दिल', CUBE: 'घन',

  // nature
  RIVER: 'नदी', MOUNTAIN: 'पहाड़', CLOUD: 'बादल', RAIN: 'बारिश', SAND: 'रेत',
  FOREST: 'जंगल', LEAF: 'पत्ता', FLOWER: 'फूल', STONE: 'पत्थर', WIND: 'हवा',
  SUN: 'सूरज', MOON: 'चाँद',

  // home
  DOOR: 'दरवाज़ा', WINDOW: 'खिड़की', CHAIR: 'कुर्सी', TABLE: 'मेज़',
  SPOON: 'चम्मच', PLATE: 'थाली', CLOCK: 'घड़ी', MIRROR: 'आईना',
  PILLOW: 'तकिया', BUCKET: 'बाल्टी', BROOM: 'झाड़ू', LAMP: 'दीया',

  // school
  PENCIL: 'पेंसिल', BOOK: 'किताब', CHALK: 'चॉक', BAG: 'बैग', RULER: 'पैमाना',
  ERASER: 'रबर', BENCH: 'बेंच', SLATE: 'स्लेट', PEN: 'कलम', MAP: 'नक्शा',

  // cricket
  BAT: 'बल्ला', BALL: 'गेंद', STUMPS: 'स्टंप', SIXER: 'छक्का', CATCH: 'कैच',
  PITCH: 'पिच', OVER: 'ओवर', RUNOUT: 'रनआउट', HELMET: 'हेलमेट', CREASE: 'क्रीज़',

  // weather
  SUNNY: 'धूप', RAINY: 'बरसात', CLOUDY: 'बादल भरा', STORM: 'तूफ़ान',
  THUNDER: 'गरज', FOG: 'कोहरा', BREEZE: 'हवा', HAIL: 'ओले', DEW: 'ओस',
  FROST: 'पाला',

  // music
  DRUM: 'ढोलक', FLUTE: 'बाँसुरी', VEENA: 'वीणा', TABLA: 'तबला', SITAR: 'सितार',
  DHOL: 'ढोल', BELL: 'घंटी', WHISTLE: 'सीटी', SONG: 'गाना', BEAT: 'ताल',

  // clothes
  SAREE: 'साड़ी', KURTA: 'कुर्ता', SHIRT: 'कमीज़', SHAWL: 'शॉल', SCARF: 'दुपट्टा',
  SOCKS: 'मोज़े', BANGLE: 'चूड़ी', TURBAN: 'पगड़ी', DHOTI: 'धोती',
  LEHENGA: 'लहँगा',

  // work
  FARMER: 'किसान', DOCTOR: 'डॉक्टर', TEACHER: 'शिक्षक', DRIVER: 'ड्राइवर',
  TAILOR: 'दर्जी', BARBER: 'नाई', POTTER: 'कुम्हार', WEAVER: 'बुनकर',
  GUARD: 'चौकीदार', COOK: 'रसोइया',

  // time
  MORNING: 'सुबह', NOON: 'दोपहर', EVENING: 'शाम', NIGHT: 'रात', TODAY: 'आज',
  TOMORROW: 'कल', MONDAY: 'सोमवार', FRIDAY: 'शुक्रवार', SUNDAY: 'रविवार',
  MONTH: 'महीना',

  // places
  TEMPLE: 'मंदिर', MARKET: 'बाज़ार', STATION: 'स्टेशन', GARDEN: 'बगीचा',
  SCHOOL: 'स्कूल', HOSPITAL: 'अस्पताल', BRIDGE: 'पुल', FIELD: 'खेत',
  SHOP: 'दुकान', OFFICE: 'दफ़्तर',

  // the lookalike set - translated honestly, losing the spelling joke
  CAP: 'टोपी', PIN: 'पिन', DOOM: 'विनाश', START: 'शुरू', RISE: 'उदय',
  BAND: 'बैंड', LEAP: 'छलाँग', CROWN: 'ताज', BOOT: 'जूता', IRON: 'लोहा',
  ROTA: 'बारी', BLOCK: 'ब्लॉक',

  // number words, which appear as options beside their digits
  ONE: 'एक', TWO: 'दो', THREE: 'तीन', FOUR: 'चार', FIVE: 'पाँच', SIX: 'छह',
  SEVEN: 'सात', EIGHT: 'आठ', NINE: 'नौ', TEN: 'दस', ELEVEN: 'ग्यारह',
  TWELVE: 'बारह',

  // position words - the mode where the WORD matters, never the slot
  LEFT: 'बाएँ', MIDDLE: 'बीच', RIGHT: 'दाएँ',
};

/** One option, in Hindi. Digits become Devanagari; anything unknown stays. */
export function word(token) {
  const key = String(token).trim().toUpperCase();
  if (WORDS[key]) return WORDS[key];
  if (/^[0-9]+$/.test(key)) return toDevanagari(key);
  return token;
}

/**
 * The instruction, rebuilt around the Hindi word.
 *
 * The bank's `instruction_hi` keeps the target in English ("SCOOTER पर टैप
 * करें") because it was generated before this lexicon existed. Rebuilding from
 * the English instruction here means one place decides how a sentence reads,
 * and the bank never has to be regenerated to fix a phrase.
 */
export function instruction(en) {
  let m;
  if ((m = en.match(/^TAP THE WORD (.+)$/))) {
    return `जिस पर लिखा है "${word(m[1])}" उस पर टैप करें`;
  }
  if ((m = en.match(/^DON'T TAP IF YOU SEE (.+)$/))) {
    return `अगर "${word(m[1])}" दिखे तो कुछ भी टैप न करें`;
  }
  if ((m = en.match(/^TAP BOTH EXCEPT (.+)$/))) {
    return `"${word(m[1])}" को छोड़कर बाकी दोनों पर टैप करें`;
  }
  const RULES = {
    'TAP THE ANIMAL': 'जानवर पर टैप करें',
    'TAP THE FRUIT': 'फल पर टैप करें',
    'TAP THE COLOUR': 'रंग पर टैप करें',
    'TAP THE CITY': 'शहर पर टैप करें',
    'TAP THE FESTIVAL': 'त्योहार पर टैप करें',
    'TAP THE VEHICLE': 'वाहन पर टैप करें',
    'TAP THE SHAPE': 'आकृति पर टैप करें',
    'TAP THE ODD NUMBER': 'विषम संख्या पर टैप करें',
    'TAP THE EVEN NUMBER': 'सम संख्या पर टैप करें',
    'TAP THE BIGGEST NUMBER': 'सबसे बड़ी संख्या पर टैप करें',
    'TAP THE SMALLEST NUMBER': 'सबसे छोटी संख्या पर टैप करें',
  };
  if (RULES[en]) return RULES[en];
  if ((m = en.match(/^TAP (.+)$/))) return `"${word(m[1])}" पर टैप करें`;
  return en;
}

/** Everything the page shows for one question, in Hindi. */
export function localise(question) {
  return {
    ...question,
    instruction: instruction(question.instruction),
    options: question.options.map(word),
  };
}

/** The page's own furniture. Kept beside the words it sits among. */
export const UI = {
  ready: 'शुरू करें',
  play: 'खेलें',
  getReady: 'तैयार हो जाइए',
  go: 'चलो!',
  secondsLeft: 'सेकंड बचे',
  tapBoth: 'दोनों पर टैप करें',
  right: 'सही!',
  held: 'रुक गए! 🧊',
  missed: 'चूक गए',
  outOfTime: 'समय समाप्त',
  tooSoon: 'बहुत जल्दी — वह अंदाज़ा था, जवाब नहीं',
  notThatOne: 'यह नहीं',
  trapLine: 'यह जाल था — सही जवाब था कुछ भी न छूना',
  holdWorked: 'कुछ न छूना ही सही जवाब था',
  inARow: 'लगातार',
  ms: 'मि.से.',
};
