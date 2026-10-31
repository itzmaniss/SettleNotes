import { describe, expect, mock, test } from "bun:test";
import type { EntitlementsDeps } from "../../lib/billing/entitlements";
import type { ActiveSubscription, ClaimUsageInput, CountUsageInput, UsageStatus } from "../../lib/billing/queries";

// entitlements.ts transitively imports "server-only" via the queries module.
// Neutralize it, then load the real module.
mock.module("server-only", () => ({}));

const {
  periodStart,
  nextPeriodStart,
  limitFor,
  getPlanForUser,
  claimFeature,
  consumeUsage,
  releaseUsage,
  withFeatureClaim,
  QuotaRefusedError,
} = await import("../../lib/billing/entitlements");

const INT32_MAX = 2147483647;

function subWith(periodEnd: string): ActiveSubscription {
  return { plan: "pro", current_period_end: periodEnd, provider: "manual" };
}

type Fake = {
  deps: EntitlementsDeps;
  claims: ClaimUsageInput[];
  counts: CountUsageInput[];
  statuses: { usageId: string; status: UsageStatus }[];
};

// Fakes record every call; overrides set the claim/count replies per test.
function makeFake(opts: {
  billingEnabled: boolean;
  subscription?: ActiveSubscription | null;
  claimId?: string | null;
  used?: number;
  now?: () => Date;
}): Fake {
  const fake: Fake = { deps: {}, claims: [], counts: [], statuses: [] };
  fake.deps.billingEnabled = () => opts.billingEnabled;
  fake.deps.getActiveSubscription = async (userId, now) => {
    if (opts.subscription === undefined) throw new Error(`unexpected getActiveSubscription(${userId}, ${now.toISOString()})`);
    return opts.subscription;
  };
  fake.deps.claimUsage = async (i) => {
    fake.claims.push(i);
    return opts.claimId === undefined ? "usage-1" : opts.claimId;
  };
  fake.deps.countUsage = async (i) => {
    fake.counts.push(i);
    return opts.used ?? 0;
  };
  fake.deps.setUsageStatus = async (usageId, status) => {
    fake.statuses.push({ usageId, status });
  };
  if (opts.now) fake.deps.now = opts.now;
  return fake;
}

describe("periodStart", () => {
  test("1 Nov 01:30 SGT belongs to November, which started 31 Oct 16:00Z", () => {
    expect(periodStart(new Date("2026-10-31T17:30:00Z"))).toEqual(new Date("2026-10-31T16:00:00Z"));
  });

  test("mid month lands on the 1st 00:00 SGT of that month", () => {
    expect(periodStart(new Date("2026-10-15T00:00:00Z"))).toEqual(new Date("2026-09-30T16:00:00Z"));
  });

  test("exactly 00:00 SGT is its own period start", () => {
    // 1 Nov 00:00 SGT == 2026-10-31T16:00:00Z.
    expect(periodStart(new Date("2026-10-31T16:00:00Z"))).toEqual(new Date("2026-10-31T16:00:00Z"));
  });

  test("rolls over the year back: December starts after November", () => {
    expect(periodStart(new Date("2026-12-15T10:00:00Z"))).toEqual(new Date("2026-11-30T16:00:00Z"));
  });
});

describe("nextPeriodStart", () => {
  test("1 Nov 01:30 SGT resets on 1 Dec 00:00 SGT", () => {
    expect(nextPeriodStart(new Date("2026-10-31T17:30:00Z"))).toEqual(new Date("2026-11-30T16:00:00Z"));
  });

  test("mid December resets on 1 January of the next year", () => {
    expect(nextPeriodStart(new Date("2026-12-15T10:00:00Z"))).toEqual(new Date("2026-12-31T16:00:00Z"));
  });

  test("the reset instant is the periodStart of any mid next-month instant", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const at = new Date("2026-03-08T02:00:00Z");
    const reset = nextPeriodStart(at);
    // One day into the next month can never roll over again.
    expect(reset).toEqual(periodStart(new Date(reset.getTime() + DAY_MS)));
  });
});

