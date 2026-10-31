import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseEnv } from "../../lib/env";

const doc = readFileSync(new URL("../../docs/LAUNCH.md", import.meta.url), "utf8");

// Every variable name the schema knows about. The runbook has to mention all
// of them: it is the one file a tired person reads while filling the env file.
const allEnvNames = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_BOT_USERNAME",
  "TELEGRAM_WEBHOOK_SECRET",
  "ALLOWED_TELEGRAM_IDS",
  "ALLOWLIST_ENABLED",
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

describe("docs/LAUNCH.md", () => {
  test("mentions every variable name from lib/env.ts", () => {
    for (const name of allEnvNames) {
      expect(doc).toContain(name);
    }
  });

  test("covers the required variables too, derived from the schema itself", () => {
    let required: string[] = [];
    try {
      parseEnv({});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      required = [...message.matchAll(/([A-Z][A-Z0-9_]*) missing/g)].map((m) => m[1]);
    }
    expect(required.length).toBeGreaterThan(0);
    for (const name of required) {
      expect(doc).toContain(name);
    }
  });

  test("every numbered step carries an owner tag", () => {
    const stepLines = doc.split("\n").filter((line) => /^\s*- \[ \] \*\*/.test(line));
    expect(stepLines.length).toBeGreaterThanOrEqual(25);
    for (const line of stepLines) {
      expect(line).toMatch(/\*\*\[(User|Manager)\]\*\*/);
    }
  });

  test("tells the switch story in the safe order inside the switch section", () => {
    const sectionStart = doc.indexOf("## 7. THE SWITCH");
    const sectionEnd = doc.indexOf("## 8.");
    expect(sectionStart).toBeGreaterThan(-1);
    const section = doc.slice(sectionStart, sectionEnd);
    const billingFirst = section.indexOf("BILLING_ENABLED=true");
    const openSecond = section.indexOf("ALLOWLIST_ENABLED=false");
    expect(billingFirst).toBeGreaterThan(-1);
    expect(openSecond).toBeGreaterThan(billingFirst);
    expect(doc).toContain("every user counts as Pro with unlimited AI");
  });

  test("lists the exact bot command set", () => {
    for (const command of ["start", "help", "dashboard", "tasks", "done", "pro", "paysupport"]) {
      expect(doc).toContain(command);
    }
  });

  test("has a rollback section that can close the bot instantly", () => {
    expect(doc).toContain("## 9. Rollback");
    expect(doc).toContain("ALLOWLIST_ENABLED=true");
  });

  test("points at docs/DEPLOY.md instead of repeating it", () => {
    expect(doc).toContain("docs/DEPLOY.md");
  });

  test("contains no em or en dashes anywhere", () => {
    expect(doc).not.toMatch(/[\u2013\u2014]/);
  });
});
