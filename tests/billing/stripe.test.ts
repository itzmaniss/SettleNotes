import { describe, expect, test } from "bun:test";
import {
  buildCheckoutParams,
  buildPayNowParams,
  buildPortalParams,
  customerIdFromSubscription,
  handleStripeEvent,
  mapStripeStatus,
  paynowRowFromSession,
  periodEndFromSubscription,
  priceIdFor,
  stripeConfigured,
  subscriptionRowFromStripe,
  type StripeEventLike,
  type StripeSubscriptionUpsert,
  type StripeWebhookDeps,
} from "../../lib/billing/stripe";
import type { UpsertSubscriptionInput } from "../../lib/billing/subscriptions";

const USER = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
const NOW = new Date("2026-10-31T09:00:00.000Z");

const fullEnv = {
  STRIPE_SECRET_KEY: "sk_test_123",
  STRIPE_WEBHOOK_SECRET: "whsec_123",
  STRIPE_PRICE_PRO_MONTHLY: "price_monthly",
  STRIPE_PRICE_PRO_YEARLY: "price_yearly",
  STRIPE_PRICE_PRO_YEARLY_PAYNOW: "price_paynow",
};

// ---- Config -----------------------------------------------------------------

describe("stripeConfigured", () => {
  test("true only with the secret, webhook secret and both recurring prices", () => {
    expect(stripeConfigured(fullEnv)).toBe(true);
    expect(stripeConfigured({ ...fullEnv, STRIPE_SECRET_KEY: undefined })).toBe(false);
    expect(stripeConfigured({ ...fullEnv, STRIPE_WEBHOOK_SECRET: "" })).toBe(false);
    expect(stripeConfigured({ ...fullEnv, STRIPE_PRICE_PRO_MONTHLY: undefined })).toBe(false);
    expect(stripeConfigured({ ...fullEnv, STRIPE_PRICE_PRO_YEARLY: undefined })).toBe(false);
    expect(stripeConfigured({})).toBe(false);
  });

  test("the PayNow price alone is optional", () => {
    expect(stripeConfigured({ ...fullEnv, STRIPE_PRICE_PRO_YEARLY_PAYNOW: undefined })).toBe(true);
  });
});

describe("priceIdFor", () => {
  test("maps monthly and yearly to their env price ids", () => {
    expect(priceIdFor("monthly", fullEnv)).toBe("price_monthly");
    expect(priceIdFor("yearly", fullEnv)).toBe("price_yearly");
    expect(priceIdFor("monthly", {})).toBeNull();
    expect(priceIdFor("yearly", { ...fullEnv, STRIPE_PRICE_PRO_YEARLY: "" })).toBeNull();
  });
});

// ---- Checkout and PayNow params ----------------------------------------------

describe("buildCheckoutParams", () => {
  test("subscription mode with identity in all three places", () => {
    for (const interval of ["monthly", "yearly"] as const) {
      const params = buildCheckoutParams({
        userId: USER,
        interval,
        baseUrl: "https://settle.example.com",
        priceId: interval === "monthly" ? "price_monthly" : "price_yearly",
      });
      expect(params.mode).toBe("subscription");
      expect(params.client_reference_id).toBe(USER);
      expect(params.metadata).toEqual({ user_id: USER });
      expect(params.subscription_data?.metadata).toEqual({ user_id: USER });
      expect(params.success_url).toBe("https://settle.example.com/billing?status=success");
      expect(params.cancel_url).toBe("https://settle.example.com/billing?status=canceled");
      expect(params.allow_promotion_codes).toBe(true);
      expect(params.line_items).toEqual([
        { price: interval === "monthly" ? "price_monthly" : "price_yearly", quantity: 1 },
      ]);
    }
  });
});

describe("buildPayNowParams", () => {
  test("one-time payment filtered to PayNow with the yearly kind marker", () => {
    const params = buildPayNowParams({
      userId: USER,
      baseUrl: "https://settle.example.com",
      priceId: "price_paynow",
    });
    expect(params.mode).toBe("payment");
    expect(params.allowed_payment_method_types).toEqual(["paynow"]);
    expect(params.client_reference_id).toBe(USER);
    expect(params.metadata).toEqual({ user_id: USER, kind: "paynow_yearly" });
    expect(params.success_url).toBe("https://settle.example.com/billing?status=success");
    expect(params.cancel_url).toBe("https://settle.example.com/billing?status=canceled");
    expect(params.line_items).toEqual([{ price: "price_paynow", quantity: 1 }]);
    expect(params.allow_promotion_codes).toBeUndefined();
  });
});