describe("limitFor", () => {
  test("free quotas", () => {
    expect(limitFor("free", "math_diagnosis")).toEqual({ limit: 3, kind: "quota" });
    expect(limitFor("free", "slides_flashcards")).toEqual({ limit: 1, kind: "quota" });
    expect(limitFor("free", "brief_checklist")).toEqual({ limit: 1, kind: "quota" });
  });

  test("free-for-everyone features are unlimited with no cap", () => {
    expect(limitFor("free", "chat_capture")).toEqual({ limit: null, kind: "unlimited" });
    expect(limitFor("free", "weak_spot_tracker")).toEqual({ limit: null, kind: "unlimited" });
    expect(limitFor("pro", "chat_capture")).toEqual({ limit: null, kind: "unlimited" });
    expect(limitFor("pro", "weak_spot_tracker")).toEqual({ limit: null, kind: "unlimited" });
  });

  test("pro unlimited features become fair_use caps", () => {
    expect(limitFor("pro", "math_diagnosis")).toEqual({ limit: 300, kind: "fair_use" });
    expect(limitFor("pro", "slides_flashcards")).toEqual({ limit: 60, kind: "fair_use" });
    expect(limitFor("pro", "brief_checklist")).toEqual({ limit: 60, kind: "fair_use" });
  });
});

describe("getPlanForUser", () => {
  test("billing disabled means pro and never touches the DB", async () => {
    const fake = makeFake({ billingEnabled: false });
    expect(await getPlanForUser("user-1", fake.deps)).toBe("pro");
    expect(fake.claims).toHaveLength(0);
  });

  test("billing on with an active subscription is pro, passing now through", async () => {
    const now = () => new Date("2026-10-31T17:30:00Z");
    const seenAt: Date[] = [];
    const deps: EntitlementsDeps = {
      billingEnabled: () => true,
      now,
      getActiveSubscription: async (_userId, at) => {
        seenAt.push(at);
        return subWith("2026-11-30T16:00:00.000Z");
      },
    };
    expect(await getPlanForUser("user-1", deps)).toBe("pro");
    expect(seenAt).toEqual([new Date("2026-10-31T17:30:00Z")]);
  });

  test("billing on with no subscription is free", async () => {
    const deps: EntitlementsDeps = {
      billingEnabled: () => true,
      getActiveSubscription: async () => null,
    };
    expect(await getPlanForUser("user-1", deps)).toBe("free");
  });

  test("billing on with an expired period end is free (the query filters it)", async () => {
    const deps: EntitlementsDeps = {
      billingEnabled: () => true,
      getActiveSubscription: async (_userId, now) => {
        // Mirrors the gt current_period_end > now filter of the real query.
        return new Date("2026-10-01T00:00:00Z") > now ? subWith("2026-10-01T00:00:00Z") : null;
      },
    };
    expect(await getPlanForUser("user-1", deps)).toBe("free");
  });
});

describe("claimFeature", () => {
  const args = { userId: "user-1", feature: "math_diagnosis" as const, uploadId: "upload-1" };
  const now = () => new Date("2026-10-31T17:30:00Z");

  test("allowed: claims a ledger row under the plan quota", async () => {
    const fake = makeFake({ billingEnabled: true, subscription: null, claimId: "usage-9", now });
    const out = await claimFeature(args, fake.deps);
    expect(out).toEqual({ ok: true, usageId: "usage-9", plan: "free" });
    expect(fake.claims).toEqual([
      {
        userId: "user-1",
        feature: "math_diagnosis",
        uploadId: "upload-1",
        limit: 3,
        periodStart: new Date("2026-10-31T16:00:00Z"),
      },
    ]);
  });

  test("quota hit: refused with used, limit and resetsAt, after counting", async () => {
    const fake = makeFake({ billingEnabled: true, subscription: null, claimId: null, used: 3, now });
    const out = await claimFeature(args, fake.deps);
    expect(out).toEqual({
      ok: false,
      reason: "quota",
      used: 3,
      limit: 3,
      plan: "free",
      resetsAt: new Date("2026-11-30T16:00:00Z"),
    });
    expect(fake.counts).toEqual([
      {
        userId: "user-1",
        feature: "math_diagnosis",
        periodStart: new Date("2026-10-31T16:00:00Z"),
      },
    ]);
  });

  test("fair-use hit on pro", async () => {
    const fake = makeFake({
      billingEnabled: true,
      subscription: subWith("2026-11-30T16:00:00.000Z"),
      claimId: null,
      used: 300,
      now,
    });
    const out = await claimFeature(args, fake.deps);
    expect(out).toEqual({
      ok: false,
      reason: "fair_use",
      used: 300,
      limit: 300,
      plan: "pro",
      resetsAt: new Date("2026-11-30T16:00:00Z"),
    });
  });

  test("billing disabled: still records usage with a limit no one can hit", async () => {
    const fake = makeFake({ billingEnabled: false, claimId: "usage-10", used: 300, now });
    const out = await claimFeature(args, fake.deps);
    expect(out).toEqual({ ok: true, usageId: "usage-10", plan: "pro" });
    expect(fake.claims[0].limit).toBe(INT32_MAX);
    expect(fake.claims[0].periodStart).toEqual(new Date("2026-10-31T16:00:00Z"));
    // Never even looked up a subscription.
    expect(fake.deps.getActiveSubscription).toBeDefined();
  });

  test("same upload twice: identical claim args so the SQL layer dedupes", async () => {
    const fake = makeFake({ billingEnabled: true, subscription: null, claimId: "usage-1", now });
    const first = await claimFeature(args, fake.deps);
    const second = await claimFeature(args, fake.deps);
    expect(first).toEqual(second);
    expect(fake.claims).toHaveLength(2);
    expect(fake.claims[0]).toEqual(fake.claims[1]);
  });

  test("free-for-everyone features short-circuit with no DB write", async () => {
    for (const feature of ["chat_capture", "weak_spot_tracker"] as const) {
      const fake = makeFake({ billingEnabled: true, subscription: null, now });
      const out = await claimFeature({ userId: "user-1", feature, uploadId: "upload-1" }, fake.deps);
      expect(out).toEqual({ ok: true, usageId: "", plan: "free" });
      expect(fake.claims).toHaveLength(0);
      expect(fake.counts).toHaveLength(0);
    }
  });

  test("no upload (voice or text flow) still claims against the quota", async () => {
    const fake = makeFake({ billingEnabled: true, subscription: null, claimId: "usage-11", now });
    const out = await claimFeature({ ...args, uploadId: null }, fake.deps);
    expect(out).toEqual({ ok: true, usageId: "usage-11", plan: "free" });
    expect(fake.claims[0].uploadId).toBeNull();
  });
});

