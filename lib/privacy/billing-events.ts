// billing_events has no user column: the raw webhook rows are keyed by the
// provider event id for dedupe, and the user hides inside the payload. The
// scrub finds rows by payload reference and REPLACES the payload with the
// accounting minimum. Rows are never deleted: the dedupe must keep working
// (Telegram retries the same charge id) and accounting may still need them.
import type { SupabaseClient } from "@supabase/supabase-js";
import { applyFilters, type PrivacyFilter } from "./query";

export type BillingEventRow = { id: string; provider: string; payload: Record<string, unknown> };

// Stars payloads keep what refunds and Telegram support need (the charge id
// above all) and lose the invoice payload, which carries the user id. Stripe
// payloads keep only the event type and object id, losing user_id.
export const STARS_KEPT_FIELDS = [
  "currency",
  "total_amount",
  "subscription_expiration_date",
  "is_recurring",
  "is_first_recurring",
  "telegram_payment_charge_id",
] as const;
export const STRIPE_KEPT_FIELDS = ["type", "object_id"] as const;
// Refund bookkeeping rows (scripts/refund-stars.ts) carry the Telegram id;
// the charge id is what support needs, the id is not.
export const REFUND_KEPT_FIELDS = ["telegram_payment_charge_id"] as const;

export type BillingPayloadKind = "stars" | "stripe" | "refund";

// Pure classification: how, and whether, a payload points at this user.
export function classifyBillingPayload(
  payload: unknown,
  userId: string,
  telegramUserId?: number,
): BillingPayloadKind | null {
  if (payload == null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const invoice = p.invoice_payload;
  if (typeof invoice === "string" && invoice.endsWith(userId)) return "stars";
  if (p.user_id === userId) return "stripe";
  if (telegramUserId !== undefined && Number(p.telegram_user_id) === telegramUserId) {
    return "refund";
  }
  return null;
}

function pick(
  payload: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in payload) out[field] = payload[field];
  }
  return out;
}

// Pure: the minimal payload kept for each kind.
export function scrubbedPayload(
  kind: BillingPayloadKind,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (kind === "stars") return pick(payload, STARS_KEPT_FIELDS);
  if (kind === "stripe") return pick(payload, STRIPE_KEPT_FIELDS);
  return pick(payload, REFUND_KEPT_FIELDS);
}

const EVENT_COLUMNS = "id,provider,payload";

// The rows whose payload references this user. Three PostgREST json filters,
// run as separate queries and deduped here (a single typed chain cannot
// express the OR): Stripe events store the uuid under payload.user_id, Stars
// events end their invoice_payload with it (`settle:pro:monthly:<uuid>`), and
// refund bookkeeping rows store the Telegram id. The in-code classification
// is the final gate: a row is only scrubbed when classifyBillingPayload agrees.
export async function findBillingEventsForUser(
  client: SupabaseClient,
  userId: string,
  opts: { telegramUserId?: number } = {},
): Promise<BillingEventRow[]> {
  const queryFilters: PrivacyFilter[][] = [
    [{ column: "payload->>user_id", op: "filter", operator: "eq", value: userId }],
    [{ column: "payload->>invoice_payload", op: "filter", operator: "like", value: `*${userId}` }],
  ];
  if (opts.telegramUserId !== undefined) {
    queryFilters.push([
      {
        column: "payload->>telegram_user_id",
        op: "filter",
        operator: "eq",
        value: String(opts.telegramUserId),
      },
    ]);
  }
  const byId = new Map<string, BillingEventRow>();
  for (const filters of queryFilters) {
    const base = client.from("billing_events").select(EVENT_COLUMNS);
    const { data, error } = await applyFilters(base, filters);
    if (error) throw new Error(`billing events lookup failed: ${error.message}`);
    for (const row of (data ?? []) as BillingEventRow[]) {
      if (classifyBillingPayload(row.payload, userId, opts.telegramUserId) !== null) {
        byId.set(row.id, row);
      }
    }
  }
  return [...byId.values()];
}

// Replaces each matching payload with the accounting minimum. Never deletes.
export async function scrubBillingEvents(
  client: SupabaseClient,
  userId: string,
  opts: { telegramUserId?: number } = {},
): Promise<{ matched: number; scrubbed: number }> {
  const rows = await findBillingEventsForUser(client, userId, opts);
  let scrubbed = 0;
  for (const row of rows) {
    const kind = classifyBillingPayload(row.payload, userId, opts.telegramUserId);
    if (kind === null) continue;
    const minimal = scrubbedPayload(kind, row.payload);
    const { error } = await client.from("billing_events").update({ payload: minimal }).eq("id", row.id);
    if (error) throw new Error(`billing event scrub failed for ${row.id}: ${error.message}`);
    scrubbed += 1;
  }
  return { matched: rows.length, scrubbed };
}