// ---- Status mapping and period end ---------------------------------------------

describe("mapStripeStatus", () => {
  test("active family", () => {
    expect(mapStripeStatus("active")).toBe("active");
    expect(mapStripeStatus("trialing")).toBe("active");
  });

  test("payment trouble family", () => {
    expect(mapStripeStatus("past_due")).toBe("past_due");
    expect(mapStripeStatus("unpaid")).toBe("past_due");
    expect(mapStripeStatus("incomplete")).toBe("past_due");
  });

  test("gone family, and unknown collapses to canceled", () => {
    expect(mapStripeStatus("canceled")).toBe("canceled");
    expect(mapStripeStatus("incomplete_expired")).toBe("canceled");
    expect(mapStripeStatus("paused")).toBe("canceled");
    expect(mapStripeStatus("weird_new_status")).toBe("canceled");
    expect(mapStripeStatus(null)).toBe("canceled");
    expect(mapStripeStatus(undefined)).toBe("canceled");
  });
});

describe("periodEndFromSubscription", () => {
  test("reads the per-item end this SDK version keeps", () => {
    const sub = {
      id: "sub_1",
      items: { data: [{ current_period_end: 1798761600 }, { current_period_end: 1798761700 }] },
    };
    expect(periodEndFromSubscription(sub)).toEqual(new Date(1798761600 * 1000));
  });

  test("falls back to the legacy top-level field", () => {
    expect(periodEndFromSubscription({ id: "sub_1", current_period_end: 1798761600 })).toEqual(
      new Date(1798761600 * 1000),
    );
  });

  test("null when neither shape carries a usable number", () => {
    expect(periodEndFromSubscription({ id: "sub_1" })).toBeNull();
    expect(
      periodEndFromSubscription({ id: "sub_1", items: { data: [{}] }, current_period_end: NaN }),
    ).toBeNull();
  });
});

describe("subscriptionRowFromStripe", () => {
  test("maps the subscription to a stripe upsert row", () => {
    const row = subscriptionRowFromStripe(
      {
        id: "sub_123",
        status: "active",
        items: { data: [{ current_period_end: 1798761600 }] },
      },
      USER,
    );
    expect(row).toEqual({
      userId: USER,
      provider: "stripe",
      providerRef: "sub_123",
      plan: "pro",
      status: "active",
      currentPeriodEnd: new Date(1798761600 * 1000),
    });
  });

  test("past_due subscription keeps its period end", () => {
    const row = subscriptionRowFromStripe(
      { id: "sub_123", status: "past_due", items: { data: [{ current_period_end: 1 }] } },
      USER,
    );
    expect(row.status).toBe("past_due");
    expect(row.currentPeriodEnd).toEqual(new Date(1000));
  });
});

describe("paynowRowFromSession", () => {
  test("buys exactly 365 days from now under a paynow-prefixed ref", () => {
    const row = paynowRowFromSession(
      { id: "cs_paynow_1", mode: "payment", payment_status: "paid" },
      USER,
      NOW,
    );
    const expected = new Date(NOW.getTime() + 365 * 24 * 60 * 60 * 1000);
    expect(row).toEqual({
      userId: USER,
      provider: "stripe",
      providerRef: "paynow:cs_paynow_1",
      plan: "pro",
      status: "active",
      currentPeriodEnd: expected,
    });
    expect(row.currentPeriodEnd?.getTime()).toBe(expected.getTime());
  });
});

describe("customer and portal params", () => {
  test("customer id from string or object form", () => {
    expect(customerIdFromSubscription({ id: "sub_1", customer: "cus_123" })).toBe("cus_123");
    expect(customerIdFromSubscription({ id: "sub_1", customer: { id: "cus_9" } })).toBe("cus_9");
    expect(customerIdFromSubscription({ id: "sub_1", customer: null })).toBeNull();
  });

  test("portal session returns to /billing", () => {
    expect(buildPortalParams("cus_123", "https://settle.example.com")).toEqual({
      customer: "cus_123",
      return_url: "https://settle.example.com/billing",
    });
  });
});

// ---- handleStripeEvent -----------------------------------------------------------

type FakeDeps = {
  deps: StripeWebhookDeps;
  events: { id: string; provider: string; payload: unknown }[];
  upserts: UpsertSubscriptionInput[];
  retrieved: string[];
  deleted: string[];
  findResult: boolean;
};