describe("consumeUsage and releaseUsage", () => {
  test("set the ledger status through the injected query", async () => {
    const fake = makeFake({ billingEnabled: true });
    await consumeUsage("usage-1", fake.deps);
    await releaseUsage("usage-2", fake.deps);
    expect(fake.statuses).toEqual([
      { usageId: "usage-1", status: "consumed" },
      { usageId: "usage-2", status: "released" },
    ]);
  });
});

describe("withFeatureClaim", () => {
  test("consumes on success and hands the ok result to run", async () => {
    const fake = makeFake({ billingEnabled: true });
    const out = await withFeatureClaim(
      { ok: true, usageId: "usage-1", plan: "free" },
      async (ok) => {
        expect(ok.usageId).toBe("usage-1");
        return "starter";
      },
      fake.deps
    );
    expect(out).toBe("starter");
    expect(fake.statuses).toEqual([{ usageId: "usage-1", status: "consumed" }]);
  });

  test("releases on throw and rethrows the original error", async () => {
    const fake = makeFake({ billingEnabled: true });
    const boom = new Error("ai call garbled");
    await expect(
      withFeatureClaim({ ok: true, usageId: "usage-1", plan: "free" }, async () => {
        throw boom;
      }, fake.deps)
    ).rejects.toThrow("ai call garbled");
    expect(fake.statuses).toEqual([{ usageId: "usage-1", status: "released" }]);
  });

  test("a refused claim throws QuotaRefusedError without running or writing", async () => {
    const fake = makeFake({ billingEnabled: true });
    let ran = false;
    const refused = {
      ok: false as const,
      reason: "quota" as const,
      used: 3,
      limit: 3,
      plan: "free" as const,
      resetsAt: new Date("2026-11-30T16:00:00Z"),
    };
    try {
      await withFeatureClaim(refused, async () => {
        ran = true;
        return "nope";
      }, fake.deps);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaRefusedError);
      if (err instanceof QuotaRefusedError) {
        expect(err.refusal).toEqual(refused);
      }
    }
    expect(ran).toBe(false);
    expect(fake.statuses).toHaveLength(0);
  });

  test("works with a claim promise and skips settle when no ledger row exists", async () => {
    const fake = makeFake({ billingEnabled: true });
    const out = await withFeatureClaim(
      Promise.resolve({ ok: true, usageId: "", plan: "pro" }),
      async () => "done",
      fake.deps
    );
    expect(out).toBe("done");
    expect(fake.statuses).toHaveLength(0);
  });
});
