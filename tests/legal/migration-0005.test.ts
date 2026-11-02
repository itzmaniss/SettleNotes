import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The migration is validated as text here; the manager applies it on a
// throwaway local Postgres before it ever goes near Supabase.
const SQL = readFileSync(
  resolve(import.meta.dir, "../../supabase/migrations/0005_purchase_confirmations.sql"),
  "utf8"
);

// Statements only: the explanatory comments are prose, not SQL.
const STATEMENTS = SQL
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

describe("0005_purchase_confirmations.sql", () => {
  test("creates the purchase_confirmations table with every column", () => {
    expect(SQL).toMatch(/create table purchase_confirmations/);
    expect(SQL).toMatch(/id uuid primary key default gen_random_uuid\(\)/);
    expect(SQL).toMatch(/user_id uuid not null/);
    expect(SQL).toMatch(/channel text not null/);
    expect(SQL).toMatch(/terms_version text not null/);
    expect(SQL).toMatch(/confirmed_at timestamptz not null default now\(\)/);
  });

  test("the user foreign key cascades on delete", () => {
    expect(STATEMENTS).toMatch(/references users\(id\) on delete cascade/);
  });

  test("the channel check allows only telegram and web", () => {
    expect(STATEMENTS).toMatch(/check \(channel in \('telegram','web'\)\)/);
  });

  test("an index serves the recency lookup per user", () => {
    expect(STATEMENTS).toMatch(/create index on purchase_confirmations \(user_id, confirmed_at desc\)/);
  });

  test("RLS is enabled and no policy is created", () => {
    expect(SQL).toMatch(/alter table purchase_confirmations enable row level security/);
    expect(STATEMENTS).not.toMatch(/create policy/i);
  });

  test("it only creates its own table and index", () => {
    expect(STATEMENTS.match(/create table/g)).toHaveLength(1);
    expect(STATEMENTS).not.toMatch(/drop /i);
    expect(STATEMENTS).not.toMatch(/alter table users/i);
  });

  test("contains no em dash or en dash", () => {
    expect(SQL).not.toMatch(/[\u2013\u2014]/);
  });
});
