// Supabase access for subscriptions and billing_events, in the same style as
// lib/clarify/queries.ts (factory over an injected client, lazy real wrappers
// at the bottom) so tests run on a fake client and lib/billing/queries.ts
// stays untouched. Renewals reuse the user's existing row: the unique
// (provider, provider_ref) key prevents duplicate charge rows, and every
// write is scoped by user_id so no cross-user write is possible.
import "server-only";
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/db/client";

export type SubscriptionProvider = "stars" | "stripe" | "manual";
export type SubscriptionStatus = "active" | "canceled" | "past_due";

// Widened from StarsSubscriptionUpsert so the Stripe webhook (T21) can reuse
// the same upsert: provider takes any subscription provider, the status can
// move to past_due or canceled, and the period end may be unknown (null, the
// column is nullable). The Stars row type stays assignable as is.
export type UpsertSubscriptionInput = {
  userId: string;
  provider: SubscriptionProvider;
  providerRef: string;
  plan: "pro";
  status: SubscriptionStatus;
  currentPeriodEnd: Date | null;
};

export type SubscriptionRow = {
  id: string;
  user_id: string;
  provider: SubscriptionProvider;
  provider_ref: string;
  plan: string;
  status: SubscriptionStatus;
  current_period_end: string | null;
  created_at: string;
  updated_at: string;
};

export type RecordBillingEventInput = {
  id: string;
  provider: string;
  payload: unknown;
};

function throwDb(op: string, error: PostgrestError): never {
  const suffix = error.code ? ` [${error.code}]` : "";
  throw new Error(`billing ${op} failed${suffix}: ${error.message}`);
}

export function createSubscriptionsQueries(client: SupabaseClient) {
  return {
    // The user's most recent row for one provider, expired or not: the
    // renewal flow extends it instead of inserting a second row.
    async getLatestSubscription(
      userId: string,
      provider: SubscriptionProvider,
    ): Promise<SubscriptionRow | null> {
      const { data, error } = await client
        .from("subscriptions")
        .select()
        .eq("user_id", userId)
        .eq("provider", provider)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throwDb("getLatestSubscription", error);
      return (data as SubscriptionRow | null) ?? null;
    },

    // One row per (user, provider): update first and insert only when the
    // update matched nothing. Two concurrent first payments could race here,
    // but unique(provider, provider_ref) still blocks duplicate charge rows
    // and the charge-level billing_events dedupe runs before this.
    async upsertSubscription(i: UpsertSubscriptionInput): Promise<void> {
      const periodEnd = i.currentPeriodEnd?.toISOString() ?? null;
      const { data, error } = await client
        .from("subscriptions")
        .update({
          provider_ref: i.providerRef,
          plan: i.plan,
          status: i.status,
          current_period_end: periodEnd,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", i.userId)
        .eq("provider", i.provider)
        .select("id")
        .maybeSingle();
      if (error) throwDb("upsertSubscription", error);
      if (data != null) return;
      const { error: insertError } = await client.from("subscriptions").insert({
        user_id: i.userId,
        provider: i.provider,
        provider_ref: i.providerRef,
        plan: i.plan,
        status: i.status,
        current_period_end: periodEnd,
      });
      if (insertError) throwDb("upsertSubscription", insertError);
    },

    // Webhook and payment dedupe: true when this exact event was recorded.
    async findBillingEvent(id: string): Promise<boolean> {
      const { data, error } = await client
        .from("billing_events")
        .select("id")
        .eq("id", id)
        .maybeSingle();
      if (error) throwDb("findBillingEvent", error);
      return data != null;
    },

    async recordBillingEvent(i: RecordBillingEventInput): Promise<void> {
      const { error } = await client.from("billing_events").insert({
        id: i.id,
        provider: i.provider,
        payload: i.payload,
      });
      if (error) throwDb("recordBillingEvent", error);
    },

    // Only used to undo a recorded event when the subscription write right
    // after it failed, so a Telegram retry can replay the whole step.
    async deleteBillingEvent(id: string): Promise<void> {
      const { error } = await client.from("billing_events").delete().eq("id", id);
      if (error) throwDb("deleteBillingEvent", error);
    },

    // Refund bookkeeping: close the exact charge row and nothing else.
    async markSubscriptionCanceled(
      userId: string,
      provider: SubscriptionProvider,
      providerRef: string,
    ): Promise<void> {
      const { error } = await client
        .from("subscriptions")
        .update({ status: "canceled", updated_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("provider", provider)
        .eq("provider_ref", providerRef);
      if (error) throwDb("markSubscriptionCanceled", error);
    },
  };
}

export type SubscriptionsQueries = ReturnType<typeof createSubscriptionsQueries>;

// Top-level helpers bound to the shared service-role client, resolved at call
// time so importing this module never touches the environment.
export function getLatestSubscription(
  userId: string,
  provider: SubscriptionProvider,
): Promise<SubscriptionRow | null> {
  return createSubscriptionsQueries(getSupabase()).getLatestSubscription(userId, provider);
}

export function upsertSubscription(i: UpsertSubscriptionInput): Promise<void> {
  return createSubscriptionsQueries(getSupabase()).upsertSubscription(i);
}

export function findBillingEvent(id: string): Promise<boolean> {
  return createSubscriptionsQueries(getSupabase()).findBillingEvent(id);
}

export function recordBillingEvent(i: RecordBillingEventInput): Promise<void> {
  return createSubscriptionsQueries(getSupabase()).recordBillingEvent(i);
}

export function deleteBillingEvent(id: string): Promise<void> {
  return createSubscriptionsQueries(getSupabase()).deleteBillingEvent(id);
}

export function markSubscriptionCanceled(
  userId: string,
  provider: SubscriptionProvider,
  providerRef: string,
): Promise<void> {
  return createSubscriptionsQueries(getSupabase()).markSubscriptionCanceled(userId, provider, providerRef);
}
