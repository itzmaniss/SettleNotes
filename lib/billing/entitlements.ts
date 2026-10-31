import { getSupabase } from "@/lib/db/client";
import { isBillingEnabled } from "./flags";
import { PLANS, type Feature, type PlanId } from "./plans";
import {
  createBillingQueries,
  type ActiveSubscription,
  type BillingQueries,
  type ClaimUsageInput,
  type CountUsageInput,
  type UsageStatus,
} from "./queries";

// Singapore is fixed UTC+8 with no DST, so SGT wall clock is just epoch plus
// the offset and SGT midnight is 16:00 UTC the previous day.
const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;

// postgres int4 max. With billing disabled every claim runs with this limit so
// usage is recorded but nothing can ever be refused.
const UNBLOCKED_LIMIT = 2147483647;

export type EntitlementsDeps = {
  billingEnabled?: () => boolean;
  getActiveSubscription?: BillingQueries["getActiveSubscription"];
  claimUsage?: BillingQueries["claimUsage"];
  countUsage?: BillingQueries["countUsage"];
  setUsageStatus?: BillingQueries["setUsageStatus"];
  now?: () => Date;
};

export type UsageLimit = {
  limit: number | null;
  kind: "quota" | "fair_use" | "unlimited" | "off";
};

export type ClaimArgs = {
  userId: string;
  feature: Feature;
  uploadId: string | null;
};

export type ClaimOk = { ok: true; usageId: string; plan: PlanId };

export type ClaimRefused = {
  ok: false;
  reason: "quota" | "fair_use";
  used: number;
  limit: number;
  plan: PlanId;
  resetsAt: Date;
};

export type ClaimResult = ClaimOk | ClaimRefused;

function defaultQueries(): BillingQueries {
  return createBillingQueries(getSupabase());
}

function resolveNow(deps?: EntitlementsDeps): () => Date {
  return deps?.now ?? (() => new Date());
}

// 00:00 on the 1st of the current month in Asia/Singapore, as a UTC instant.
// now 2026-10-31T17:30Z is 1 Nov 01:30 SGT, so the period already started at
// 2026-10-31T16:00Z (1 Nov 00:00 SGT).
export function periodStart(now: Date): Date {
  const shifted = new Date(now.getTime() + SGT_OFFSET_MS);
  const firstOfMonth = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1);
  return new Date(firstOfMonth - SGT_OFFSET_MS);
}

// The instant the current period resets: 00:00 SGT on the 1st of the next
// month. Date.UTC rolls month 12 over to January of the next year.
export function nextPeriodStart(now: Date): Date {
  const shifted = new Date(now.getTime() + SGT_OFFSET_MS);
  const firstOfNext = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 1);
  return new Date(firstOfNext - SGT_OFFSET_MS);
}

// pro when billing is off, so nothing is locked today. When billing is on:
// pro with an active subscription whose period has not ended, else free.
export async function getPlanForUser(userId: string, deps?: EntitlementsDeps): Promise<PlanId> {
  const billingEnabled = deps?.billingEnabled ?? isBillingEnabled;
  if (!billingEnabled()) return "pro";
  const getActive =
    deps?.getActiveSubscription ??
    ((id: string, at: Date) => defaultQueries().getActiveSubscription(id, at));
  const sub: ActiveSubscription | null = await getActive(userId, resolveNow(deps)());
  return sub ? "pro" : "free";
}

// Pure: the effective limit for a plan and feature. 'unlimited' with a
// fairUse cap becomes kind 'fair_use' with the cap as the limit.
export function limitFor(plan: PlanId, feature: Feature): UsageLimit {
  const quota = PLANS[plan].quotas[feature];
  if (quota === "off") return { limit: 0, kind: "off" };
  if (quota === "unlimited") {
    const cap = PLANS[plan].fairUse[feature];
    if (cap !== undefined) return { limit: cap, kind: "fair_use" };
    return { limit: null, kind: "unlimited" };
  }
  return { limit: quota, kind: "quota" };
}

// Claim one use before the AI call runs. With billing disabled the claim still
// goes through the ledger, just with a limit no one can hit. usageId is ""
// when no ledger row was needed (unlimited features with no fair-use cap).
export async function claimFeature(args: ClaimArgs, deps?: EntitlementsDeps): Promise<ClaimResult> {
  const billingEnabled = deps?.billingEnabled ?? isBillingEnabled;
  const enabled = billingEnabled();
  const plan = enabled ? await getPlanForUser(args.userId, deps) : "pro";
  const { limit, kind } = limitFor(plan, args.feature);

  // chat_capture and weak_spot_tracker are unlimited on every plan with no
  // fair-use cap: free for everyone, so no ledger row and no DB write at all.
  if (kind === "unlimited") {
    return { ok: true, usageId: "", plan };
  }

  const at = resolveNow(deps)();
  const period = periodStart(at);
  const resetsAt = nextPeriodStart(at);
  const claim = deps?.claimUsage ?? ((i: ClaimUsageInput) => defaultQueries().claimUsage(i));
  const usageId = await claim({
    userId: args.userId,
    feature: args.feature,
    uploadId: args.uploadId,
    limit: enabled ? (limit ?? 0) : UNBLOCKED_LIMIT,
    periodStart: period,
  });
  if (usageId !== null) return { ok: true, usageId, plan };

  const count = deps?.countUsage ?? ((i: CountUsageInput) => defaultQueries().countUsage(i));
  const used = await count({ userId: args.userId, feature: args.feature, periodStart: period });
  return {
    ok: false,
    reason: kind === "fair_use" ? "fair_use" : "quota",
    used,
    limit: limit ?? 0,
    plan,
    resetsAt,
  };
}

export async function consumeUsage(usageId: string, deps?: EntitlementsDeps): Promise<void> {
  const setUsageStatus = deps?.setUsageStatus ?? ((id: string, s: UsageStatus) => defaultQueries().setUsageStatus(id, s));
  await setUsageStatus(usageId, "consumed");
}

export async function releaseUsage(usageId: string, deps?: EntitlementsDeps): Promise<void> {
  const setUsageStatus = deps?.setUsageStatus ?? ((id: string, s: UsageStatus) => defaultQueries().setUsageStatus(id, s));
  await setUsageStatus(usageId, "released");
}

// Thrown by withFeatureClaim when the claim was refused. The wiring catches it
// and renders quotaHitReply(lib/billing/copy.ts) from refusal.
export class QuotaRefusedError extends Error {
  readonly refusal: ClaimRefused;

  constructor(refusal: ClaimRefused) {
    super(`claim refused (${refusal.reason}): used ${refusal.used} of ${refusal.limit}`);
    this.name = "QuotaRefusedError";
    this.refusal = refusal;
  }
}

// Runs the gated work between claim and settle: consume on success, release on
// throw (rethrowing the original error). A failed or garbled AI call must
// never use up quota. On refusal it throws QuotaRefusedError without running.
export async function withFeatureClaim<T>(
  claim: ClaimResult | Promise<ClaimResult>,
  run: (ok: ClaimOk) => Promise<T>,
  deps?: EntitlementsDeps
): Promise<T> {
  const result = await claim;
  if (!result.ok) throw new QuotaRefusedError(result);
  try {
    const out = await run(result);
    if (result.usageId !== "") await consumeUsage(result.usageId, deps);
    return out;
  } catch (err) {
    if (result.usageId !== "") {
      // Release is best effort: a failed release must not mask the real error.
      try {
        await releaseUsage(result.usageId, deps);
      } catch {
        // leave the row claimed; it still counts this period, by design
      }
    }
    throw err;
  }
}
