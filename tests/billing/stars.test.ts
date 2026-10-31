import { describe, expect, test } from "bun:test";
import type { Plan, PlanId } from "../../lib/billing/plans";
import { PLANS } from "../../lib/billing/plans";
import {
  INVOICE_DESCRIPTION,
  INVOICE_LABEL,
  INVOICE_TITLE,
  REFUND_WINDOW_DAYS,
  STARS_CURRENCY,
  STARS_SUBSCRIPTION_PERIOD_SECONDS,
  buildStarsPayload,
  createStarsInvoiceLink,
  parseStarsPayload,
  starsOffer,
  subscriptionFromPayment,
  validatePreCheckout,
  type SuccessfulPaymentLike,
} from "../../lib/billing/stars";

const USER_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const CHARGE_ID = "chg_1234567890";

// ---- payload build and parse ----------------------------------------------

describe("buildStarsPayload and parseStarsPayload", () => {
  test("round trips the settle:pro:monthly:<uuid> shape", () => {
    const payload = buildStarsPayload(USER_ID, "monthly");
    expect(payload).toBe(`settle:pro:monthly:${USER_ID}`);
    expect(Buffer.byteLength(payload, "utf8")).toBeLessThanOrEqual(128);
    expect(parseStarsPayload(payload)).toEqual({
      plan: "pro",
      interval: "monthly",
      userId: USER_ID,
    });
  });

  test("defaults to monthly", () => {
    expect(buildStarsPayload(USER_ID)).toBe(buildStarsPayload(USER_ID, "monthly"));
  });

  test("rejects garbage payloads", () => {
    const garbage = [
      "",
      "settle",
      "settle:pro",
      "settle:pro:monthly",
      "settle:free:monthly:a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
      "settle:pro:yearly:a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
      "settle:pro:monthly:not-a-uuid",
      "settle:pro:monthly:a1b2c3d4e5f64a7b8c9d0e1f2a3b4c5d",
      "settle:pro:monthly:A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D",
      `settle:pro:monthly:${USER_ID}:extra`,
      "other:pro:monthly:a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
      `prefix settle:pro:monthly:${USER_ID}`,
    ];
    for (const payload of garbage) {
      expect(parseStarsPayload(payload)).toBeNull();
    }
  });

  test("build refuses a non-uuid user id and a bad interval", () => {
    expect(() => buildStarsPayload("42")).toThrow(/uuid/);
    // @ts-expect-error the interval type only allows monthly
    expect(() => buildStarsPayload(USER_ID, "yearly")).toThrow(/interval/);
  });
});

// ---- offer -----------------------------------------------------------------

describe("starsOffer", () => {
  const priced: Record<PlanId, Plan> = {
    free: PLANS.free,
    pro: { ...PLANS.pro, price: { ...PLANS.pro.price, stars: { monthly: 600 } } },
  };
  const unpriced: Record<PlanId, Plan> = {
    free: PLANS.free,
    pro: { ...PLANS.pro, price: { ...PLANS.pro.price, stars: null } },
  };

  test("billing off wins over everything", () => {
    expect(starsOffer(priced, false)).toEqual({ available: false, reason: "billing_off" });
    expect(starsOffer(unpriced, false)).toEqual({ available: false, reason: "billing_off" });
  });

  test("no price means no sale once billing is on", () => {
    expect(starsOffer(unpriced, true)).toEqual({ available: false, reason: "no_price" });
  });

  test("a priced plan is available with the configured amount", () => {
    expect(starsOffer(priced, true)).toEqual({ available: true, amount: 600 });
  });

  test("the real PLANS config carries the 600 Stars price", () => {
    expect(PLANS.pro.price.stars).toEqual({ monthly: 600 });
    expect(starsOffer(PLANS, true)).toEqual({ available: true, amount: 600 });
  });

  test("a nonsense price counts as unpriced", () => {
    const zero: Record<PlanId, Plan> = {
      free: PLANS.free,
      pro: { ...PLANS.pro, price: { ...PLANS.pro.price, stars: { monthly: 0 } } },
    };
    expect(starsOffer(zero, true)).toEqual({ available: false, reason: "no_price" });
  });
});

// ---- pre-checkout validation ----------------------------------------------

