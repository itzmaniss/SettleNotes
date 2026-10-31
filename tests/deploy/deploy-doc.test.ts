import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseEnv } from "../../lib/env";

const doc = readFileSync(new URL("../../docs/DEPLOY.md", import.meta.url), "utf8");

// Derive the required variable names from the zod schema in lib/env.ts by
// parsing the "X missing" list from parseEnv({}), so a new required variable
// fails this test until the runbook mentions it.
function requiredEnvNames(): string[] {
  try {
    parseEnv({});
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [...message.matchAll(/([A-Z][A-Z0-9_]*) missing/g)].map((match) => match[1]);
  }
}

// Every variable the schema knows about, including the ones with defaults.
const allEnvNames = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_BOT_USERNAME",
  "TELEGRAM_WEBHOOK_SECRET",
  "ALLOWED_TELEGRAM_IDS",
  "MODEL_API_KEY",
  "META_API_BASE_URL",
  "META_MODEL",
  "META_TRANSCRIBE_MODEL",
  "META_DAILY_BUDGET_USD",
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_STORAGE_BUCKET",
  "SUPABASE_DB_URL",
  "SESSION_SECRET",
  "APP_BASE_URL",
  "BILLING_ENABLED",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_PRO_MONTHLY",
  "STRIPE_PRICE_PRO_YEARLY",
  "STRIPE_PRICE_PRO_YEARLY_PAYNOW",
];

describe("docs/DEPLOY.md", () => {
  test("mentions every required variable name from lib/env.ts", () => {
    const required = requiredEnvNames();
    expect(required.length).toBeGreaterThan(0);
    for (const name of required) {
      expect(doc).toContain(name);
    }
  });

  test("mentions every schema variable, including defaults", () => {
    for (const name of allEnvNames) {
      expect(doc).toContain(name);
    }
  });

  test("covers the docker compose runbook essentials", () => {
    for (const snippet of [
      "docker compose",
      "Caddy",
      "chmod 600",
      "restart: unless-stopped",
      "0001_init.sql",
      "0002_billing.sql",
      "0003_pending_actions.sql",
      "openssl rand -hex 32",
      "set-webhook",
      "/api/health",
      "A record",
      "80",
      "443",
    ]) {
      expect(doc).toContain(snippet);
    }
  });

  test("contains no em or en dashes", () => {
    expect(doc).not.toMatch(/[\u2013\u2014]/);
  });
});
