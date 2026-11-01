import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import Stripe from "stripe";
import { parseEnv } from "../../lib/env";
import {
  assertManagedPaymentsParams,
  buildCheckoutParams,
  handleStripeEvent,
  managedPaymentsEnabled,
  startCheckoutFor,
  type CheckoutActionDeps,
  type StripeEnvConfig,
  type StripeEventLike,
  type StripeWebhookDeps,
} from "../../lib/billing/stripe";

const USER = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

// ---- Env flag ----------------------------------------------------------------

const requiredOnly: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_BOT_USERNAME: "settle_test_bot",
  TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
  ALLOWED_TELEGRAM_IDS: "101, 202 ,303",
  MODEL_API_KEY: "test-model-key",
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_SECRET_KEY: "test-supabase-key",
  SUPABASE_DB_URL: "postgresql://test:***@localhost:5432/test",
  SESSION_SECRET: "test-session-secret-0123456789",
};

describe("STRIPE_MANAGED_PAYMENTS env flag", () => {
  test("unset or blank defaults to false, true turns it on", () => {
    expect(parseEnv(requiredOnly).STRIPE_MANAGED_PAYMENTS).toBe(false);
    expect(parseEnv({ ...requiredOnly, STRIPE_MANAGED_PAYMENTS: "" }).STRIPE_MANAGED_PAYMENTS).toBe(
      false,
    );
    expect(parseEnv({ ...requiredOnly, STRIPE_MANAGED_PAYMENTS: "true" }).STRIPE_MANAGED_PAYMENTS).toBe(
      true,
    );
    expect(
      parseEnv({ ...requiredOnly, STRIPE_MANAGED_PAYMENTS: "false" }).STRIPE_MANAGED_PAYMENTS,
    ).toBe(false);
  });

  test("garbage fails loudly instead of silently flipping the switch", () => {
    expect(() => parseEnv({ ...requiredOnly, STRIPE_MANAGED_PAYMENTS: "yes" })).toThrow(
      "STRIPE_MANAGED_PAYMENTS",
    );
    expect(() => parseEnv({ ...requiredOnly, STRIPE_MANAGED_PAYMENTS: "on" })).toThrow(
      "STRIPE_MANAGED_PAYMENTS",
    );
  });

  test("managedPaymentsEnabled reads only the parsed flag", () => {
    expect(managedPaymentsEnabled({})).toBe(false);
    expect(managedPaymentsEnabled({ STRIPE_MANAGED_PAYMENTS: false })).toBe(false);
    expect(managedPaymentsEnabled({ STRIPE_MANAGED_PAYMENTS: true })).toBe(true);
    expect(managedPaymentsEnabled({ STRIPE_MANAGED_PAYMENTS: undefined })).toBe(false);
  });
});

// ---- Checkout params -----------------------------------------------------------

const baseArgs = {
  userId: USER,
  interval: "monthly" as const,
  baseUrl: "https://settle.example.com",
  priceId: "price_monthly",
};

describe("buildCheckoutParams with the flag off", () => {
  test("byte for byte today's object, monthly and yearly", () => {
    // Expected objects copied verbatim from the pre flag tests: the switch
    // default must produce exactly what the code produced before T28.
    for (const interval of ["monthly", "yearly"] as const) {
      const priceId = interval === "monthly" ? "price_monthly" : "price_yearly";
      const params = buildCheckoutParams({ ...baseArgs, interval, priceId });
      expect(params).toEqual({
        mode: "subscription",
        client_reference_id: USER,
        metadata: { user_id: USER },
        subscription_data: { metadata: { user_id: USER } },
        success_url: "https://settle.example.com/billing?status=success",
        cancel_url: "https://settle.example.com/billing?status=canceled",
        allow_promotion_codes: true,
        line_items: [{ price: priceId, quantity: 1 }],
      });
    }
    expect(buildCheckoutParams({ ...baseArgs }).managed_payments).toBeUndefined();
    expect("managed_payments" in buildCheckoutParams({ ...baseArgs })).toBe(false);
  });
});

