import { describe, expect, test } from "bun:test";

import { findMarkers, findProblems, runLegalCheck, type LegalCheckDeps } from "../../lib/legal/check";
import type { LegalEnv } from "../../lib/legal/content";

const FULL_ENV: LegalEnv = {
  LEGAL_OPERATOR_NAME: "Sentinel Operator",
  LEGAL_SUPPORT_EMAIL: "legal-sentinel@example.com",
  LEGAL_SUPABASE_REGION: "ap-southeast-1",
  LEGAL_VPS_PROVIDER: "SentinelHost",
  STRIPE_MANAGED_PAYMENTS: false,
};

describe("findProblems", () => {
  test("clean text has no problems", () => {
    expect(findProblems("# Done\n\nAll set, nothing to resolve.")).toEqual([]);
  });

  test("markers, tokens and placeholders are reported with 1-indexed lines", () => {
    const problems = findProblems("first line ok\nsecond [[COUNSEL: ask counsel.]]\nthird {{left_over}}");
    expect(problems).toEqual([
      { line: 2, kind: "marker", excerpt: "[[COUNSEL: ask counsel.]]" },
      { line: 3, kind: "token", excerpt: "{{left_over}}" },
    ]);
  });

  test("capitalised INSERT, TODO and TBD are placeholders, lowercase words are not", () => {
    const problems = findProblems("Fee is TODO here.\nNumbers: INSERT.\nDate: TBD.\nlowercase todo stays.");
    expect(problems.map((problem) => [problem.line, problem.kind, problem.excerpt])).toEqual([
      [1, "placeholder", "TODO here."],
      [2, "placeholder", "INSERT."],
      [3, "placeholder", "TBD."],
    ]);
  });

  test("several problems on one line come out left to right", () => {
    const problems = findProblems("See {{a}} then [[COUNSEL: x]] then TODO.");
    expect(problems.map((problem) => problem.kind)).toEqual(["token", "marker", "placeholder"]);
    expect(problems[0]?.excerpt).toBe("{{a}} then [[COUNSEL: x]] then TODO.");
  });

  test("a MISSING or UNKNOWN marker from filling is a marker problem too", () => {
    const problems = findProblems("Paid by [[MISSING: LEGAL_VPS_PROVIDER]] and [[UNKNOWN TOKEN: old_name]].");
    expect(problems.map((problem) => problem.kind)).toEqual(["marker", "marker"]);
    expect(problems[0]?.excerpt).toContain("LEGAL_VPS_PROVIDER");
  });

  test("long excerpts are cut at 80 characters", () => {
    const long = `[[COUNSEL: end]] ${"word ".repeat(40)}`;
    const problems = findProblems(long);
    expect(problems[0]?.excerpt.length).toBe(80);
    expect(problems[0]?.excerpt.startsWith("[[COUNSEL: end]]")).toBe(true);
    expect(problems[0]?.excerpt.endsWith("...")).toBe(true);
  });

  test("findMarkers lists markers in document order", () => {
    expect(findMarkers("a [[COUNSEL: one]] b [[MISSING: X]] c")).toEqual([
      "[[COUNSEL: one]]",
      "[[MISSING: X]]",
    ]);
  });
});

// Fixtures mirror the real documents' layout: filled identity values sit on
// their own clean lines, counsel questions on theirs, so check output shows
// markers only and never a value.
const TERMS_SOURCE = [
  "# Settle Terms",
  "",
  "Effective date: {{effective_date}}",
  "",
  "Run by {{operator_name}}. Contact {{support_email}}.",
  "",
  "Pro costs {{price_pro_monthly}} a month, {{price_pro_yearly}} a year, or {{stars_monthly}} Stars.",
  "",
  "{{web_cancel_sentence}}",
  "",
  "{{stripe_refund_sentence}} {{stripe_role_sentence}}",
  "",
  "[[COUNSEL: approve the liability cap wording for readers aged 15 to 17.]]",
].join("\n");