function makeDeps(findResult = false, retrieveResult: unknown = null): FakeDeps {
  const state: FakeDeps = {
    deps: {} as StripeWebhookDeps,
    events: [],
    upserts: [],
    retrieved: [],
    deleted: [],
    findResult,
  };
  state.deps = {
    findBillingEvent: async () => state.findResult,
    recordBillingEvent: async (event) => {
      state.events.push(event);
    },
    deleteBillingEvent: async (id) => {
      state.deleted.push(id);
    },
    upsertSubscription: async (row) => {
      state.upserts.push(row as UpsertSubscriptionInput);
    },
    retrieveSubscription: async (id) => {
      state.retrieved.push(id);
      return retrieveResult as never;
    },
    now: () => NOW,
    log: () => {},
  };
  return state;
}

function event(type: string, object: unknown, id = "evt_1"): StripeEventLike {
  return { id, type, data: { object } };
}

const ACTIVE_SUB = {
  id: "sub_123",
  status: "active",
  metadata: { user_id: USER },
  customer: "cus_1",
  items: { data: [{ current_period_end: 1798761600 }] },
};

describe("handleStripeEvent", () => {
  test("checkout subscription mode retrieves the subscription and upserts", async () => {
    const state = makeDeps(false, ACTIVE_SUB);
    const outcome = await handleStripeEvent(
      state.deps,
      event("checkout.session.completed", {
        id: "cs_1",
        mode: "subscription",
        client_reference_id: USER,
        subscription: "sub_123",
        payment_status: "paid",
        metadata: { user_id: USER },
      }),
    );
    expect(outcome).toEqual({ kind: "processed", type: "checkout.session.completed" });
    expect(state.retrieved).toEqual(["sub_123"]);
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0]).toMatchObject({
      userId: USER,
      provider: "stripe",
      providerRef: "sub_123",
      status: "active",
    });
    // Dedupe record first: minimal summary, no customer payload.
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({ id: "stripe:evt_1", provider: "stripe" });
    expect(state.events[0]!.payload).toEqual({
      type: "checkout.session.completed",
      object_id: "cs_1",
      user_id: USER,
    });
  });

  test("checkout user id may come from metadata when the reference is missing", async () => {
    const state = makeDeps(false, ACTIVE_SUB);
    await handleStripeEvent(
      state.deps,
      event("checkout.session.completed", {
        id: "cs_2",
        mode: "subscription",
        subscription: "sub_123",
        metadata: { user_id: USER },
      }),
    );
    expect(state.upserts[0]!.userId).toBe(USER);
  });

  test("checkout paynow yearly paid session becomes a 365 day row", async () => {
    const state = makeDeps();
    const outcome = await handleStripeEvent(
      state.deps,
      event("checkout.session.completed", {
        id: "cs_3",
        mode: "payment",
        payment_status: "paid",
        client_reference_id: USER,
        metadata: { user_id: USER, kind: "paynow_yearly" },
      }),
    );
    expect(outcome).toEqual({ kind: "processed", type: "checkout.session.completed" });
    expect(state.retrieved).toEqual([]);
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0]).toEqual({
      userId: USER,
      provider: "stripe",
      providerRef: "paynow:cs_3",
      plan: "pro",
      status: "active",
      currentPeriodEnd: new Date(NOW.getTime() + 365 * 24 * 60 * 60 * 1000),
    });
  });

  test("unpaid paynow session is ignored without an upsert", async () => {
    const state = makeDeps();
    const outcome = await handleStripeEvent(
      state.deps,
      event("checkout.session.completed", {
        id: "cs_4",
        mode: "payment",
        payment_status: "unpaid",
        client_reference_id: USER,
        metadata: { user_id: USER, kind: "paynow_yearly" },
      }),
    );
    expect(outcome).toEqual({
      kind: "ignored",
      type: "checkout.session.completed",
      reason: "not_paid",
    });
    expect(state.upserts).toEqual([]);
  });

  test("subscription.updated upserts from the object and its metadata user", async () => {
    const state = makeDeps();
    const outcome = await handleStripeEvent(
      state.deps,
      event("customer.subscription.updated", { ...ACTIVE_SUB, status: "past_due" }, "evt_2"),
    );
    expect(outcome).toEqual({ kind: "processed", type: "customer.subscription.updated" });
    expect(state.retrieved).toEqual([]);
    expect(state.upserts).toEqual([
      {
        userId: USER,
        provider: "stripe",
        providerRef: "sub_123",
        plan: "pro",
        status: "past_due",
        currentPeriodEnd: new Date(1798761600 * 1000),
      },
    ]);
  });

  test("subscription.deleted forces canceled even if the object says otherwise", async () => {
    const state = makeDeps();
    const outcome = await handleStripeEvent(
      state.deps,
      event("customer.subscription.deleted", { ...ACTIVE_SUB, status: "active" }, "evt_3"),
    );
    expect(outcome).toEqual({ kind: "processed", type: "customer.subscription.deleted" });
    expect(state.upserts[0]!.status).toBe("canceled");
  });

  test("invoice.payment_failed sets the retrieved subscription past_due", async () => {
    const state = makeDeps(false, ACTIVE_SUB);
    const outcome = await handleStripeEvent(
      state.deps,
      event("invoice.payment_failed", { id: "in_1", subscription: "sub_123" }, "evt_4"),
    );
    expect(outcome).toEqual({ kind: "processed", type: "invoice.payment_failed" });
    expect(state.retrieved).toEqual(["sub_123"]);
    expect(state.upserts[0]!.status).toBe("past_due");
    expect(state.upserts[0]!.userId).toBe(USER);
  });

  test("duplicate event is a no-op after the dedupe read", async () => {
    const state = makeDeps(true, ACTIVE_SUB);
    const outcome = await handleStripeEvent(
      state.deps,
      event("customer.subscription.updated", ACTIVE_SUB),
    );
    expect(outcome).toEqual({ kind: "duplicate" });
    expect(state.events).toEqual([]);
    expect(state.upserts).toEqual([]);
  });

  test("unknown types are ignored with 200 semantics and no record", async () => {
    const state = makeDeps();
    for (const type of [
      "invoice.paid",
      "charge.succeeded",
      "customer.created",
      "checkout.session.expired",
    ]) {
      const outcome = await handleStripeEvent(state.deps, event(type, { id: "x" }));
      expect(outcome).toEqual({ kind: "ignored", type, reason: "unhandled_type" });
    }
    expect(state.events).toEqual([]);
    expect(state.upserts).toEqual([]);
  });

  test("a non-uuid user id is logged and ignored, never written", async () => {
    const state = makeDeps();
    const outcome = await handleStripeEvent(
      state.deps,
      event("checkout.session.completed", {
        id: "cs_5",
        mode: "subscription",
        client_reference_id: "not-a-uuid",
        subscription: "sub_123",
      }),
    );
    expect(outcome).toEqual({
      kind: "ignored",
      type: "checkout.session.completed",
      reason: "bad_user",
    });
    expect(state.retrieved).toEqual([]);
    expect(state.upserts).toEqual([]);
  });

  test("a subscription without a metadata user is ignored", async () => {
    const state = makeDeps();
    const outcome = await handleStripeEvent(
      state.deps,
      event("customer.subscription.updated", {
        id: "sub_999",
        status: "active",
        metadata: {},
      }),
    );
    expect(outcome).toEqual({
      kind: "ignored",
      type: "customer.subscription.updated",
      reason: "bad_user",
    });
    expect(state.upserts).toEqual([]);
  });

  test("a failed upsert deletes the billing event and rethrows", async () => {
    const state = makeDeps(false, ACTIVE_SUB);
    state.deps.upsertSubscription = async () => {
      throw new Error("db down");
    };
    let caught: unknown = null;
    try {
      await handleStripeEvent(
        state.deps,
        event("customer.subscription.updated", ACTIVE_SUB),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(state.deleted).toEqual(["stripe:evt_1"]);
  });

  test("a missing retrieved subscription throws so the route answers 500", async () => {
    const state = makeDeps(false, null);
    await expect(
      handleStripeEvent(
        state.deps,
        event("invoice.payment_failed", { id: "in_2", subscription: "sub_gone" }),
      ),
    ).rejects.toThrow(/sub_gone/);
    // The failed attempt released its dedupe marker for the retry.
    expect(state.deleted).toEqual(["stripe:evt_1"]);
  });
});

// The widened upsert accepts the Stripe rows through the same queries factory
// the Stars path uses, and Stars rows still fit.
describe("widened upsert input", () => {
  test("stars and stripe rows are both assignable to the shared input", () => {
    const rows: UpsertSubscriptionInput[] = [
      {
        userId: USER,
        provider: "stars",
        providerRef: "charge_1",
        plan: "pro",
        status: "active",
        currentPeriodEnd: NOW,
      },
      subscriptionRowFromStripe(ACTIVE_SUB, USER),
      paynowRowFromSession({ id: "cs_x" }, USER, NOW) as StripeSubscriptionUpsert,
    ];
    expect(rows.map((row) => row.provider)).toEqual(["stars", "stripe", "stripe"]);
  });
});
