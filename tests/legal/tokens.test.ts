import { describe, expect, test } from "bun:test";

import { PLANS, formatPrice } from "../../lib/billing/plans";
import {
  LEGAL_TOKEN_NAMES,
  fillTokens,
  formatLegalDate,
  legalTokens,
  type LegalTokenEnv,
} from "../../lib/legal/tokens";

const FULL_ENV: LegalTokenEnv = {
  LEGAL_OPERATOR_NAME: "Sentinel Operator",
  LEGAL_SUPPORT_EMAIL: "legal-sentinel@example.com",
  LEGAL_SUPABASE_REGION: "ap-southeast-1",
  LEGAL_VPS_PROVIDER: "SentinelHost",
  STRIPE_MANAGED_PAYMENTS: false,
};

describe("legalTokens", () => {
  test("returns exactly the eleven known tokens, all non empty", () => {
    const tokens = legalTokens({ env: FULL_ENV, version: "2026-11-01" });
    expect(Object.keys(tokens).sort()).toEqual([...LEGAL_TOKEN_NAMES].sort());
    for (const name of LEGAL_TOKEN_NAMES) {
      expect(tokens[name].length).toBeGreaterThan(0);
    }
  });

  test("formats the effective date by hand", () => {
    const tokens = legalTokens({ env: FULL_ENV, version: "2026-11-01" });
    expect(tokens.effective_date).toBe("1 November 2026");
  });

  test("formats other dates the same way", () => {
    expect(formatLegalDate("2026-01-05")).toBe("5 January 2026");
    expect(formatLegalDate("2027-12-31")).toBe("31 December 2027");
  });

  test("an unreadable version comes back unchanged", () => {
    expect(formatLegalDate("nonsense")).toBe("nonsense");
    expect(formatLegalDate("2026-13-01")).toBe("2026-13-01");
    expect(formatLegalDate("2026-11-1")).toBe("2026-11-1");
  });

  test("prices come from plans.ts through formatPrice", () => {
    const tokens = legalTokens({ env: FULL_ENV, version: "2026-11-01" });
    expect(tokens.price_pro_monthly).toBe("S$7.99");
    expect(tokens.price_pro_yearly).toBe("S$63.99");
    expect(tokens.price_pro_monthly).toBe(
      formatPrice(PLANS.pro.price.monthly, PLANS.pro.price.currency),
    );
    expect(tokens.price_pro_yearly).toBe(
      formatPrice(PLANS.pro.price.yearly, PLANS.pro.price.currency),
    );
    expect(tokens.stars_monthly).toBe("600");
    expect(tokens.stars_monthly).toBe(String(PLANS.pro.price.stars?.monthly));
  });

  test("trims the env values", () => {
    const tokens = legalTokens({
      env: { ...FULL_ENV, LEGAL_OPERATOR_NAME: "  Padded Name  " },
      version: "2026-11-01",
    });
    expect(tokens.operator_name).toBe("Padded Name");
  });

  test("a missing or blank value shows the MISSING marker naming the variable", () => {
    const tokens = legalTokens({ env: {}, version: "2026-11-01" });
    expect(tokens.operator_name).toBe("[[MISSING: LEGAL_OPERATOR_NAME]]");
    expect(tokens.support_email).toBe("[[MISSING: LEGAL_SUPPORT_EMAIL]]");
    expect(tokens.supabase_region).toBe("[[MISSING: LEGAL_SUPABASE_REGION]]");
    expect(tokens.vps_provider).toBe("[[MISSING: LEGAL_VPS_PROVIDER]]");
    const blank = legalTokens({
      env: { LEGAL_OPERATOR_NAME: "   " },
      version: "2026-11-01",
    });
    expect(blank.operator_name).toBe("[[MISSING: LEGAL_OPERATOR_NAME]]");
  });

  test("managed payments off sentences are byte exact", () => {
    const tokens = legalTokens({ env: FULL_ENV, version: "2026-11-01" });
    expect(tokens.web_cancel_sentence).toBe(
      "You can cancel a web subscription from the billing page in the dashboard, which opens Stripe's customer portal.",
    );
    expect(tokens.stripe_refund_sentence).toBe(
      "Refunds for web payments are issued by Settle through Stripe.",
    );
    expect(tokens.stripe_role_sentence).toBe(
      "Stripe receives your payment details. Settle receives only what it needs to manage your subscription.",
    );
  });

  test("managed payments on sentences are byte exact", () => {
    const tokens = legalTokens(
      { env: { ...FULL_ENV, STRIPE_MANAGED_PAYMENTS: true }, version: "2026-11-01" },
    );
    expect(tokens.web_cancel_sentence).toBe(
      "You can cancel a web subscription from the billing page in the dashboard, which opens Stripe's customer portal, or on Link's website (link.com).",
    );
    expect(tokens.stripe_refund_sentence).toBe(
      "Because Stripe is the seller of record for web payments, Stripe may also issue a refund itself within 60 days in some cases, and its support team handles payment questions through Link.",
    );
    expect(tokens.stripe_role_sentence).toBe(
      "Stripe, through its Link service, is the seller of record for web card subscriptions. It collects your payment details and billing address, handles tax and payment support, and shares with Settle only what Settle needs to manage your subscription.",
    );
  });
});

describe("fillTokens", () => {
  test("replaces every token", () => {
    const filled = fillTokens(
      "Pro costs {{price_pro_monthly}}, email {{support_email}}, since {{effective_date}}.",
      legalTokens({ env: FULL_ENV, version: "2026-11-01" }),
    );
    expect(filled).toBe(
      "Pro costs S$7.99, email legal-sentinel@example.com, since 1 November 2026.",
    );
  });

  test("an unknown token stays visible and named", () => {
    expect(fillTokens("Hello {{nope_here}}.", {})).toBe("Hello [[UNKNOWN TOKEN: nope_here]].");
  });

  test("collapses accidental double spaces, including ones inside values", () => {
    expect(fillTokens("a  b {{x}}  c", { x: "v  w" })).toBe("a b v w c");
    expect(fillTokens("no doubles here", {})).toBe("no doubles here");
  });

  test("leaves newlines and non token text untouched", () => {
    expect(fillTokens("line one\nline **two** [[COUNSEL: ask.]]", {})).toBe(
      "line one\nline **two** [[COUNSEL: ask.]]",
    );
  });
});
