import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TELEGRAM_ALLOWED_UPDATES } from "../../lib/telegram/callbacks";

const MIGRATION_PATH = join(import.meta.dir, "..", "..", "supabase", "migrations", "0003_pending_actions.sql");
const sql = readFileSync(MIGRATION_PATH, "utf8");

describe("0003_pending_actions.sql", () => {
  test("creates the pending_actions table with the full column set", () => {
    expect(sql).toContain("create table pending_actions (");
    expect(sql).toContain("id uuid primary key default gen_random_uuid()");
    expect(sql).toContain("user_id uuid not null references users(id) on delete cascade");
    expect(sql).toContain("upload_id uuid references uploads(id) on delete set null");
    expect(sql).toContain("kind text not null check (kind in ('create','update','complete'))");
    expect(sql).toContain("task_id uuid references tasks(id) on delete cascade");
    expect(sql).toContain("payload jsonb not null");
    expect(sql).toContain("status text not null default 'pending' check (status in ('pending','accepted','dismissed'))");
    expect(sql).toContain("expires_at timestamptz not null default now() + interval '1 day'");
    expect(sql).toContain("created_at timestamptz not null default now()");
    expect(sql).toContain("resolved_at timestamptz");
  });

  test("has the (user_id, status) index", () => {
    expect(sql).toContain("create index on pending_actions (user_id, status);");
  });

  test("enables row level security and defines no policies", () => {
    expect(sql).toContain("alter table pending_actions enable row level security;");
    expect(/create\s+policy/i.test(sql)).toBe(false);
  });

  test("contains no em or en dashes", () => {
    expect(sql.includes("\u2014")).toBe(false);
    expect(sql.includes("\u2013")).toBe(false);
  });
});

describe("Telegram allowed updates", () => {
  test("message, callback_query and pre_checkout_query are requested", () => {
    expect([...TELEGRAM_ALLOWED_UPDATES]).toContain("message");
    expect([...TELEGRAM_ALLOWED_UPDATES]).toContain("callback_query");
    expect([...TELEGRAM_ALLOWED_UPDATES]).toContain("pre_checkout_query");
    expect(TELEGRAM_ALLOWED_UPDATES).toHaveLength(3);
  });

  test("both entry points ask for the shared list, so callback_query really arrives", () => {
    const setWebhook = readFileSync(
      join(import.meta.dir, "..", "..", "scripts", "set-webhook.ts"),
      "utf8",
    );
    expect(setWebhook).toContain("TELEGRAM_ALLOWED_UPDATES");
    expect(setWebhook).toContain("allowed_updates");

    const poll = readFileSync(join(import.meta.dir, "..", "..", "scripts", "poll.ts"), "utf8");
    expect(poll).toContain("TELEGRAM_ALLOWED_UPDATES");
    expect(poll).toContain("allowed_updates");
  });
});