describe("buildCheckoutParams with the flag on", () => {
  test("adds managed_payments enabled and nothing Stripe rejects, monthly and yearly", () => {
    for (const interval of ["monthly", "yearly"] as const) {
      const priceId = interval === "monthly" ? "price_monthly" : "price_yearly";
      const params = buildCheckoutParams({ ...baseArgs, interval, priceId, managedPayments: true });
      expect(params.managed_payments).toEqual({ enabled: true });
      expect(params.mode).toBe("subscription");
      expect(params.allow_promotion_codes).toBe(true);
      // Nothing from Stripe's unsupported list may ride along.
      expect(() => assertManagedPaymentsParams(params)).not.toThrow();
    }
  });
});

describe("assertManagedPaymentsParams", () => {
  test("accepts the params we actually build", () => {
    expect(() =>
      assertManagedPaymentsParams(
        buildCheckoutParams({ ...baseArgs, managedPayments: true }),
      ),
    ).not.toThrow();
    expect(() =>
      assertManagedPaymentsParams(
        buildCheckoutParams({ ...baseArgs, interval: "yearly", priceId: "price_yearly" }),
      ),
    ).not.toThrow();
  });

  test("rejects each unsupported key, naming the offender", () => {
    const bad: Record<string, unknown>[] = [
      { adaptive_pricing: { enabled: true } },
      { automatic_tax: { enabled: true } },
      { tax_id_collection: { enabled: true } },
      { subscription_data: { default_tax_rates: ["txr_1"] } },
      { payment_method_configuration: "pmc_1" },
      { payment_method_types: ["paynow"] },
      { allowed_payment_method_types: ["paynow"] },
    ];
    for (const extra of bad) {
      const key = Object.keys(extra)[0];
      const params = { ...buildCheckoutParams({ ...baseArgs, managedPayments: true }), ...extra };
      let message = "";
      try {
        assertManagedPaymentsParams(params as never);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, `expected a rejection for ${key}`).toContain(key);
    }
  });
});

// ---- The request Stripe actually receives ----------------------------------------

// Minimal in memory HTTP client so the SDK encodes the params for real but no
// network call happens.
function fakeHttpClient(bodies: string[]): Stripe.HttpClient {
  return {
    getClientName: () => "fake-http-client",
    makeRequest: async (_host, _port, _path, _method, _headers, requestData) => {
      bodies.push(requestData);
      return {
        getStatusCode: () => 200,
        getHeaders: () => ({ "request-id": "req_fake" }),
        // The SDK writes headers onto this object; it must not be null.
        getRawResponse: () => ({ headers: { "request-id": "req_fake" } }),
        toStream: () => null,
        toJSON: async () => ({ id: "cs_encoded", object: "checkout.session" }),
      };
    },
  };
}

describe("encoded checkout request through the real SDK", () => {
  test("flag on: managed_payments[enabled]=true reaches the form encoded body", async () => {
    const bodies: string[] = [];
    const client = new Stripe("sk_test_encoded_request", { httpClient: fakeHttpClient(bodies) });
    await client.checkout.sessions.create(
      buildCheckoutParams({ ...baseArgs, managedPayments: true }),
    );
    expect(bodies).toHaveLength(1);
    const body = decodeURIComponent(bodies[0] ?? "");
    expect(body).toContain("managed_payments[enabled]=true");
    // The unsupported keys must be absent from the wire format too.
    expect(body).not.toContain("automatic_tax");
    expect(body).not.toContain("payment_method_types");
    expect(body).not.toContain("allowed_payment_method_types");
  });

  test("flag off: no managed_payments anywhere in the body", async () => {
    const bodies: string[] = [];
    const client = new Stripe("sk_test_encoded_request", { httpClient: fakeHttpClient(bodies) });
    await client.checkout.sessions.create(buildCheckoutParams({ ...baseArgs }));
    expect(bodies).toHaveLength(1);
    const body = decodeURIComponent(bodies[0] ?? "");
    expect(body).not.toContain("managed_payments");
    expect(body).toContain("mode=subscription");
    expect(body).toContain("allow_promotion_codes=true");
  });
});

