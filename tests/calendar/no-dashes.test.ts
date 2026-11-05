import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LIB_DIR = new URL("../../lib/calendar", import.meta.url);
const TESTS_DIR = new URL(".", import.meta.url);

function listTsFiles(dir: URL): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(dir.pathname, name));
}

describe("no em or en dashes in calendar sources or tests", () => {
  test("every file scans clean", () => {
    const files = [...listTsFiles(LIB_DIR), ...listTsFiles(TESTS_DIR)];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const at = source.search(/[\u2013\u2014]/);
      expect([file, at]).toEqual([file, -1]);
    }
  });
});
