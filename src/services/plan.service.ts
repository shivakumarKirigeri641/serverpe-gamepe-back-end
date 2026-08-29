import { query, queryOne } from '../db/pool.js';
import { isChargingEnabled } from '../config/env.js';

/**
 * Plans a host picks when creating a room.
 *
 * Like the legal documents, every word and price lives in the database so the
 * admin panel owns them. `is_selectable` is what separates a live plan from one
 * shown greyed out as "coming soon".
 */

export interface Plan {
  id: string;
  plan_key: string;
  name: string;
  tagline: string;
  description: string;
  price_paise: number;
  currency: string;
  max_players: number;
  is_active: boolean;
  is_selectable: boolean;
  display_order: number;
}

const PLAN_COLUMNS = `id, plan_key, name, tagline, description, price_paise, currency,
  max_players, is_active, is_selectable, display_order`;

export async function listActivePlans(): Promise<Plan[]> {
  return query<Plan>(
    `SELECT ${PLAN_COLUMNS} FROM plans WHERE is_active ORDER BY display_order, name`,
  );
}

export async function listAllPlans(): Promise<Plan[]> {
  return query<Plan>(`SELECT ${PLAN_COLUMNS} FROM plans ORDER BY display_order, name`);
}

export async function getPlan(planKey: string): Promise<Plan | null> {
  return queryOne<Plan>(`SELECT ${PLAN_COLUMNS} FROM plans WHERE plan_key = $1`, [planKey]);
}

/** The plan used when a host somehow ends up without choosing one. */
export async function defaultPlan(): Promise<Plan | null> {
  return queryOne<Plan>(
    `SELECT ${PLAN_COLUMNS} FROM plans
      WHERE is_active AND is_selectable
      ORDER BY price_paise, display_order
      LIMIT 1`,
  );
}

/** `Free` while the trial is running, otherwise `₹49`. */
export function formatPrice(plan: Plan): string {
  if (plan.price_paise === 0 || !isChargingEnabled()) return 'Free';
  const symbol = plan.currency === 'INR' ? '₹' : `${plan.currency} `;
  const whole = plan.price_paise / 100;
  return `${symbol}${Number.isInteger(whole) ? whole : whole.toFixed(2)}`;
}

/**
 * What the host is actually charged.
 *
 * A plan may carry a price long before we start collecting it — during the free
 * trial every plan costs nothing, whatever the sticker says.
 */
export function chargeableAmount(plan: Plan): number {
  return isChargingEnabled() ? plan.price_paise : 0;
}

/** Row title and description for the WhatsApp plan picker. */
export function planRow(plan: Plan): { id: string; title: string; description: string } {
  const price = formatPrice(plan);
  const title = plan.is_selectable ? `${plan.name} · ${price}` : `${plan.name} (soon)`;
  return {
    id: plan.is_selectable ? `plan:${plan.plan_key}` : `plan:soon:${plan.plan_key}`,
    title: title.slice(0, 24),
    description: plan.tagline.slice(0, 72),
  };
}

/* ------------------------------------------------------ admin-side editing */

export interface PlanInput {
  plan_key: string;
  name: string;
  tagline: string;
  description?: string;
  price_paise?: number;
  currency?: string;
  max_players?: number;
  is_active?: boolean;
  is_selectable?: boolean;
  display_order?: number;
}

export async function upsertPlan(input: PlanInput): Promise<Plan> {
  const row = await queryOne<Plan>(
    `INSERT INTO plans (plan_key, name, tagline, description, price_paise, currency,
                        max_players, is_active, is_selectable, display_order)
     VALUES ($1, $2, $3, COALESCE($4, ''), COALESCE($5, 0), COALESCE($6, 'INR'),
             COALESCE($7, 200), COALESCE($8, true), COALESCE($9, true), COALESCE($10, 99))
     ON CONFLICT (plan_key) DO UPDATE SET
       name          = EXCLUDED.name,
       tagline       = EXCLUDED.tagline,
       description   = COALESCE($4, plans.description),
       price_paise   = COALESCE($5, plans.price_paise),
       currency      = COALESCE($6, plans.currency),
       max_players   = COALESCE($7, plans.max_players),
       is_active     = COALESCE($8, plans.is_active),
       is_selectable = COALESCE($9, plans.is_selectable),
       display_order = COALESCE($10, plans.display_order),
       updated_at    = now()
     RETURNING ${PLAN_COLUMNS}`,
    [
      input.plan_key,
      input.name,
      input.tagline,
      input.description ?? null,
      input.price_paise ?? null,
      input.currency ?? null,
      input.max_players ?? null,
      input.is_active ?? null,
      input.is_selectable ?? null,
      input.display_order ?? null,
    ],
  );
  if (!row) throw new Error(`Failed to upsert plan ${input.plan_key}`);
  return row;
}

/** How many games each plan has been used for. */
export async function planUsage(): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT p.plan_key, p.name, p.price_paise, p.is_selectable,
            count(g.id)::int AS games,
            count(g.id) FILTER (WHERE g.status = 'completed')::int AS completed
       FROM plans p
       LEFT JOIN games g ON g.plan_key = p.plan_key
      GROUP BY p.plan_key, p.name, p.price_paise, p.is_selectable, p.display_order
      ORDER BY p.display_order`,
  );
}
