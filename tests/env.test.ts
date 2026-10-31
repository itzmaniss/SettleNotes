import { describe, expect, test } from "bun:test";
import { parseEnv } from "../lib/env";

const requiredOnly: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_BOT_USERNAME: "settle_test_bot",
  TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
  ALLOWED_TELEGRAM_IDS: "101, 202 ,303",
  MODEL_API_KEY: "test-model-key",
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_SECRET_KEY: "test-supabase-key",
  SUPABASE_DB_URL: "postgresql://test:test@localhost:5432/test",
  SESSION_SECRET: "test-session-secret-0123456789",
};

const validEnv: Record<string, string> = {
  ...requiredOnly,
  META_API_BASE_URL: "https://meta.example/v1",
  META_MODEL: "test-model",
  META_TRANSCRIBE_MODEL: "test-transcribe",
  META_DAILY_BUDGET_USD: "2.5",
  SUPABASE_STORAGE_BUCKET: "test-bucket",
  APP_BASE_URL: "https://app.example",
};

describe("parseEnv", () => {
  test("accepts a fully populated env", () => {
    const env = parseEnv(validEnv);
    expect(env.TELEGRAM_BOT_TOKEN).toBe("test-token");
    expect(env.ALLOWED_TELEGRAM_IDS).toEqual([101, 202, 303]);
    expect(env.META_DAILY_BUDGET_USD).toBe(2.5);
    expect(env.APP_BASE_URL).toBe("https://app.example");
  });

  test("applies defaults for unset optional variables", () => {
    const env = parseEnv(requiredOnly);
    expect(env.META_API_BASE_URL).toBe("https://api.meta.ai/v1");
    expect(env.META_MODEL).toBe("muse-spark-1.3");
    expect(env.META_TRANSCRIBE_MODEL).toBe("muse-voice-transcribe-1.0");
    expect(env.META_DAILY_BUDGET_USD).toBe(10);
    expect(env.SUPABASE_STORAGE_BUCKET).toBe("uploads");
    expect(env.APP_BASE_URL).toBe("http://localhost:3000");
  });

  test("BILLING_ENABLED defaults to false and only the string 'true' turns it on", () => {
    expect(parseEnv(requiredOnly).BILLING_ENABLED).toBe(false);
    expect(parseEnv({ ...requiredOnly, BILLING_ENABLED: "true" }).BILLING_ENABLED).toBe(true);
    expect(parseEnv({ ...requiredOnly, BILLING_ENABLED: "" }).BILLING_ENABLED).toBe(false);
    expect(() => parseEnv({ ...requiredOnly, BILLING_ENABLED: "yes" })).toThrow("BILLING_ENABLED");
  });

  test("Stripe variables are optional and blank counts as missing", () => {
    const withoutStripe = parseEnv(requiredOnly);
    expect(withoutStripe.STRIPE_SECRET_KEY).toBeUndefined();
    expect(withoutStripe.STRIPE_WEBHOOK_SECRET).toBeUndefined();
    expect(withoutStripe.STRIPE_PRICE_PRO_MONTHLY).toBeUndefined();
    expect(withoutStripe.STRIPE_PRICE_PRO_YEARLY).toBeUndefined();
    expect(withoutStripe.STRIPE_PRICE_PRO_YEARLY_PAYNOW).toBeUndefined();

    const withStripe = parseEnv({
      ...requiredOnly,
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_WEBHOOK_SECRET: "whsec_123",
      STRIPE_PRICE_PRO_MONTHLY: "price_monthly",
      STRIPE_PRICE_PRO_YEARLY: "price_yearly",
      STRIPE_PRICE_PRO_YEARLY_PAYNOW: "price_paynow",
    });
    expect(withStripe.STRIPE_SECRET_KEY).toBe("sk_test_123");
    expect(withStripe.STRIPE_WEBHOOK_SECRET).toBe("whsec_123");
    expect(withStripe.STRIPE_PRICE_PRO_MONTHLY).toBe("price_monthly");
    expect(withStripe.STRIPE_PRICE_PRO_YEARLY).toBe("price_yearly");
    expect(withStripe.STRIPE_PRICE_PRO_YEARLY_PAYNOW).toBe("price_paynow");

    // A whitespace-only value must not be mistaken for a configured key.
    expect(parseEnv({ ...requiredOnly, STRIPE_SECRET_KEY: "   " }).STRIPE_SECRET_KEY).toBeUndefined();
  });

  test("parses ALLOWED_TELEGRAM_IDS ignoring blanks", () => {
    const env = parseEnv({ ...requiredOnly, ALLOWED_TELEGRAM_IDS: "101, , 202, , " });
    expect(env.ALLOWED_TELEGRAM_IDS).toEqual([101, 202]);
  });

  test("rejects ALLOWED_TELEGRAM_IDS with no usable IDs", () => {
    let message = "";
    try {
      parseEnv({ ...requiredOnly, ALLOWED_TELEGRAM_IDS: " , , " });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("ALLOWED_TELEGRAM_IDS");
  });

  test("treats empty strings as missing", () => {
    expect(() => parseEnv({ ...requiredOnly, TELEGRAM_BOT_TOKEN: "   " })).toThrow(
      /TELEGRAM_BOT_TOKEN/
    );
  });

  test("rejects a too-short SESSION_SECRET", () => {
    expect(() => parseEnv({ ...requiredOnly, SESSION_SECRET: "short" })).toThrow(
      /SESSION_SECRET/
    );
  });

  test("error names missing variables and leaks no values", () => {
    let message = "";
    try {
      parseEnv({ TELEGRAM_BOT_TOKEN: "super-secret-token-value" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("SUPABASE_URL");
    expect(message).toContain("SESSION_SECRET");
    expect(message).not.toContain("super-secret-token-value");
  });
});
