import { query, queryOne, withTransaction, type Queryable } from '../db/pool.js';
import { EVENT, track } from './analytics.service.js';

/**
 * Legal documents and player consent.
 *
 * Content is never hard-coded: every title, summary and body comes from
 * `legal_documents`, so the admin panel can edit the wording without a deploy.
 * Bumping a document's `version` invalidates existing consent for it and forces
 * every player to accept again before their next game.
 */

export interface LegalDocument {
  id: string;
  doc_key: string;
  title: string;
  summary: string;
  body: string;
  /**
   * Hindi, when it has been written. Null is normal and not a fault: the
   * English is the fallback, so a policy change can go live immediately and be
   * translated afterwards rather than the page breaking in the meantime.
   *
   * English remains the legally operative text, and the page says so.
   */
  title_hi: string | null;
  summary_hi: string | null;
  body_hi: string | null;
  version: number;
  display_order: number;
  requires_consent: boolean;
  is_active: boolean;
}

const DOC_COLUMNS = `id, doc_key, title, summary, body,
  title_hi, summary_hi, body_hi, version, display_order,
  requires_consent, is_active`;

export async function listActiveDocuments(client?: Queryable): Promise<LegalDocument[]> {
  return query<LegalDocument>(
    `SELECT ${DOC_COLUMNS} FROM legal_documents
      WHERE is_active AND effective_from <= now()
      ORDER BY display_order, title`,
    [],
    client,
  );
}

export async function getDocument(docKey: string, client?: Queryable): Promise<LegalDocument | null> {
  return queryOne<LegalDocument>(
    `SELECT ${DOC_COLUMNS} FROM legal_documents WHERE doc_key = $1`,
    [docKey],
    client,
  );
}

/**
 * Documents the player still has to accept: active, consent-requiring, and
 * either never accepted or accepted at an older version.
 */
export async function pendingDocuments(playerId: string, client?: Queryable): Promise<LegalDocument[]> {
  return query<LegalDocument>(
    `SELECT ${DOC_COLUMNS}
       FROM legal_documents d
      WHERE d.is_active
        AND d.requires_consent
        AND d.effective_from <= now()
        AND NOT EXISTS (
          SELECT 1 FROM player_consents c
           WHERE c.player_id = $1
             AND c.doc_key = d.doc_key
             AND c.version = d.version
        )
      ORDER BY d.display_order, d.title`,
    [playerId],
    client,
  );
}

export async function hasAcceptedAll(playerId: string, client?: Queryable): Promise<boolean> {
  return (await pendingDocuments(playerId, client)).length === 0;
}

export interface ConsentSource {
  source?: 'whatsapp' | 'flow' | 'admin';
  waMessageId?: string | null;
  requestIp?: string | null;
  userAgent?: string | null;
}

/**
 * Records acceptance of every currently pending document in one transaction.
 *
 * Acceptance is all-or-nothing by design: the player is shown the full set and
 * agrees to the set, so a partial record would misrepresent what they saw.
 */
export async function acceptAllPending(
  playerId: string,
  ctx: ConsentSource = {},
): Promise<LegalDocument[]> {
  const accepted = await withTransaction(async (client) => {
    const pending = await pendingDocuments(playerId, client);

    for (const doc of pending) {
      await query(
        `INSERT INTO player_consents
           (player_id, document_id, doc_key, version, source, wa_message_id, request_ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (player_id, doc_key, version) DO NOTHING`,
        [
          playerId,
          doc.id,
          doc.doc_key,
          doc.version,
          ctx.source ?? 'whatsapp',
          ctx.waMessageId ?? null,
          ctx.requestIp ?? null,
          ctx.userAgent ?? null,
        ],
        client,
      );
    }

    return pending;
  });

  if (accepted.length > 0) {
    await track({
      type: EVENT.CONSENT_ACCEPTED,
      source: ctx.source === 'admin' ? 'admin' : 'whatsapp',
      playerId,
      properties: {
        documents: accepted.map((d) => ({ key: d.doc_key, version: d.version })),
        count: accepted.length,
      },
    });
  }

  return accepted;
}

export interface ConsentRecord {
  doc_key: string;
  title: string;
  version: number;
  accepted_at: Date;
  source: string;
  is_current: boolean;
}

/** Everything this player has ever agreed to, newest first. */
export async function listPlayerConsents(playerId: string): Promise<ConsentRecord[]> {
  return query<ConsentRecord>(
    `SELECT c.doc_key, COALESCE(d.title, c.doc_key) AS title, c.version, c.accepted_at, c.source,
            (d.version = c.version AND d.is_active) AS is_current
       FROM player_consents c
       LEFT JOIN legal_documents d ON d.doc_key = c.doc_key
      WHERE c.player_id = $1
      ORDER BY c.accepted_at DESC`,
    [playerId],
  );
}

/* ------------------------------------------------------ admin-side editing */

export interface DocumentInput {
  doc_key: string;
  title: string;
  summary: string;
  body: string;
  display_order?: number;
  requires_consent?: boolean;
  is_active?: boolean;
  /** Set true when the change is material enough to require re-acceptance. */
  bumpVersion?: boolean;
}

/**
 * Creates or updates a document from the admin panel.
 *
 * `bumpVersion` is the important switch: a typo fix should leave existing
 * consent intact, while a change of substance must invalidate it. That is a
 * judgement only a person can make, so it is never inferred.
 */
export async function upsertDocument(input: DocumentInput): Promise<LegalDocument> {
  const existing = await getDocument(input.doc_key);

  if (!existing) {
    const row = await queryOne<LegalDocument>(
      `INSERT INTO legal_documents
         (doc_key, title, summary, body, display_order, requires_consent, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${DOC_COLUMNS}`,
      [
        input.doc_key,
        input.title,
        input.summary,
        input.body,
        input.display_order ?? 99,
        input.requires_consent ?? true,
        input.is_active ?? true,
      ],
    );
    if (!row) throw new Error(`Failed to create document ${input.doc_key}`);
    return row;
  }

  const row = await queryOne<LegalDocument>(
    `UPDATE legal_documents
        SET title = $2,
            summary = $3,
            body = $4,
            display_order = COALESCE($5, display_order),
            requires_consent = COALESCE($6, requires_consent),
            is_active = COALESCE($7, is_active),
            version = version + CASE WHEN $8::boolean THEN 1 ELSE 0 END,
            effective_from = CASE WHEN $8::boolean THEN now() ELSE effective_from END,
            updated_at = now()
      WHERE doc_key = $1
      RETURNING ${DOC_COLUMNS}`,
    [
      input.doc_key,
      input.title,
      input.summary,
      input.body,
      input.display_order ?? null,
      input.requires_consent ?? null,
      input.is_active ?? null,
      input.bumpVersion ?? false,
    ],
  );
  if (!row) throw new Error(`Failed to update document ${input.doc_key}`);
  return row;
}

export async function listAllDocuments(): Promise<LegalDocument[]> {
  return query<LegalDocument>(
    `SELECT ${DOC_COLUMNS} FROM legal_documents ORDER BY display_order, title`,
  );
}

/** Adoption per document — how many players are on the current version. */
export async function consentStats(): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT d.doc_key, d.title, d.version AS current_version, d.requires_consent, d.is_active,
            count(c.id) FILTER (WHERE c.version = d.version)::int AS accepted_current,
            count(c.id)::int AS accepted_any_version
       FROM legal_documents d
       LEFT JOIN player_consents c ON c.doc_key = d.doc_key
      GROUP BY d.doc_key, d.title, d.version, d.requires_consent, d.is_active, d.display_order
      ORDER BY d.display_order`,
  );
}
