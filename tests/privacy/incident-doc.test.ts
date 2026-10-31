import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const doc = readFileSync(new URL("../../docs/INCIDENT.md", import.meta.url), "utf8");

// The env vars the runbook tells the operator to rotate, in the order the
// runbook must present them (stop the bleeding first, then the token, then
// the database, then the AI, then payments, then sessions, then the webhook).
const ROTATION_ORDER = [
  "ALLOWLIST_ENABLED",
  "TELEGRAM_BOT_TOKEN",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_DB_URL",
  "MODEL_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "SESSION_SECRET",
  "TELEGRAM_WEBHOOK_SECRET",
];

describe("docs/INCIDENT.md", () => {
  test("names every variable it tells the operator to rotate", () => {
    for (const name of ROTATION_ORDER) {
      expect(doc).toContain(name);
    }
  });

  test("presents the rotation in the safe order", () => {
    let last = -1;
    for (const name of ROTATION_ORDER) {
      const at = doc.indexOf(name);
      expect(at).toBeGreaterThan(last);
      last = at;
    }
  });

  test("covers the incident kinds", () => {
    for (const phrase of [
      "key or token leaked",
      "storage bucket exposed",
      "another student's data",
      "lost or stolen",
      "Suspicious Stripe or Telegram activity",
    ]) {
      expect(doc).toContain(phrase);
    }
  });

  test("orders the first 30 minutes: stop, rotate, preserve, write down times", () => {
    const stop = doc.indexOf("Stop the bleeding");
    const rotate = doc.indexOf("Revoke and rotate");
    const preserve = doc.indexOf("Preserve evidence");
    const times = doc.indexOf("Write down times");
    expect(stop).toBeGreaterThan(-1);
    expect(rotate).toBeGreaterThan(stop);
    expect(preserve).toBeGreaterThan(rotate);
    expect(times).toBeGreaterThan(preserve);
    expect(doc.toLowerCase()).toContain("do not delete anything, including rows");
    expect(doc).toContain("docker compose -f deploy/docker-compose.yml logs app");
  });

  test("carries the assessment questions and the PDPC rule", () => {
    expect(doc).toContain("500 or more");
    expect(doc).toContain("three calendar days");
    expect(doc).toContain("significant harm");
    expect(doc).toContain("https://www.pdpc.gov.sg");
    expect(doc).toContain("not legal advice");
  });

  test("tells the operator what comes after", () => {
    expect(doc).toContain("post-mortem");
    expect(doc).toContain("Fix the cause");
  });

  test("has a contacts table with square bracket placeholders to fill in", () => {
    for (const placeholder of ["[mobile]", "[name, phone, email]", "[provider, support URL or ticket link]", "[support URL, plan]", "[support URL, account id]"]) {
      expect(doc).toContain(placeholder);
    }
    expect(doc).toContain("| Counsel |");
    expect(doc).toContain("| VPS provider support |");
    expect(doc).toContain("| Supabase support |");
    expect(doc).toContain("| Stripe support |");
  });

  test("contains no dash characters beyond the plain hyphen", () => {
    expect(doc).not.toMatch(/[\u2013\u2014]/);
  });
});