const PRIVACY_SOURCE = [
  "# Settle Privacy Notice",
  "",
  "Effective date: {{effective_date}}",
  "",
  "Supabase region {{supabase_region}}, hosting by {{vps_provider}}.",
  "",
  "[[COUNSEL: confirm the overseas transfer safeguards before publishing.]]",
].join("\n");

const REFUND_SOURCE = [
  "# Settle Refunds",
  "",
  "Effective date: {{effective_date}}",
  "",
  "Email {{support_email}} within seven days.",
].join("\n");

describe("runLegalCheck", () => {
  test("fully valid fake env: only the counsel markers remain, exit 1", () => {
    const result = runLegalCheck({
      sources: { terms: TERMS_SOURCE, privacy: PRIVACY_SOURCE, refund: REFUND_SOURCE },
      env: FULL_ENV,
      version: "2026-11-01",
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines).toEqual([
      "terms.md:13: marker: [[COUNSEL: approve the liability cap wording for readers aged 15 to 17.]]",
      "privacy.md:7: marker: [[COUNSEL: confirm the overseas transfer safeguards before publishing.]]",
      "refund.md: ok",
      "3 files checked, 2 problems",
    ]);
    const printed = result.lines.join("\n");
    expect(printed).not.toContain("Sentinel Operator");
    expect(printed).not.toContain("legal-sentinel@example.com");
    expect(printed).not.toContain("SentinelHost");
    expect(printed).not.toContain("ap-southeast-1");
  });

  test("a fully resolved set of fixtures is clean with exit 0", () => {
    const result = runLegalCheck({
      sources: { terms: "# Done\n\nNothing to ask.", refund: "# R\n\nFine." },
      env: FULL_ENV,
      version: "2026-11-01",
    });
    expect(result.exitCode).toBe(0);
    expect(result.lines).toEqual(["terms.md: ok", "refund.md: ok", "2 files clean"]);
  });

  test("a missing env shows MISSING markers naming the variables", () => {
    const result = runLegalCheck({
      sources: { terms: "# T\n\n{{operator_name}} {{support_email}} {{supabase_region}} {{vps_provider}}\n" },
      env: {},
      version: "2026-11-01",
    });
    expect(result.exitCode).toBe(1);
    const printed = result.lines.join("\n");
    expect(printed).toContain("[[MISSING: LEGAL_OPERATOR_NAME]]");
    expect(printed).toContain("[[MISSING: LEGAL_SUPPORT_EMAIL]]");
    expect(printed).toContain("[[MISSING: LEGAL_SUPABASE_REGION]]");
    expect(printed).toContain("[[MISSING: LEGAL_VPS_PROVIDER]]");
    expect(printed).not.toContain("Sentinel");
  });

  test("an unknown token is named, never silently dropped", () => {
    const result = runLegalCheck({
      sources: { terms: "# T\n\nPrice is {{price_pro_monthy}}." },
      env: FULL_ENV,
      version: "2026-11-01",
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines).toContain("terms.md:3: marker: [[UNKNOWN TOKEN: price_pro_monthy]].");
  });

  test("placeholder leftovers are flagged too", () => {
    const result = runLegalCheck({
      sources: { terms: "# T\n\nThe fee is TODO here." },
      env: FULL_ENV,
      version: "2026-11-01",
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines).toContain("terms.md:3: placeholder: TODO here.");
  });

  test("the runner never needs process env: deps carry everything", () => {
    const deps: LegalCheckDeps = {
      sources: { only: "# X\n\nRun by {{operator_name}}. [[COUNSEL: one.]]" },
      env: { STRIPE_MANAGED_PAYMENTS: true },
      version: "2026-11-01",
    };
    const result = runLegalCheck(deps);
    expect(result.exitCode).toBe(1);
    expect(result.lines[0]).toContain("MISSING: LEGAL_OPERATOR_NAME");
    expect(result.lines[0]).toContain("[[COUNSEL: one.]]");
  });
});
