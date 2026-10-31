import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The migration is validated as text here; the manager applies it on a
// throwaway local Postgres before it ever goes near Supabase.
const SQL = readFileSync(
  resolve(import.meta.dir, "../../supabase/migrations/0004_terms_acceptance.sql"),
  "utf8"
);

// Statements only: the explanatory comments are prose, not SQL.
const STATEMENTS = SQL
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

describe("0004_terms_acceptance.sql", () => {
  test("alters the users table with both acceptance columns", () => {
    expect(SQL).toMatch(/alter table users/);
    expect(SQL).toMatch(/add column terms_accepted_at timestamptz/);
    expect(SQL).toMatch(/add column terms_version text/);
  });

  test("both columns are nullable with no default and no backfill", () => {
    // Nullable on purpose: existing rows must read as not accepted yet, and
    // lib/legal/consent.ts treats a missing value as stale, never ok.
    expect(STATEMENTS).not.toMatch(/not null/i);
    expect(STATEMENTS).not.toMatch(/default/i);
    expect(STATEMENTS).not.toMatch(/update users/i);
    expect(STATEMENTS).not.toMatch(/now\(\)/i);
  });

  test("creates no policy and touches nothing else", () => {
    expect(STATEMENTS).not.toMatch(/create policy/i);
    expect(STATEMENTS).not.toMatch(/create table/i);
    expect(STATEMENTS).not.toMatch(/drop /i);
  });

  test("contains no em dash or en dash", () => {
    expect(SQL).not.toMatch(/[\u2013\u2014]/);
  });
});
