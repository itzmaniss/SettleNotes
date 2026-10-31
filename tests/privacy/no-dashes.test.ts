import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The whole T24 surface: every new file stays free of em and en dashes, in
// code, docs and human facing strings alike.
const NEW_FILES = [
  "../../lib/privacy/query.ts",
  "../../lib/privacy/subject.ts",
  "../../lib/privacy/counts.ts",
  "../../lib/privacy/storage.ts",
  "../../lib/privacy/blockers.ts",
  "../../lib/privacy/billing-events.ts",
  "../../lib/privacy/erase.ts",
  "../../lib/privacy/export.ts",
  "../../scripts/delete-user.ts",
  "../../scripts/export-user.ts",
  "../../docs/INCIDENT.md",
  "../../docs/LAUNCH.md",
  "../../tests/privacy/fake-supabase.ts",
  "../../tests/privacy/fixtures.ts",
  "../../tests/privacy/subject.test.ts",
  "../../tests/privacy/counts.test.ts",
  "../../tests/privacy/storage-list.test.ts",
  "../../tests/privacy/blockers.test.ts",
  "../../tests/privacy/billing-scrub.test.ts",
  "../../tests/privacy/erase.test.ts",
  "../../tests/privacy/export.test.ts",
  "../../tests/privacy/scripts.test.ts",
  "../../tests/privacy/incident-doc.test.ts",
  "../../tests/privacy/launch-sections.test.ts",
];

describe("no em or en dashes in any new file", () => {
  test("every file scans clean", () => {
    for (const file of NEW_FILES) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      const at = source.search(/[\u2013\u2014]/);
      expect([file, at]).toEqual([file, -1]);
    }
  });
});
