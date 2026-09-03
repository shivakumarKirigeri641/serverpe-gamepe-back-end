/**
 * The policies, read from and written to the database.
 *
 * ── Why these moved out of a page template ─────────────────────────────────
 *
 * They used to be hardcoded inside policies-page.js. Meta reviews these pages
 * before approving a WhatsApp business app, Razorpay reviews them before
 * enabling payments, and both come back with wording changes. A deploy to fix
 * a sentence in a privacy policy is the wrong shape of work, and it meant the
 * admin panel's Documents screen had nothing real to show.
 *
 * ── Why they are split ────────────────────────────────────────────────────
 *
 * There was one combined "Terms, Privacy & Fair Play" document. Meta asks for
 * a Privacy Policy URL specifically, and a reviewer following a link labelled
 * "terms" to find privacy buried in the middle is a reason to fail a review.
 * They are now separate documents with their own URLs, which is also what a
 * data-deletion link needs to be.
 *
 * ── Seeding ───────────────────────────────────────────────────────────────
 *
 * `ensureDocuments()` inserts any missing document and never overwrites one
 * that exists. That is what lets a running deployment pick these up on
 * restart with no manual SQL, and what stops a deploy from silently reverting
 * wording an operator edited in the panel.
 */
import { query } from '../db/pool.js';
import { config } from '../config/env.js';
import { log } from '../utils/logger.js';

/**
 * The version consent is recorded against.
 *
 * Only the documents marked requiresConsent matter here. Bumping it asks every
 * player to agree again on their next message, so it is changed by hand when
 * the terms change materially - not on every typo fix.
 */
export const POLICY_VERSION = '2026-09-01';

const brand = () => config.brandName;
const company = () => config.business?.legalName || 'ServerPe App Solutions';
const support = () => config.mail?.supportInbox || 'support@mastipe.in';

/**
 * The starting text for each document.
 *
 * Written as plain text on purpose: blank lines separate paragraphs, lines
 * beginning "- " are bullets, and lines ending ":" read as small headings.
 * Every surface renders from this one shape, and none of them has to trust
 * stored HTML.
 */
function defaults() {
  return [
    {
      doc_key: 'terms',
      title: `Terms of Use`,
      summary: 'The rules of play, and what you agree to when you join a game.',
      requires_consent: true,
      sort_order: 10,
      body: `${brand()} is an entertainment platform operated by ${company()}. By playing, you agree to these terms.

Entertainment only:

- ${brand()} is a game. There is no real-money gambling, no betting, and no cash prizes.
- Nothing you win has monetary value.

Playing fairly:

- Prizes are validated against the numbers actually called, never against what you marked. A wrong tap costs you nothing.
- Each prize can be won only once per game.
- Cheating, abuse or harassment means removal from the platform.

How a game runs:

- The host chooses how many players and starts the game. After that ${brand()} calls the numbers, and the host plays as an ordinary player.
- Once a game starts, nobody else can join it.
- If you leave a game you cannot rejoin it. If leaving drops the table below two players, the game ends for everyone.

Availability:

- We may change, suspend or withdraw the service at any time.
- These terms may change. The version below is the one you agreed to; a material change asks you to agree again.

Questions: message us on WhatsApp, or write to ${support()}.`,
    },
    {
      doc_key: 'privacy',
      title: 'Privacy Policy',
      summary: 'What we store, why we store it, and what we never do with it.',
      requires_consent: true,
      sort_order: 20,
      body: `${company()} operates ${brand()}. This policy explains what we collect and why.

What we store, and why:

- Your WhatsApp number. It is how we know which ticket is yours.
- Your WhatsApp profile name, if you have one set, so other players see a name rather than a number.
- Your tickets, the numbers called, your taps and your prize claims, so a game can be replayed if a result is ever disputed.
- Messages between you and our bot, so we can answer a support question about them.

When you open your game board in a browser we also record:

- Your IP address, and an approximate city derived from it.
- Your device type, operating system and browser.

We use that to keep games fair and to work out why a board dropped out mid-game. WhatsApp messages themselves carry no address or device information, so a player who never opens a board has none of this recorded.

What we never do:

- We do not sell or rent your data.
- We do not share it with advertisers.
- We do not message you outside a game you joined, other than to answer you.
- We never show your full number to other players.

How long we keep it:

- Game records are kept so results can be checked and reports reproduced.
- Message contents are kept only as long as they are useful for support, and are cleared on a schedule after that.

Your choices:

- You can ask for your data to be deleted at any time. See the Data Deletion policy.
- You can ask what we hold about you by writing to ${support()}.

Contact: ${support()}.`,
    },
    {
      doc_key: 'data-deletion',
      title: 'Data Deletion',
      summary: 'How to have your account and history removed.',
      requires_consent: false,
      sort_order: 30,
      body: `You can have everything we hold about you deleted.

How to ask:

- Message "delete my data" to us on WhatsApp, from the number you play with.
- Or write to ${support()} from any address, telling us the WhatsApp number to remove.

What happens:

- Your player record, tickets, game history, claims, messages and consent records are removed.
- Games you took part in remain, but with your rows removed, so other players' reports still work.
- We confirm on WhatsApp once it is done.

How long it takes: normally within 7 days, and no more than 30.

Anything we must keep: if a record is needed to meet a legal or tax obligation, we keep only that record and only for as long as the law requires.

Contact: ${support()}.`,
    },
    {
      doc_key: 'fair-play',
      title: 'Fair Play',
      summary: 'How prizes are decided, and what happens to cheating.',
      requires_consent: false,
      sort_order: 40,
      body: `Tambola only works if everyone trusts the result.

How numbers are drawn:

- All 90 numbers are shuffled once, when the game is created, and stored with the game.
- They are called in that fixed order. A delay or a reconnection cannot reorder them, and any disputed game can be replayed exactly.

How prizes are decided:

- A claim is checked against the numbers actually called, not against what you marked on your ticket.
- Marking a number you do not have costs you nothing. Missing one you do have costs you the chance at a prize.
- Where two players claim the same prize at the same moment, the database decides one winner. There is no second award.

What is not allowed:

- Using more than one number to take extra tickets in the same game.
- Abuse or harassment of other players.

Either means removal from the platform.

Questions about a specific game: message us with the room code and we will look at the record.`,
    },
  ];
}