describe("validatePreCheckout", () => {
  const PAYLOAD = buildStarsPayload(USER_ID);
  const base = {
    query: {
      currency: STARS_CURRENCY,
      total_amount: 600,
      invoice_payload: PAYLOAD,
      fromTelegramId: 101,
    },
    expected: { amount: 600 as number | null, userId: USER_ID },
    billingEnabled: true,
  };

  test("accepts a clean stars checkout", () => {
    expect(validatePreCheckout(base)).toEqual({ ok: true });
  });

  test("rejects a wrong currency", () => {
    const verdict = validatePreCheckout({
      ...base,
      query: { ...base.query, currency: "USD" },
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toMatch(/Stars/);
  });

  test("rejects a wrong amount", () => {
    const verdict = validatePreCheckout({
      ...base,
      query: { ...base.query, total_amount: 500 },
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toMatch(/not been charged/);
  });

  test("rejects a payload that belongs to another user", () => {
    const verdict = validatePreCheckout({
      ...base,
      expected: { amount: 600, userId: "b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d" },
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toMatch(/different account/);
  });

  test("rejects a malformed payload", () => {
    const verdict = validatePreCheckout({
      ...base,
      query: { ...base.query, invoice_payload: "free stars please" },
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toMatch(/could not read/);
  });

  test("rejects when billing is disabled", () => {
    const verdict = validatePreCheckout({ ...base, billingEnabled: false });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toMatch(/not been charged/);
  });

  test("rejects when the price is not configured", () => {
    const verdict = validatePreCheckout({ ...base, expected: { amount: null, userId: USER_ID } });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toMatch(/not been charged/);
  });

  test("every rejection message is plain: no dashes, no fiat prices", () => {
    const verdicts = [
      validatePreCheckout({ ...base, billingEnabled: false }),
      validatePreCheckout({ ...base, expected: { amount: null, userId: USER_ID } }),
      validatePreCheckout({ ...base, query: { ...base.query, currency: "USD" } }),
      validatePreCheckout({ ...base, query: { ...base.query, invoice_payload: "junk" } }),
      validatePreCheckout({ ...base, expected: { amount: 600, userId: "b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d" } }),
      validatePreCheckout({ ...base, query: { ...base.query, total_amount: 1 } }),
    ];
    for (const verdict of verdicts) {
      if (verdict.ok) continue;
      expect(verdict.message).not.toMatch(/[\u2013\u2014]/);
      expect(verdict.message).not.toMatch(/S\$|US\$|\$/i);
      expect(verdict.message).not.toMatch(/website|stripe|dashboard/i);
    }
  });
});

// ---- payment to subscription row ------------------------------------------

describe("subscriptionFromPayment", () => {
  const NOW = new Date("2026-11-01T02:00:00Z");
  const payment: SuccessfulPaymentLike = {
    currency: STARS_CURRENCY,
    total_amount: 600,
    invoice_payload: buildStarsPayload(USER_ID),
    telegram_payment_charge_id: CHARGE_ID,
    provider_payment_charge_id: "prov_1",
  };

  test("uses the subscription expiration date when Telegram sends one", () => {
    const row = subscriptionFromPayment(
      { ...payment, subscription_expiration_date: 1793955600, is_recurring: true },
      USER_ID,
      NOW,
    );
    expect(row).toEqual({
      userId: USER_ID,
      provider: "stars",
      providerRef: CHARGE_ID,
      plan: "pro",
      status: "active",
      currentPeriodEnd: new Date(1793955600 * 1000),
    });
  });

  test("falls back to now plus 30 days without an expiration date", () => {
    const row = subscriptionFromPayment(payment, USER_ID, NOW);
    expect(row.currentPeriodEnd.getTime()).toBe(
      NOW.getTime() + STARS_SUBSCRIPTION_PERIOD_SECONDS * 1000,
    );
  });
});

// ---- invoice link args -----------------------------------------------------

describe("createStarsInvoiceLink", () => {
  test("passes the exact Telegram Stars invoice args", async () => {
    const calls: unknown[][] = [];
    const link = await createStarsInvoiceLink(
      {
        createInvoiceLink: async (...args) => {
          calls.push(args);
          return "https://t.me/$invoice";
        },
      },
      { userId: USER_ID, amount: 600 },
    );
    expect(link).toBe("https://t.me/$invoice");
    expect(calls[0]).toEqual([
      INVOICE_TITLE,
      INVOICE_DESCRIPTION,
      buildStarsPayload(USER_ID),
      "", // empty provider token: mandatory for Stars
      STARS_CURRENCY,
      [{ label: INVOICE_LABEL, amount: 600 }],
      { subscription_period: STARS_SUBSCRIPTION_PERIOD_SECONDS },
    ]);
    expect(INVOICE_TITLE).toBe("Settle Pro");
    expect(INVOICE_LABEL).toBe("Settle Pro, 1 month");
    expect(STARS_SUBSCRIPTION_PERIOD_SECONDS).toBe(2_592_000);
    expect(REFUND_WINDOW_DAYS).toBe(7);
  });
});
