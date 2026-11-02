// Purchase confirmation evidence for Pro payments: pure window logic plus
// thin DB functions over an injected client. No "server-only" import on
// purpose, so tests and operator scripts can use this module directly. One
// row per confirm tap (Telegram button or web checkbox), stamped with the
// Terms version in force at the tap. The row is a representation the student
// makes before paying; no age is asked for or stored anywhere.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PurchaseConfirmationRow } from "@/lib/db/types";
import { TERMS_VERSION } from "@/lib/legal/version";

export const PURCHASE_CONFIRM_WINDOW_MINUTES = 60;

// A confirmation stamped slightly in the future (clock skew) still counts up
// to a minute; anything further ahead is bad data and reads as unconfirmed.
const FUTURE_SKEW_MS = 60 * 1000;

export type PurchaseConfirmChannel = "telegram" | "web";

// Inclusive of exactly 60 minutes; null (or a timestamp too far ahead) is
// never a confirmation.
export function hasRecentConfirmation(confirmedAt: Date | null, now: Date): boolean {
  if (confirmedAt == null) return false;
  const ageMs = now.getTime() - confirmedAt.getTime();
  if (ageMs < -FUTURE_SKEW_MS) return false;
  return ageMs <= PURCHASE_CONFIRM_WINDOW_MINUTES * 60 * 1000;
}

export type RecordConfirmationArgs = {
  userId: string;
  channel: PurchaseConfirmChannel;
  now?: Date;
};

export type ConfirmationSaveResult = { ok: true } | { ok: false };

// Never throws: any failure, including a database error, is { ok: false } so
// the caller can answer with "nothing was charged" and stop the checkout.
export async function recordPurchaseConfirmation(
  client: SupabaseClient,
  args: RecordConfirmationArgs,
): Promise<ConfirmationSaveResult> {
  try {
    const row: Record<string, unknown> = {
      user_id: args.userId,
      channel: args.channel,
      terms_version: TERMS_VERSION,
    };
    if (args.now !== undefined) row.confirmed_at = args.now.toISOString();
    const { error } = await client.from("purchase_confirmations").insert(row);
    if (error != null) return { ok: false };
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// Shared read for the two variants below: throws on a database error, null
// when the student has never confirmed.
async function latestConfirmedAtOrThrow(
  client: SupabaseClient,
  userId: string,
): Promise<Date | null> {
  const { data, error } = await client
    .from("purchase_confirmations")
    .select("confirmed_at")
    .eq("user_id", userId)
    .order("confirmed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error != null) throw new Error(error.message);
  if (data == null) return null;
  const at = (data as Pick<PurchaseConfirmationRow, "confirmed_at">).confirmed_at;
  if (typeof at !== "string" || at.length === 0) return null;
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Null on any error, and null reads as not confirmed, so a broken read can
// never look like a confirmation (fail closed).
export async function latestConfirmationAt(
  client: SupabaseClient,
  userId: string,
): Promise<Date | null> {
  try {
    return await latestConfirmedAtOrThrow(client, userId);
  } catch {
    return null;
  }
}

// Same read, but a database error propagates: the Telegram pre-checkout gate
// uses this so a lookup failure can be answered as a failure instead of
// silently looking like "never confirmed".
export async function requireLatestConfirmationAt(
  client: SupabaseClient,
  userId: string,
): Promise<Date | null> {
  return latestConfirmedAtOrThrow(client, userId);
}
