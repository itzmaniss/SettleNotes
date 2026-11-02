import { describe, expect, test } from "bun:test";

import { readLegalSource, LEGAL_KEYS, LEGAL_VERSION, loadAllLegalSources, loadLegalDocument, type LegalEnv } from "../../lib/legal/content";
import { LEGAL_TOKEN_NAMES } from "../../lib/legal/tokens";
import { findProblems } from "../../lib/legal/check";

// Full, valid, obviously fake env. The sentinel values must never leak into
// any check output; check.test.ts pins that.
const FULL_ENV: LegalEnv = {
  LEGAL_OPERATOR_NAME: "Sentinel Operator",
  LEGAL_SUPPORT_EMAIL: "legal-sentinel@example.com",
  LEGAL_SUPABASE_REGION: "ap-southeast-1",
  LEGAL_VPS_PROVIDER: "SentinelHost",
  STRIPE_MANAGED_PAYMENTS: false,
};

describe("loadAllLegalSources", () => {
  test("reads all three documents from content/legal", () => {
    const sources = loadAllLegalSources();
    expect(Object.keys(sources).sort()).toEqual([...LEGAL_KEYS].sort());
    for (const key of LEGAL_KEYS) {
      expect(sources[key].startsWith("# Settle ")).toBe(true);
    }
  });

  test("readLegalSource reads the same file as the loader", () => {
    expect(readLegalSource("terms")).toBe(loadAllLegalSources().terms);
  });
});

describe("the real content files", () => {
  const sources = loadAllLegalSources();

  test("every {{token}} used is a known token name", () => {
    const known = new Set<string>(LEGAL_TOKEN_NAMES);
    for (const key of LEGAL_KEYS) {
      for (const match of sources[key].matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)) {
        expect(known.has(match[1] ?? "")).toBe(true);
      }
    }
  });

  test("no em or en dashes anywhere", () => {
    for (const key of LEGAL_KEYS) {
      expect(sources[key]).not.toMatch(/[\u2013\u2014]/);
    }
  });

  test("every marker starts with [[COUNSEL: and sits on one line", () => {
    for (const key of LEGAL_KEYS) {
      for (const line of sources[key].split("\n")) {
        for (const match of line.matchAll(/\[\[/g)) {
          const at = match.index ?? 0;
          expect(line.slice(at, at + 11)).toBe("[[COUNSEL: ");
          expect(line.indexOf("]]", at)).toBeGreaterThan(at);
        }
      }
    }
  });

  test("each document loads with a valid env: h1 title, tokens filled, only counsel markers left", () => {
    for (const key of LEGAL_KEYS) {
      const doc = loadLegalDocument(key, { env: FULL_ENV });
      expect(doc.key).toBe(key);
      const first = doc.blocks[0];
      expect(first?.kind).toBe("h1");
      expect(doc.title).toBe(first?.kind === "h1" ? first.text : "");
      expect(doc.title.startsWith("Settle ")).toBe(true);
      // No {{ anywhere after filling.
      for (const block of doc.blocks) {
        expect(JSON.stringify(block)).not.toContain("{{");
      }
      // What is left unresolved is exactly the counsel questions.
      expect(doc.markers.every((marker) => marker.startsWith("[[COUNSEL: "))).toBe(true);
      const problems = findProblems(loadLegalDocument(key, { env: FULL_ENV }).markers.join(""));
      expect(problems.every((problem) => problem.kind === "marker")).toBe(true);
    }
  });

  test("the effective date version renders as the visible date", () => {
    expect(LEGAL_VERSION).toBe("2026-11-01");
    const doc = loadLegalDocument("terms", { env: FULL_ENV });
    expect(
      doc.blocks.some(
        (block) =>
          (block.kind === "h1" || block.kind === "h2" || block.kind === "p") &&
          block.text.includes("Effective date: 1 November 2026"),
      ),
    ).toBe(true);
  });
});

describe("loadLegalDocument with an injected source", () => {
  test("fills tokens, parses blocks and collects markers in order", () => {
    const source = [
      "# Fixture Terms",
      "",
      "Effective date: {{effective_date}}",
      "",
      "Run by {{operator_name}} at {{support_email}}. Pro costs {{price_pro_monthly}}.",
      "",
      "- Star price: {{stars_monthly}}",
      "",
      "[[COUNSEL: first question.]] More text. [[COUNSEL: second question.]]",
      "",
      "{{stripe_role_sentence}}",
    ].join("\n");
    const doc = loadLegalDocument("terms", { source, env: FULL_ENV });
    expect(doc.title).toBe("Fixture Terms");
    expect(doc.blocks[0]?.kind).toBe("h1");
    expect(
      doc.blocks.some(
        (block) =>
          block.kind === "p" &&
          block.text ===
            "Run by Sentinel Operator at legal-sentinel@example.com. Pro costs S$7.99.",
      ),
    ).toBe(true);
    expect(doc.markers).toEqual(["[[COUNSEL: first question.]]", "[[COUNSEL: second question.]]"]);
    expect(
      doc.blocks.some((block) =>
        block.kind === "p"
          ? block.text.includes(
              "Stripe receives your payment details. Settle receives only what it needs to manage your subscription.",
            )
          : false,
      ),
    ).toBe(true);
  });

  test("a missing env value surfaces as a MISSING marker in the blocks", () => {
    const doc = loadLegalDocument("privacy", {
      source: "H\n\nRun by {{operator_name}}.",
      env: {},
    });
    expect(
      doc.blocks.some(
        (block) => block.kind === "p" && block.text.includes("[[MISSING: LEGAL_OPERATOR_NAME]]"),
      ),
    ).toBe(true);
  });

  test("the managed payments flag switches the refund sentence", () => {
    const base = "# R\n\n{{stripe_refund_sentence}}";
    const off = loadLegalDocument("refund", { source: base, env: FULL_ENV });
    const on = loadLegalDocument("refund", {
      source: base,
      env: { ...FULL_ENV, STRIPE_MANAGED_PAYMENTS: true },
    });
    expect(
      off.blocks.some(
        (block) => block.kind === "p" && block.text === "Refunds for web payments are issued by Settle through Stripe.",
      ),
    ).toBe(true);
    expect(
      on.blocks.some(
        (block) =>
          block.kind === "p" &&
          block.text.startsWith("Because Stripe is the seller of record for web payments"),
      ),
    ).toBe(true);
  });
});
