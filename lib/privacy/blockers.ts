// Active subscriptions that must be dealt with before an account can be
// erased. The subscriptions table stores the provider in the provider column,
// but the honest discriminator is provider_ref: recurring Stripe rows start
// with sub_, PayNow one time rows start with paynow:, Stars rows carry the
// Telegram charge id.
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchPaged } from "./query";

export type BlockerKind = "stripe" | "paynow" | "stars" | "manual";

export type SubscriptionBlocker = {
  provider: string;
  provider_ref: string;
  plan: string;
  current_period_end: string | null;
  kind: BlockerKind;
  instruction: string;
};

export function blockerKind(provider: string, providerRef: string): BlockerKind {
  if (providerRef.startsWith("sub_")) return "stripe";
  if (providerRef.startsWith("paynow:")) return "paynow";
  if (provider === "stars") return "stars";
  return "manual";
}

export function blockerInstruction(kind: BlockerKind, periodEnd: string | null): string {
  const end = periodEnd == null ? "an unknown date" : periodEnd.slice(0, 10);
  switch (kind) {
    case "stripe":
      return "Cancel this subscription in the Stripe dashboard (Subscriptions, then Cancel) before erasing, or Stripe may keep charging the student.";
    case "paynow":
      return `One time PayNow purchase; it does not renew. It can simply run out on ${end}, or be set to canceled by hand.`;
    case "stars":
      return "The student must cancel this subscription in Telegram, or Telegram may keep charging them.";
    case "manual":
      return "Manually granted subscription. Set its status to canceled by hand before erasing.";
  }
}

export type SubscriptionActiveRow = {
  provider: string;
  provider_ref: string;
  plan: string;
  current_period_end: string | null;
};

// Active means status active and the period end in the future.
export function isActiveAt(row: SubscriptionActiveRow, now: Date): boolean {
  if (row.current_period_end == null) return false;
  const ms = Date.parse(row.current_period_end);
  return Number.isFinite(ms) && ms > now.getTime();
}

export async function activeSubscriptionBlockers(
  client: SupabaseClient,
  userId: string,
  now: Date,
): Promise<SubscriptionBlocker[]> {
  // The user filter is the whole point: another student's subscription must
  // never block this erasure.
  const rows = await fetchPaged<SubscriptionActiveRow>(
    client,
    "subscriptions",
    "provider,provider_ref,plan,current_period_end",
    [
      { column: "user_id", op: "eq", value: userId },
      { column: "status", op: "eq", value: "active" },
    ],
  );
  return rows
    .filter((row) => isActiveAt(row, now))
    .map((row) => {
      const kind = blockerKind(row.provider, row.provider_ref);
      return { ...row, kind, instruction: blockerInstruction(kind, row.current_period_end) };
    });
}