// ---- startCheckoutFor under the flag ----------------------------------------------

type CapturedCheckout = {
  deps: CheckoutActionDeps;
  created: unknown[];
};

function checkoutDeps(managedPayments: boolean): CapturedCheckout {
  const created: unknown[] = [];
  const env: StripeEnvConfig = {
    STRIPE_SECRET_KEY: "sk_test_123",
    STRIPE_WEBHOOK_SECRET: "whsec_123",
    STRIPE_PRICE_PRO_MONTHLY: "price_monthly",
    STRIPE_PRICE_PRO_YEARLY: "price_yearly",
    STRIPE_PRICE_PRO_YEARLY_PAYNOW: "price_paynow",
    STRIPE_MANAGED_PAYMENTS: managedPayments,
  };
  return {
    created,
    deps: {
      sessionUserId: async () => USER,
      billingEnabled: () => true,
      env: () => env,
      baseUrl: () => "https://settle.example.com",
      createSession: async (params) => {
        created.push(params);
        return { url: "https://checkout.stripe.com/c/pay/cs_test" };
      },
      log: () => {},
    },
  };
}

describe("startCheckoutFor under Managed Payments", () => {
  test("paynow gets a friendly refusal and no session is ever created", async () => {
    const { deps, created } = checkoutDeps(true);
    const url = await startCheckoutFor("paynow", deps);
    expect(url).toBe("/billing?status=paynow_unavailable");
    expect(created).toEqual([]);
  });

  test("monthly and yearly still create sessions with the flag riding along", async () => {
    const { deps, created } = checkoutDeps(true);
    const monthly = await startCheckoutFor("monthly", deps);
    const yearly = await startCheckoutFor("yearly", deps);
    expect(monthly).toBe("https://checkout.stripe.com/c/pay/cs_test");
    expect(yearly).toBe("https://checkout.stripe.com/c/pay/cs_test");
    expect(created).toHaveLength(2);
    for (const params of created) {
      expect((params as { managed_payments?: unknown }).managed_payments).toEqual({
        enabled: true,
      });
    }
  });

  test("flag off: paynow behaves exactly as before", async () => {
    const { deps, created } = checkoutDeps(false);
    const url = await startCheckoutFor("paynow", deps);
    expect(url).toBe("https://checkout.stripe.com/c/pay/cs_test");
    expect(created).toHaveLength(1);
    const params = created[0] as Record<string, unknown>;
    expect(params.mode).toBe("payment");
    expect(params.allowed_payment_method_types).toEqual(["paynow"]);
    expect("managed_payments" in params).toBe(false);
  });
});

// ---- Webhook safety: plan and period come from the price, not the money -------

function event(type: string, object: unknown, id = "evt_managed_1"): StripeEventLike {
  return { id, type, data: { object } };
}

function webhookDeps(retrieved: unknown): { upserts: unknown[]; deps: StripeWebhookDeps } {
  const upserts: unknown[] = [];
  const deps: StripeWebhookDeps = {
    findBillingEvent: async () => false,
    recordBillingEvent: async () => {},
    deleteBillingEvent: async () => {},
    upsertSubscription: async (row) => {
      upserts.push(row);
    },
    retrieveSubscription: async () => retrieved as never,
    now: () => new Date("2026-10-31T09:00:00.000Z"),
    log: () => {},
  };
  return { upserts, deps };
}

// A Managed Payments buyer abroad: Stripe reports the charge in their local
// currency and the amount no longer matches the S$7.99 the price id encodes.
const USD_SUBSCRIPTION = {
  id: "sub_managed_usd",
  status: "active",
  metadata: { user_id: USER },
  customer: "cus_managed",
  currency: "usd",
  items: {
    data: [
      {
        price: { id: "price_monthly", currency: "usd", unit_amount: 1099 },
        current_period_end: 1798761600,
      },
    ],
  },
};

