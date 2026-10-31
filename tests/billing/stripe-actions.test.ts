import { describe, expect, test } from "bun:test";
import type Stripe from "stripe";
import {
  openPortalFor,
  startCheckoutFor,
  type CheckoutActionDeps,
  type PortalActionDeps,
} from "../../lib/billing/stripe";

const USER = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
const BASE = "https://settle.example.com";

const fullEnv = {
  STRIPE_SECRET_KEY: "sk_test_123",
  STRIPE_WEBHOOK_SECRET: "whsec_123",
  STRIPE_PRICE_PRO_MONTHLY: "price_monthly",
  STRIPE_PRICE_PRO_YEARLY: "price_yearly",
  STRIPE_PRICE_PRO_YEARLY_PAYNOW: "price_paynow",
};

type Created = { params: Stripe.Checkout.SessionCreateParams };

function makeCheckoutDeps(overrides: {
  env?: Record<string, string | undefined>;
  billingEnabled?: boolean;
  userId?: string | null;
  url?: string | null;
  failCreate?: boolean;
} = {}): { deps: CheckoutActionDeps; created: Created[] } {
  const created: Created[] = [];
  const deps: CheckoutActionDeps = {
    sessionUserId: async () => overrides.userId ?? USER,
    billingEnabled: () => overrides.billingEnabled ?? true,
    env: () => overrides.env ?? fullEnv,
    baseUrl: () => BASE,
    createSession: async (params) => {
      if (overrides.failCreate) throw new Error("stripe down");
      created.push({ params });
      return { url: overrides.url === undefined ? "https://checkout.stripe.com/c/abc" : overrides.url };
    },
    log: () => {},
  };
  return { deps, created };
}

describe("startCheckoutFor", () => {
  test("monthly and yearly build subscription sessions for the session user", async () => {
    for (const interval of ["monthly", "yearly"] as const) {
      const { deps, created } = makeCheckoutDeps();
      const url = await startCheckoutFor(interval, deps);
      expect(url).toBe("https://checkout.stripe.com/c/abc");
      expect(created).toHaveLength(1);
      expect(created[0]!.params.mode).toBe("subscription");
      expect(created[0]!.params.client_reference_id).toBe(USER);
      expect(created[0]!.params.line_items).toEqual([
        {
          price: interval === "monthly" ? "price_monthly" : "price_yearly",
          quantity: 1,
        },
      ]);
    }
  });

  test("paynow builds the one-time session only when its price exists", async () => {
    const { deps, created } = makeCheckoutDeps();
    const url = await startCheckoutFor("paynow", deps);
    expect(url).toBe("https://checkout.stripe.com/c/abc");
    expect(created[0]!.params.mode).toBe("payment");
    expect(created[0]!.params.metadata).toEqual({ user_id: USER, kind: "paynow_yearly" });

    const without = makeCheckoutDeps({
      env: { ...fullEnv, STRIPE_PRICE_PRO_YEARLY_PAYNOW: undefined },
    });
    expect(await startCheckoutFor("paynow", without.deps)).toBe("/billing?status=error");
    expect(without.created).toEqual([]);
  });

  test("a forged interval value is refused", async () => {
    for (const interval of ["weekly", "lifetime", "", null, undefined, 42, ["monthly"]]) {
      const { deps, created } = makeCheckoutDeps();
      expect(await startCheckoutFor(interval, deps)).toBe("/billing?status=error");
      expect(created).toEqual([]);
    }
  });

  test("billing disabled or Stripe unconfigured never opens checkout", async () => {
    const off = makeCheckoutDeps({ billingEnabled: false });
    expect(await startCheckoutFor("monthly", off.deps)).toBe("/billing?status=error");
    expect(off.created).toEqual([]);

    const unconfigured = makeCheckoutDeps({
      env: { ...fullEnv, STRIPE_SECRET_KEY: undefined },
    });
    expect(await startCheckoutFor("monthly", unconfigured.deps)).toBe("/billing?status=error");
    expect(unconfigured.created).toEqual([]);
  });

  test("the user id comes from the session only; a bad one fails closed", async () => {
    const { deps, created } = makeCheckoutDeps({ userId: "not-a-uuid" });
    expect(await startCheckoutFor("monthly", deps)).toBe("/billing?status=error");
    expect(created).toEqual([]);
  });

  test("a Stripe failure logs one line and lands on the error banner", async () => {
    const lines: string[] = [];
    const { deps, created } = makeCheckoutDeps({ failCreate: true });
    deps.log = (message) => lines.push(message);
    const url = await startCheckoutFor("monthly", deps);
    expect(url).toBe("/billing?status=error");
    expect(created).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("monthly checkout failed");
  });

  test("a session without a url still ends on the error banner", async () => {
    const { deps } = makeCheckoutDeps({ url: null });
    expect(await startCheckoutFor("yearly", deps)).toBe("/billing?status=error");
  });
});

function makePortalDeps(overrides: {
  ref?: string | null;
  customer?: unknown;
  url?: string | null;
  failRetrieve?: boolean;
  failCreate?: boolean;
} = {}): { deps: PortalActionDeps; portalParams: Stripe.BillingPortal.SessionCreateParams[] } {
  const portalParams: Stripe.BillingPortal.SessionCreateParams[] = [];
  const deps: PortalActionDeps = {
    sessionUserId: async () => USER,
    baseUrl: () => BASE,
    latestStripeRef: async () =>
      overrides.ref === undefined ? "sub_123" : overrides.ref,
    retrieveSubscription: async (id) => {
      if (overrides.failRetrieve) throw new Error("stripe down");
      return {
        id,
        customer: (overrides.customer === undefined ? "cus_777" : overrides.customer) as never,
      };
    },
    createPortalSession: async (params) => {
      if (overrides.failCreate) throw new Error("portal down");
      portalParams.push(params);
      return { url: overrides.url === undefined ? "https://billing.stripe.com/p/xyz" : overrides.url };
    },
    log: () => {},
  };
  return { deps, portalParams };
}

describe("openPortalFor", () => {
  test("creates a portal session for the subscription's customer", async () => {
    const { deps, portalParams } = makePortalDeps();
    const url = await openPortalFor(deps);
    expect(url).toBe("https://billing.stripe.com/p/xyz");
    expect(portalParams).toEqual([
      { customer: "cus_777", return_url: "https://settle.example.com/billing" },
    ]);
  });

  test("a paynow ref or missing ref has no portal", async () => {
    for (const ref of [null, "", "paynow:cs_1", "gift:manual"]) {
      const { deps, portalParams } = makePortalDeps({ ref });
      expect(await openPortalFor(deps)).toBe("/billing?status=error");
      expect(portalParams).toEqual([]);
    }
  });

  test("a subscription without a usable customer fails closed", async () => {
    const { deps, portalParams } = makePortalDeps({ customer: null });
    expect(await openPortalFor(deps)).toBe("/billing?status=error");
    expect(portalParams).toEqual([]);
  });

  test("Stripe failures land on the error banner", async () => {
    const failing = makePortalDeps({ failCreate: true });
    expect(await openPortalFor(failing.deps)).toBe("/billing?status=error");
    const retrieving = makePortalDeps({ failRetrieve: true });
    expect(await openPortalFor(retrieving.deps)).toBe("/billing?status=error");
  });
});
