import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The migration is validated as text here; the manager applies it on a
// throwaway local Postgres before it ever goes near Supabase.
const SQL = readFileSync(
  resolve(import.meta.dir, "../../supabase/migrations/0002_billing.sql"),
  "utf8"
);

describe("0002_billing.sql", () => {
  test("creates the three billing tables", () => {
    expect(SQL).toMatch(/create table subscriptions \(/);
    expect(SQL).toMatch(/create table usage_events \(/);
    expect(SQL).toMatch(/create table billing_events \(/);
  });

  test("subscriptions carries provider, plan and status check constraints", () => {
    expect(SQL).toMatch(/provider text not null check \(provider in \('stars','stripe','manual'\)\)/);
    expect(SQL).toMatch(/plan text not null check \(plan in \('free','pro'\)\)/);
    expect(SQL).toMatch(/status text not null check \(status in \('active','canceled','past_due'\)\)/);
  });

  test("usage_events carries the feature and status check constraints", () => {
    expect(SQL).toMatch(
      /feature text not null check \(feature in \('chat_capture','math_diagnosis','slides_flashcards','brief_checklist','weak_spot_tracker'\)\)/
    );
    expect(SQL).toMatch(/status text not null default 'claimed' check \(status in \('claimed','consumed','released'\)\)/);
  });

  test("has both unique constraints", () => {
    expect(SQL).toMatch(/unique \(provider, provider_ref\)/);
    expect(SQL).toMatch(/unique \(upload_id, feature\)/);
  });

  test("foreign keys cascade from users and detach from uploads", () => {
    expect(SQL.match(/user_id uuid not null references users\(id\) on delete cascade/g)).toHaveLength(2);
    expect(SQL).toMatch(/upload_id uuid references uploads\(id\) on delete set null/);
  });

  test("indexes usage_events for the monthly count", () => {
    expect(SQL).toMatch(/create index on usage_events \(user_id, feature, created_at\)/);
  });

  test("billing_events stores the raw webhook payload keyed by provider event id", () => {
    expect(SQL).toMatch(/id text primary key/);
    expect(SQL).toMatch(/provider text not null/);
    expect(SQL).toMatch(/payload jsonb not null/);
    expect(SQL).toMatch(/received_at timestamptz not null default now\(\)/);
  });

  test("claim_usage returns a uuid and serialises on a per-user advisory lock", () => {
    expect(SQL).toMatch(/function claim_usage\(/);
    expect(SQL).toMatch(/returns uuid/);
    expect(SQL).toMatch(/pg_advisory_xact_lock\(hashtextextended\(p_user::text, 0\)\)/);
  });

  test("claim_usage counts the period and refuses at the limit", () => {
    expect(SQL).toMatch(/created_at >= p_period_start/);
    expect(SQL).toMatch(/status in \('claimed','consumed'\)/);
    expect(SQL).toMatch(/if v_count >= p_limit then/);
    expect(SQL).toMatch(/return null;/);
  });

  test("RLS is enabled on all three tables with no policies anywhere", () => {
    expect(SQL).toMatch(/alter table subscriptions enable row level security;/);
    expect(SQL).toMatch(/alter table usage_events enable row level security;/);
    expect(SQL).toMatch(/alter table billing_events enable row level security;/);
    expect(SQL).not.toMatch(/create policy/i);
  });

  test("execute on claim_usage is revoked, with the Supabase role revokes guarded", () => {
    expect(SQL).toMatch(/revoke all on function claim_usage\(uuid, text, uuid, int, timestamptz\) from public;/);
    expect(SQL).toMatch(/from anon, authenticated;/);
    expect(SQL).toMatch(/exception\s+when undefined_object then null;/);
  });

  test("contains no em dash or en dash", () => {
    expect(SQL).not.toMatch(/[\u2013\u2014]/);
  });
});