describe("webhook safety under Managed Payments", () => {
  test("checkout with a USD subscription still lands plan pro at the right period end", async () => {
    const { deps, upserts } = webhookDeps(USD_SUBSCRIPTION);
    const outcome = await handleStripeEvent(
      deps,
      event("checkout.session.completed", {
        id: "cs_managed_1",
        mode: "subscription",
        client_reference_id: USER,
        subscription: "sub_managed_usd",
        payment_status: "paid",
        metadata: { user_id: USER },
        // Managed Payments adds currency fields on the session too; none of
        // it may influence the row.
        currency: "usd",
        amount_total: 1099,
      }),
    );
    expect(outcome).toEqual({ kind: "processed", type: "checkout.session.completed" });
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toEqual({
      userId: USER,
      provider: "stripe",
      providerRef: "sub_managed_usd",
      plan: "pro",
      status: "active",
      currentPeriodEnd: new Date(1798761600 * 1000),
    });
  });

  test("subscription.updated with a different currency and amount keeps plan pro", async () => {
    const { deps, upserts } = webhookDeps(null);
    const outcome = await handleStripeEvent(
      deps,
      event("customer.subscription.updated", USD_SUBSCRIPTION),
    );
    expect(outcome).toEqual({ kind: "processed", type: "customer.subscription.updated" });
    expect(upserts[0]).toMatchObject({ plan: "pro", status: "active", userId: USER });
  });

  test("a refund by itself changes nothing; the row only moves on subscription events", async () => {
    const { deps, upserts } = webhookDeps(USD_SUBSCRIPTION);
    const refundOutcome = await handleStripeEvent(
      deps,
      event("charge.refunded", { id: "ch_1", refunded: true }, "evt_refund"),
    );
    expect(refundOutcome).toEqual({
      kind: "ignored",
      type: "charge.refunded",
      reason: "unhandled_type",
    });
    expect(upserts).toEqual([]);
    // The cancellation Stripe (or the student via link.com) makes arrives as
    // the same deleted event as before and ends in the same row state.
    const cancelOutcome = await handleStripeEvent(
      deps,
      event(
        "customer.subscription.deleted",
        { ...USD_SUBSCRIPTION, status: "active" },
        "evt_cancel",
      ),
    );
    expect(cancelOutcome).toEqual({ kind: "processed", type: "customer.subscription.deleted" });
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toEqual({
      userId: USER,
      provider: "stripe",
      providerRef: "sub_managed_usd",
      plan: "pro",
      status: "canceled",
      currentPeriodEnd: new Date(1798761600 * 1000),
    });
  });
});

// ---- Copy hygiene ----------------------------------------------------------------

// Every file T28 created or edited stays free of em and en dashes.
const T28_FILES = [
  "../../lib/env.ts",
  "../../lib/billing/stripe.ts",
  "../../lib/billing/view.ts",
  "../../lib/billing/web-copy.ts",
  "../../components/billing/billing-panel.tsx",
  "../../scripts/delete-user.ts",
  "../../.env.example",
  "../../docs/STRIPE-MANAGED-PAYMENTS.md",
  "../../docs/DEPLOY.md",
  "../../docs/LAUNCH.md",
  "../../tests/billing/managed-payments.test.ts",
  "../../tests/billing-page/view.test.tsx",
  "../../tests/privacy/stripe-reminder.test.ts",
  "../../tests/deploy/deploy-doc.test.ts",
];

describe("no em or en dashes in T28 files", () => {
  test("every touched file scans clean", () => {
    for (const file of T28_FILES) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      const at = source.search(/[\u2013\u2014]/);
      expect([file, at]).toEqual([file, -1]);
    }
  });
});
