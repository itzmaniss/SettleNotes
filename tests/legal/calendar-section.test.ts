import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { findProblems, runLegalCheck } from "../../lib/legal/check";
import { loadAllLegalSources, loadLegalDocument } from "../../lib/legal/content";
import { parseLegalMarkdown } from "../../lib/legal/markdown";
import {
  CALENDAR_SECTION_TEXT,
  fillTokens,
  legalTokens,
  type LegalTokenEnv,
} from "../../lib/legal/tokens";
import { TERMS_VERSION } from "../../lib/legal/version";

// Full, valid, obviously fake env. The calendar fields stay absent here, so
// this is the feature off state.
const OFF_ENV: LegalTokenEnv = {
  LEGAL_BUSINESS_NAME: "Sentinel Business",
  LEGAL_SUPPORT_EMAIL: "legal-sentinel@example.com",
  LEGAL_SUPABASE_REGION: "ap-southeast-1",
  LEGAL_BUSINESS_UEN: "SentinelUEN",
  STRIPE_MANAGED_PAYMENTS: false,
};

const ON_ENV: LegalTokenEnv = {
  ...OFF_ENV,
  CALENDAR_SYNC_ENABLED: "true",
  GOOGLE_CLIENT_ID: "calendar-client-id",
  GOOGLE_CLIENT_SECRET: "calendar-client-secret",
  CALENDAR_TOKEN_KEY: "calendar-token-key",
  CALENDAR_CRON_SECRET: "calendar-cron-secret",
};

describe("calendar_section token", () => {
  test("off: the value is an empty string, not a missing marker", () => {
    const tokens = legalTokens({ env: OFF_ENV, version: "2026-11-01" });
    expect(tokens.calendar_section).toBe("");
    // An empty value fills to nothing and never names a variable.
    const filled = fillTokens("Before.\n\n{{calendar_section}}\n\nAfter.", tokens);
    expect(filled).toBe("Before.\n\nAfter.");
    expect(filled).not.toContain("[[MISSING");
  });

  test("off: each missing calendar variable still reads as off, never as an error", () => {
    for (const name of [
      "CALENDAR_SYNC_ENABLED",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "CALENDAR_TOKEN_KEY",
      "CALENDAR_CRON_SECRET",
    ] as const) {
      const env = { ...ON_ENV, [name]: "   " };
      expect(legalTokens({ env, version: "2026-11-01" }).calendar_section).toBe("");
    }
    expect(legalTokens({ env: {}, version: "2026-11-01" }).calendar_section).toBe("");
  });

  test("on: the section reads as plain student facing text", () => {
    const tokens = legalTokens({ env: ON_ENV, version: "2026-11-01" });
    expect(tokens.calendar_section).toBe(CALENDAR_SECTION_TEXT);
    expect(tokens.calendar_section).toContain("## Google Calendar (Pro)");
    expect(tokens.calendar_section).toContain(
      "Settle puts your task titles, course names and deadlines into a separate calendar called Settle",
    );
    expect(tokens.calendar_section).toContain(
      "Settle cannot see or change the rest of your Google Calendar.",
    );
    expect(tokens.calendar_section).toContain(
      "until you disconnect or delete your account.",
    );
    expect(tokens.calendar_section).toContain("open the Account page and choose Disconnect");
    expect(tokens.calendar_section).toContain("Google is an additional service provider");
    expect(tokens.calendar_section).toContain(
      "Settle's use and transfer of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements.",
    );
    expect(tokens.calendar_section).toContain("short lived sign in cookie");
  });

  test("on: the section carries no tokens, markers, placeholders or dashes", () => {
    expect(findProblems(CALENDAR_SECTION_TEXT)).toEqual([]);
    expect(CALENDAR_SECTION_TEXT).not.toMatch(/[\u2013\u2014]/);
    expect(CALENDAR_SECTION_TEXT).not.toContain("-");
    expect(CALENDAR_SECTION_TEXT).not.toContain("!");
  });
});

describe("privacy page with the calendar token", () => {
  const sources = loadAllLegalSources();

  test("off: the rendered page carries no calendar heading and no leftover blank lines", () => {
    const doc = loadLegalDocument("privacy", { source: sources.privacy, env: OFF_ENV });
    expect(doc.markers).toEqual([]);
    const texts = doc.blocks.map((block) =>
      block.kind === "ul" ? block.items.map((item) => item.text).join("\n") : block.text,
    );
    expect(texts.some((text) => text.includes("Google Calendar"))).toBe(false);
    expect(texts.some((text) => text.includes("{{"))).toBe(false);
    const filled = fillTokens(sources.privacy, legalTokens({ env: OFF_ENV, version: TERMS_VERSION }));
    expect(filled).not.toContain("{{calendar_section}}");
    expect(filled).not.toContain("\n\n\n");
  });

  test("off: the rendered page is byte for byte identical to the pre feature output", () => {
    const filled = fillTokens(sources.privacy, legalTokens({ env: OFF_ENV, version: TERMS_VERSION }));
    const snapshot = readFileSync(new URL("./privacy-off-snapshot.md", import.meta.url), "utf8");
    expect(filled).toBe(snapshot);
  });

  test("on: the calendar section renders as a block with no markers and no gap", () => {
    const doc = loadLegalDocument("privacy", { source: sources.privacy, env: ON_ENV });
    expect(doc.markers).toEqual([]);
    const headings = doc.blocks
      .filter((block) => block.kind === "h2")
      .map((block) => (block.kind === "h2" ? block.text : ""));
    expect(headings).toContain("Google Calendar (Pro)");
    // The numbered sections keep their numbers in both states.
    expect(headings).toContain("1. What Settle handles");
    expect(headings).toContain("7. Contact");
    const filled = fillTokens(sources.privacy, legalTokens({ env: ON_ENV, version: TERMS_VERSION }));
    expect(filled).not.toContain("{{calendar_section}}");
    expect(filled).not.toContain("\n\n\n");
    expect(findProblems(filled)).toEqual([]);
    expect(parseLegalMarkdown(filled).some((block) => block.kind === "h1" && block.text === "")).toBe(
      false,
    );
  });

  test("check-legal exits 0 with the feature both off and on", () => {
    for (const env of [OFF_ENV, ON_ENV]) {
      const result = runLegalCheck({ sources, env, version: TERMS_VERSION });
      expect(result.exitCode).toBe(0);
      expect(result.lines).toEqual(["terms.md: ok", "privacy.md: ok", "refund.md: ok", "3 files clean"]);
    }
  });
});
