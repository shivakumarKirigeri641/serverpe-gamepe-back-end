import { query, queryOne } from '../db/pool.js';

/**
 * The company behind the product.
 *
 * Read by the marketing site, the admin panel and (later) invoices, so it lives
 * in one row in the database rather than being repeated in three codebases.
 */

export interface BusinessProfile {
  legal_name: string;
  trade_name: string;
  owner_name: string;
  support_email: string;
  support_phone: string | null;
  gstin: string | null;
  pan: string | null;
  address_line1: string;
  address_line2: string | null;
  city: string;
  state: string | null;
  postal_code: string | null;
  country: string;
  website: string | null;
  gst_rate_bp: number;
  prices_include_gst: boolean;
}

const COLUMNS = `legal_name, trade_name, owner_name, support_email, support_phone, gstin, pan,
  address_line1, address_line2, city, state, postal_code, country, website,
  gst_rate_bp, prices_include_gst`;

export async function getBusinessProfile(): Promise<BusinessProfile | null> {
  return queryOne<BusinessProfile>(
    `SELECT ${COLUMNS} FROM business_profile WHERE is_active LIMIT 1`,
  );
}

/** One-line postal address, for footers and invoices. */
export function formatAddress(p: BusinessProfile): string {
  return [p.address_line1, p.address_line2, p.city, p.state, p.postal_code, p.country]
    .filter(Boolean)
    .join(', ');
}

/**
 * What the marketing site is allowed to read.
 *
 * Deliberately narrower than the full row: a public page needs the address and
 * the GSTIN for compliance, but nothing else the table might grow later.
 */
export async function getPublicBusinessProfile(): Promise<Record<string, unknown> | null> {
  const p = await getBusinessProfile();
  if (!p) return null;

  return {
    legalName: p.legal_name,
    tradeName: p.trade_name,
    ownerName: p.owner_name,
    supportEmail: p.support_email,
    supportPhone: p.support_phone,
    gstin: p.gstin,
    address: {
      line1: p.address_line1,
      line2: p.address_line2,
      city: p.city,
      state: p.state,
      postalCode: p.postal_code,
      country: p.country,
      formatted: formatAddress(p),
    },
    website: p.website,
  };
}

export interface BusinessProfileInput {
  legal_name?: string;
  trade_name?: string;
  owner_name?: string;
  support_email?: string;
  support_phone?: string | null;
  gstin?: string | null;
  pan?: string | null;
  address_line1?: string;
  address_line2?: string | null;
  city?: string;
  state?: string | null;
  postal_code?: string | null;
  country?: string;
  website?: string | null;
  gst_rate_bp?: number;
  prices_include_gst?: boolean;
}

/** Updates the active profile in place; the admin panel is the only caller. */
export async function updateBusinessProfile(input: BusinessProfileInput): Promise<BusinessProfile | null> {
  const fields = Object.keys(input) as Array<keyof BusinessProfileInput>;
  if (fields.length === 0) return getBusinessProfile();

  const assignments = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
  const values = fields.map((f) => input[f]);

  return queryOne<BusinessProfile>(
    `UPDATE business_profile SET ${assignments}, updated_at = now()
      WHERE is_active
      RETURNING ${COLUMNS}`,
    values,
  );
}

/* ---------------------------------------------------------------- GST maths */

export interface MoneyBreakdown {
  grossPaise: number;
  netPaise: number;
  gstPaise: number;
  gstRatePct: number;
}

/**
 * Splits an amount into net and GST.
 *
 * Which way round depends on `prices_include_gst`: a price advertised as "Rs.49
 * inclusive" already contains the tax and has to be worked backwards, whereas
 * an exclusive price has tax added on top. Getting this backwards understates
 * or overstates revenue by 18%, so it is a setting rather than an assumption.
 */
export function splitGst(amountPaise: number, profile: BusinessProfile): MoneyBreakdown {
  const rate = profile.gst_rate_bp / 10_000;

  if (profile.prices_include_gst) {
    const net = Math.round(amountPaise / (1 + rate));
    return {
      grossPaise: amountPaise,
      netPaise: net,
      gstPaise: amountPaise - net,
      gstRatePct: profile.gst_rate_bp / 100,
    };
  }

  const gst = Math.round(amountPaise * rate);
  return {
    grossPaise: amountPaise + gst,
    netPaise: amountPaise,
    gstPaise: gst,
    gstRatePct: profile.gst_rate_bp / 100,
  };
}

/** Revenue by day, split for GST, from the games actually played. */
export async function revenueByDay(from: string, to: string): Promise<Record<string, unknown>[]> {
  const profile = await getBusinessProfile();

  const rows = await query<{ day: string; games: string; gross: string }>(
    `SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day,
            count(*)::text AS games,
            COALESCE(sum(plan_price_paise), 0)::text AS gross
       FROM games
      WHERE created_at::date BETWEEN $1::date AND $2::date
      GROUP BY 1 ORDER BY 1`,
    [from, to],
  );

  return rows.map((r) => {
    const gross = Number(r.gross);
    const split = profile
      ? splitGst(gross, profile)
      : { grossPaise: gross, netPaise: gross, gstPaise: 0, gstRatePct: 0 };
    return {
      day: r.day,
      games: Number(r.games),
      grossPaise: split.grossPaise,
      netPaise: split.netPaise,
      gstPaise: split.gstPaise,
      gstRatePct: split.gstRatePct,
    };
  });
}