/**
 * Inserts any document that does not exist yet. Never overwrites.
 *
 * Safe to call on every boot: an operator's edits in the admin panel survive a
 * deploy, and a new document added in code appears without manual SQL.
 */
export async function ensureDocuments() {
  let added = 0;
  for (const d of defaults()) {
    // Checked with a SELECT rather than ON CONFLICT.
    //
    // ON CONFLICT (doc_key, lang) needs a unique constraint on exactly that
    // pair. A deployment carrying an older version of this table has UNIQUE
    // (doc_key) instead, and Postgres rejects the statement outright rather
    // than falling back - so the seeding, and therefore the policy pages,
    // failed on precisely the databases that most needed seeding.
    //
    // This runs once at boot in a single process, so the read-then-write is
    // not a race worth defending against.
    const { rows } = await query(
      'SELECT 1 FROM legal_documents WHERE doc_key = $1 AND COALESCE(lang, $2) = $2 LIMIT 1',
      [d.doc_key, 'en'],
    );
    if (rows.length) {
      // The row exists, so its words are left alone - they may be the ones a
      // reviewer already read. Only the display order is aligned, and only on
      // a row nobody has edited: a table carried over from an older schema had
      // no sort_order at all, which left Privacy sorting below Fair Play.
      await query(
        `UPDATE legal_documents
            SET sort_order = $2
          WHERE doc_key = $1
            AND updated_by IS DISTINCT FROM 'admin'
            AND sort_order IS DISTINCT FROM $2`,
        [d.doc_key, d.sort_order],
      );
      continue;
    }

    await query(
      `INSERT INTO legal_documents
         (doc_key, lang, title, summary, body, version, requires_consent, sort_order, updated_by)
       VALUES ($1, 'en', $2, $3, $4, $5, $6, $7, 'seed')`,
      [d.doc_key, d.title, d.summary, d.body, POLICY_VERSION, d.requires_consent, d.sort_order],
    );
    added++;
  }
  if (added) log.info('legal documents seeded', { added });
  return { added };
}

/** Every active document, for the site and the in-WhatsApp page. */
export async function listDocuments(lang = 'en') {
  const { rows } = await query(
    `SELECT doc_key, lang, title, summary, body, version,
            requires_consent, is_active, sort_order, updated_at, updated_by
       FROM legal_documents
      WHERE is_active AND lang = $1
      ORDER BY sort_order, doc_key`,
    [lang === 'hi' ? 'hi' : 'en'],
  );

  // Falls back to English rather than showing a Hindi speaker an empty page.
  // `translated` lets the reader know which they are looking at.
  if (!rows.length && lang === 'hi') {
    const en = await listDocuments('en');
    return en.map((d) => ({ ...d, translated: false }));
  }

  return rows.map((d) => ({
    ...d,
    // The marketing site reads `key`; the admin panel and the older API shape
    // read `doc_key`. Both are sent so neither has to change to match the
    // other - the mismatch between them is what left /policies blank.
    key: d.doc_key,
    translated: true,
  }));
}

/**
 * Underscores and hyphens are treated as the same character.
 *
 * The keys are hyphenated, but /policies/data_deletion was already registered
 * with Meta before that was settled. Meta re-reviews a changed URL, so the old
 * form keeps resolving rather than 404ing a link somebody official is holding.
 */
const sameKey = (a, b) =>
  String(a).replace(/_/g, '-').toLowerCase() === String(b).replace(/_/g, '-').toLowerCase();

export async function getDocument(docKey, lang = 'en') {
  const docs = await listDocuments(lang);
  return docs.find((d) => sameKey(d.doc_key, docKey)) ?? null;
}

/** Edited from the admin panel. Only the words and the flags, never the key. */
export async function updateDocument(docKey, lang, patch, by) {
  const { rows } = await query(
    `UPDATE legal_documents
        SET title      = COALESCE($3, title),
            summary    = COALESCE($4, summary),
            body       = COALESCE($5, body),
            version    = COALESCE($6, version),
            is_active  = COALESCE($7, is_active),
            updated_at = now(),
            updated_by = $8
      WHERE doc_key = $1 AND lang = $2
      RETURNING doc_key, lang, title, version, updated_at`,
    [
      docKey, lang === 'hi' ? 'hi' : 'en',
      patch.title ?? null, patch.summary ?? null, patch.body ?? null,
      patch.version ?? null,
      typeof patch.isActive === 'boolean' ? patch.isActive : null,
      by ?? 'admin',
    ],
  );
  if (!rows[0]) return null;
  log.info('legal document updated', { docKey, lang, by });
  return rows[0];
}
