import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { consentStatus, hasAcceptedCurrentTerms } from "../../lib/legal/consent";
import {
  ACCEPT_BODY,
  ACCEPT_CONFIRM,
  ACCEPT_DECLINE,
  ACCEPT_TITLE,
  CONSENT_AGAIN_NOTE,
  CONSENT_BUTTONS,
  CONSENT_INTRO,
  CONSENT_PAY_FIRST,
  CONSENT_PLAIN_LINES,
  CONSENT_RESEND_NOTE,
  CONSENT_THANKS,
} from "../../lib/legal/consent-copy";
import { LEGAL_PATHS } from "../../lib/legal/paths";
import { TERMS_VERSION } from "../../lib/legal/version";

const COPY_SOURCE = readFileSync(
  resolve(import.meta.dir, "../../lib/legal/consent-copy.ts"),
  "utf8",
);

describe("hasAcceptedCurrentTerms and consentStatus", () => {
  const accepted = {
    terms_accepted_at: "2026-10-31T01:00:00.000Z",
    terms_version: TERMS_VERSION,
  };

  test("accepted only when both columns are set and the version is current", () => {
    expect(hasAcceptedCurrentTerms(accepted)).toBe(true);
    expect(consentStatus(accepted)).toBe("ok");

    // Either column missing means not accepted.
    expect(hasAcceptedCurrentTerms({ terms_accepted_at: null, terms_version: TERMS_VERSION })).toBe(false);
    expect(hasAcceptedCurrentTerms({ terms_accepted_at: "2026-10-31T01:00:00.000Z", terms_version: null })).toBe(false);
    expect(consentStatus({ terms_accepted_at: null, terms_version: TERMS_VERSION })).toBe("stale");
    expect(consentStatus({ terms_accepted_at: "2026-10-31T01:00:00.000Z", terms_version: null })).toBe("stale");

    // An older version counts as stale, never ok.
    const old = { terms_accepted_at: "2020-01-01T00:00:00.000Z", terms_version: "2020-01-01" };
    expect(hasAcceptedCurrentTerms(old)).toBe(false);
    expect(consentStatus(old)).toBe("stale");

    // No row at all is "none", and never accepted.
    expect(hasAcceptedCurrentTerms(null)).toBe(false);
    expect(hasAcceptedCurrentTerms(undefined)).toBe(false);
    expect(consentStatus(null)).toBe("none");
    expect(consentStatus(undefined)).toBe("none");
  });
});

describe("consent copy rules", () => {
  test("the copy file contains no em or en dash anywhere", () => {
    expect(COPY_SOURCE).not.toMatch(/[\u2013\u2014]/);
  });

  // Words are checked on the actual strings, not the source: comments may
  // discuss why an age check is counsel's call without shipping copy.
  const ALL_COPY: Array<[string, string]> = [
    ["CONSENT_INTRO", CONSENT_INTRO],
    ["CONSENT_AGAIN_NOTE", CONSENT_AGAIN_NOTE],
    ["CONSENT_RESEND_NOTE", CONSENT_RESEND_NOTE],
    ["CONSENT_THANKS", CONSENT_THANKS],
    ["CONSENT_PAY_FIRST", CONSENT_PAY_FIRST],
    ["ACCEPT_TITLE", ACCEPT_TITLE],
    ["ACCEPT_BODY", ACCEPT_BODY],
    ["ACCEPT_CONFIRM", ACCEPT_CONFIRM],
    ["ACCEPT_DECLINE", ACCEPT_DECLINE],
    ["CONSENT_BUTTONS.terms", CONSENT_BUTTONS.terms],
    ["CONSENT_BUTTONS.privacy", CONSENT_BUTTONS.privacy],
    ["CONSENT_BUTTONS.agree", CONSENT_BUTTONS.agree],
    ["CONSENT_PLAIN_LINES", CONSENT_PLAIN_LINES("https://settle.example.com")],
  ];

  test("every exported string is plain human text", () => {
    for (const [label, text] of ALL_COPY) {
      expect(typeof text, label).toBe("string");
      expect(text.length, label).toBeGreaterThan(0);
      expect(text, label).not.toMatch(/[\u2013\u2014]/);
    }
  });

  test("no string mentions age, minor or liability; wording is counsel's call", () => {
    for (const word of ["age", "minor", "liability"]) {
      const pattern = new RegExp(`\\b${word}\\b`, "i");
      for (const [label, text] of ALL_COPY) {
        expect(pattern.test(text), `${label} mentions ${word}`).toBe(false);
      }
    }
  });

  test("the prompt tells people what is saved before they agree", () => {
    expect(CONSENT_INTRO).toContain("Terms");
    expect(CONSENT_INTRO).toContain("Privacy Policy");
    expect(ACCEPT_BODY).toContain("Terms");
    expect(ACCEPT_BODY).toContain("Privacy Policy");
  });

  test("the pay refusal reassures about money and points back to the chat", () => {
    expect(CONSENT_PAY_FIRST).toContain("not been charged");
    expect(CONSENT_PAY_FIRST).toContain("chat");
  });

  test("CONSENT_PLAIN_LINES builds full addresses on the given base", () => {
    expect(CONSENT_PLAIN_LINES("https://settle.example.com/")).toBe(
      `Terms: https://settle.example.com${LEGAL_PATHS.terms}\n` +
        `Privacy Policy: https://settle.example.com${LEGAL_PATHS.privacy}`,
    );
    expect(CONSENT_PLAIN_LINES("http://localhost:3000")).toBe(
      `Terms: http://localhost:3000${LEGAL_PATHS.terms}\n` +
        `Privacy Policy: http://localhost:3000${LEGAL_PATHS.privacy}`,
    );
  });
});

describe("TERMS_VERSION", () => {
  test("is a date shaped string, bumped to the effective date", () => {
    expect(TERMS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
