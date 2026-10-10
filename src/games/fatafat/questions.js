/**
 * Fatafat's question bank.
 *
 * ── Why a CSV and not a table ─────────────────────────────────────────────
 *
 * The bank is fixed content, not state. Nothing writes to it, every row is
 * identical on every deployment, and shipping it in the repo means a question
 * can be read, corrected and reviewed in a diff. Putting it in Postgres would
 * add a migration to every wording fix and a query to every round.
 *
 * It is read once at boot and held in memory - 19,300 rows is a few megabytes,
 * and a round has to assemble ten questions inside a WhatsApp reply.
 *
 * ── The five modes ────────────────────────────────────────────────────────
 *
 *   go        TAP MANGO                    one right option
 *   position  TAP THE WORD RIGHT           the word, never the slot
 *   rule      TAP THE ANIMAL               one option qualifies
 *   except    TAP BOTH EXCEPT MANGO        two taps, either order
 *   hold      DON'T TAP IF YOU SEE MANGO   touch nothing at all
 *
 * `hold` is the one that makes the game a game. When the forbidden word is on
 * screen the correct answer is to touch nothing and let the clock run out, so
 * a player who panics and taps is wrong - there is no free two-thirds. When it
 * is absent, any tap is right. `correctPositions` carries both cases: an empty
 * array means touch nothing, [1,2,3] means anything will do.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The only quoted field in the file is correct_positions ("1,3"), so a full
 * CSV parser would be a dependency earning nothing.
 */
function cells(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === ',' && !quoted) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function load() {
  const text = readFileSync(join(here, 'bank.csv'), 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const head = cells(lines[0]);
  const at = (name) => head.indexOf(name);
  const [ID, SET, DIFF, LIMIT, MODE, EN, HI, O1, O2, O3, CORRECT, CAT, TRAP, TWIST, POINTS] =
    ['question_id','set','difficulty','time_limit_ms','mode','instruction_en','instruction_hi',
     'option_1','option_2','option_3','correct_positions','category','trap','twist_eligible','points'].map(at);

  return lines.slice(1).map((line) => {
    const c = cells(line);
    return {
      id: c[ID],
      set: c[SET],
      difficulty: Number(c[DIFF]),
      bankTimeLimitMs: Number(c[LIMIT]),
      mode: c[MODE],
      instruction: c[EN],
      instructionHi: c[HI],
      options: [c[O1], c[O2], c[O3]],
      // Empty string means "touch nothing" - not "no answer recorded".
      correctPositions: c[CORRECT] === '' ? [] : c[CORRECT].split(',').map(Number),
      category: c[CAT],
      trap: c[TRAP],
      twistEligible: c[TWIST] === 'yes',
      points: Number(c[POINTS]),
    };
  });
}

let bank = null;
export function allQuestions() {
  if (!bank) bank = load();
  return bank;
}

let index = null;
/** By id, for rebuilding a round from what was written down. */
export function questionById(id) {
  if (!index) {
    index = new Map();
    for (const q of allQuestions()) index.set(q.id, q);
  }
  return index.get(id) ?? null;
}

/** How many questions exist, for working out when somebody has seen them all. */
export const bankSize = () => allQuestions().length;

/** A no-go is a hold question whose forbidden word is actually on screen. */
export const isNoGo = (q) => q.mode === 'hold' && q.correctPositions.length === 0;

/**
 * Deterministic PRNG.
 *
 * A round stores its seed rather than its questions, so the same round always
 * rebuilds identically - which is what lets a disputed score be replayed, and
 * what keeps the answers table free of a copy of the bank.
 */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * The ten questions of one round.
 *
 * Shaped rather than sampled. Left to chance, one round in eight would contain
 * no no-go at all - and a Fatafat round with nothing to resist is just a
 * tapping drill. So: difficulty ramps, at least two no-go questions, at least
 * one twist-eligible question, and never the same question twice.
 */
const RAMP = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5];

export function buildRound(seed, count = 10, seen = null) {
  const rand = rng(seed);
  const pool = allQuestions();
  // Everything this player has already been asked. Sampling at random from
  // 19,300 rows would repeat sooner than people expect - the birthday problem
  // makes a repeat likely within about 200 questions, which is twenty rounds.
  const unseen = (q) => !seen || !seen.has(q.id);
  const pick = (test) => {
    // Bounded: a filter over 19,300 rows per question would cost more than the
    // rest of the round put together.
    for (let i = 0; i < 400; i++) {
      const q = pool[Math.floor(rand() * pool.length)];
      if (unseen(q) && test(q)) return q;
    }
    return null;
  };

  const chosen = [];
  const used = new Set();
  const take = (q) => { if (q && !used.has(q.id)) { used.add(q.id); chosen.push(q); return true; } return false; };

  const ramp = RAMP.slice(0, count);
  // Two guaranteed no-go questions, placed away from the opening so the player
  // learns the rhythm before it is broken.
  const noGoAt = new Set([Math.max(2, Math.floor(count * 0.4)), count - 2]);
  const twistAt = Math.max(3, Math.floor(count * 0.7));

  for (let i = 0; i < ramp.length; i++) {
    const want = ramp[i];
    const near = (q) => Math.abs(q.difficulty - want) <= 1;
    let q = null;
    if (noGoAt.has(i)) q = pick((x) => isNoGo(x) && near(x) && !used.has(x.id));
    else if (i === twistAt) q = pick((x) => x.twistEligible && near(x) && !used.has(x.id));
    if (!q) q = pick((x) => near(x) && !used.has(x.id));
    if (!q) q = pick((x) => !used.has(x.id));
    // Last resort: somebody has worked through the whole bank. Better a repeat
    // than a round of nine questions, and the caller is told it happened.
    if (!q) { for (const x of pool) { if (!used.has(x.id)) { q = x; break; } } }
    take(q);
  }

  return chosen.map((q, i) => ({ ...q, seq: i + 1, twist: i === twistAt && q.twistEligible }));
}
