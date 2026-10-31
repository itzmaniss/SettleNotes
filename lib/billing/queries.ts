import "server-only";
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/db/client";
import type { Feature, PlanId } from "./plans";

export type ActiveSubscription = {
  plan: PlanId;
  current_period_end: string | null;
  provider: string;
};

export type ClaimUsageInput = {
  userId: string;
  feature: Feature;
  uploadId: string | null;
  limit: number;
  periodStart: Date;
};

export type CountUsageInput = {
  userId: string;
  feature: Feature;
  periodStart: Date;
};

export type UsageStatus = "consumed" | "released";

function throwBilling(op: string, error: PostgrestError): never {
  const suffix = error.code ? ` [${error.code}]` : "";
  throw new Error(`billing ${op} failed${suffix}: ${error.message}`);
}

// All billing queries live behind this factory so tests can inject a fake
// client, same as lib/db/queries.ts.
export function createBillingQueries(client: SupabaseClient) {
  return {
    // An active subscription whose period has not ended. The plan is computed
    // on read, so no cron and no monthly reset job. Scoped by user_id.
    async getActiveSubscription(userId: string, now: Date): Promise<ActiveSubscription | null> {
      const { data, error } = await client
        .from("subscriptions")
        .select("plan, current_period_end, provider")
        .eq("user_id", userId)
        .eq("status", "active")
        .gt("current_period_end", now.toISOString())
        .order("current_period_end", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throwBilling("getActiveSubscription", error);
      return (data as ActiveSubscription | null) ?? null;
    },

    // Atomic claim through the claim_usage SQL function: returns the usage row
    // id, or null when the student is at their limit (or the SQL retry branch
    // recognised the same upload and returned its existing id).
    async claimUsage(i: ClaimUsageInput): Promise<string | null> {
      const { data, error } = await client.rpc("claim_usage", {
        p_user: i.userId,
        p_feature: i.feature,
        p_upload: i.uploadId,
        p_limit: i.limit,
        p_period_start: i.periodStart.toISOString(),
      });
      if (error) throwBilling("claimUsage", error);
      return (data as string | null) ?? null;
    },

    // Only a 'claimed' row can move on, so a double consume or a consume of
    // an already released row silently matches nothing instead of erroring.
    async setUsageStatus(usageId: string, status: UsageStatus): Promise<void> {
      const { error } = await client
        .from("usage_events")
        .update({ status })
        .eq("id", usageId)
        .eq("status", "claimed");
      if (error) throwBilling("setUsageStatus", error);
    },

    // Live (claimed + consumed) rows this period, for the refusal detail and
    // the dashboard usage card.
    async countUsage(i: CountUsageInput): Promise<number> {
      const { count, error } = await client
        .from("usage_events")
        .select("id", { count: "exact", head: true })
        .eq("user_id", i.userId)
        .eq("feature", i.feature)
        .gte("created_at", i.periodStart.toISOString())
        .in("status", ["claimed", "consumed"]);
      if (error) throwBilling("countUsage", error);
      return count ?? 0;
    },
  };
}

export type BillingQueries = ReturnType<typeof createBillingQueries>;

// Top-level helpers bound to the shared service-role client, resolved at call
// time so importing this module never touches the environment.
export function getActiveSubscription(userId: string, now: Date): Promise<ActiveSubscription | null> {
  return createBillingQueries(getSupabase()).getActiveSubscription(userId, now);
}

export function claimUsage(i: ClaimUsageInput): Promise<string | null> {
  return createBillingQueries(getSupabase()).claimUsage(i);
}

export function setUsageStatus(usageId: string, status: UsageStatus): Promise<void> {
  return createBillingQueries(getSupabase()).setUsageStatus(usageId, status);
}

export function countUsage(i: CountUsageInput): Promise<number> {
  return createBillingQueries(getSupabase()).countUsage(i);
}
