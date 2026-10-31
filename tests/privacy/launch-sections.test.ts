import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const doc = readFileSync(new URL("../../docs/LAUNCH.md", import.meta.url), "utf8");

// The two appended sections must not disturb the pinned numbering of the
// original runbook (tests/launch/launch-doc.test.ts pins those headings).
const ORIGINAL_HEADINGS = [
  "## 1. Preconditions (before touching any server)",
  "## 2. Infrastructure",
  "## 3. Database",
  "## 4. Telegram",
  "## 5. Stripe, test mode first, then live",
  "## 6. Telegram Stars",
  "## 7. THE SWITCH (order matters)",
  "## 8. First hour watch list",
  "## 9. Rollback",
  "## 10. Known limits, not built",
];

describe("docs/LAUNCH.md appended sections", () => {
  test("the original sections keep their numbers and order", () => {
    let last = -1;
    for (const heading of ORIGINAL_HEADINGS) {
      const at = doc.indexOf(heading);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeGreaterThan(last);
      last = at;
    }
  });

  test("appends section 11 (data requests) and section 12 (refunds), in order, after section 10", () => {
    const s10 = doc.indexOf("## 10.");
    const s11 = doc.indexOf("## 11. Handling a data request");
    const s12 = doc.indexOf("## 12. Refunds");
    expect(s10).toBeGreaterThan(-1);
    expect(s11).toBeGreaterThan(s10);
    expect(s12).toBeGreaterThan(s11);
    expect(doc.indexOf("## 13.")).toBe(-1);
  });

  test("the data request section covers verification from Telegram, both scripts, the reply and the log", () => {
    const section = doc.slice(doc.indexOf("## 11. Handling a data request"), doc.indexOf("## 12. Refunds"));
    for (const phrase of [
      "by email",
      "from the Telegram account itself",
      "one time phrase",
      "login link",
      "scripts/export-user.ts",
      "scripts/delete-user.ts",
      "read only",
      "--yes",
      "--force",
      "30 days",
      "your own private log",
    ]) {
      expect(section).toContain(phrase);
    }
  });

  test("the refunds section covers Stripe, Stars and PayNow with the right commands", () => {
    const section = doc.slice(doc.indexOf("## 12. Refunds"));
    for (const phrase of [
      "Stripe dashboard",
      "cancel the subscription",
      "seven days",
      "REFUND_WINDOW_DAYS",
      "scripts/refund-stars.ts",
      "--charge",
      "paynow:",
      "runs out by itself",
      "by email",
    ]) {
      expect(section).toContain(phrase);
    }
  });

  test("the new checkbox steps carry owner tags", () => {
    const appended = doc.slice(doc.indexOf("## 11. Handling a data request"));
    const stepLines = appended.split("\n").filter((line) => /^\s*- \[ \] \*\*/.test(line));
    expect(stepLines.length).toBeGreaterThanOrEqual(5);
    for (const line of stepLines) {
      expect(line).toMatch(/\*\*\[(User|Manager)\]\*\*/);
    }
  });

  test("the appended text adds no dash characters beyond the plain hyphen", () => {
    const appended = doc.slice(doc.indexOf("## 11. Handling a data request"));
    expect(appended).not.toMatch(/[\u2013\u2014]/);
  });
});
