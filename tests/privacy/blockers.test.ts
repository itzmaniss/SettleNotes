import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./fake-supabase";
import { FUTURE, PAST, USER_A, baseTables } from "./fixtures";
import {
  activeSubscriptionBlockers,
  blockerInstruction,
  blockerKind,
  isActiveAt,
} from "../../lib/privacy/blockers";

const NOW = new Date("2026-10-31T00:00:00.000Z");

describe("blockerKind", () => {
  test("classifies by provider_ref prefix first, then provider", () => {
    expect(blockerKind("stripe", "sub_abc123")).toBe("stripe");
    expect(blockerKind("stripe", "paynow:cs_abc")).toBe("paynow");
    expect(blockerKind("stars", "charge_abc")).toBe("stars");
    expect(blockerKind("manual", "manual-1")).toBe("manual");
    expect(blockerKind("stripe", "somethingelse")).toBe("manual");
  });
});

describe("blockerInstruction", () => {
  test("each kind carries its own instruction text", () => {
    const stripe = blockerInstruction("stripe", FUTURE);
    expect(stripe).toContain("Stripe dashboard");
    expect(stripe).toContain("Cancel");
    const paynow = blockerInstruction("paynow", FUTURE);
    expect(paynow).toContain("does not renew");
    expect(paynow).toContain("2027-06-01");
    const stars = blockerInstruction("stars", FUTURE);
    expect(stars).toContain("Telegram");
    const manual = blockerInstruction("manual", null);
    expect(manual).toContain("by hand");
  });
});

describe("isActiveAt", () => {
  test("active means a parseable period end in the future", () => {
    expect(isActiveAt({ provider: "stripe", provider_ref: "sub_x", plan: "pro", current_period_end: FUTURE }, NOW)).toBe(true);
    expect(isActiveAt({ provider: "stripe", provider_ref: "sub_x", plan: "pro", current_period_end: PAST }, NOW)).toBe(false);
    expect(isActiveAt({ provider: "stripe", provider_ref: "sub_x", plan: "pro", current_period_end: null }, NOW)).toBe(false);
    expect(isActiveAt({ provider: "stripe", provider_ref: "sub_x", plan: "pro", current_period_end: "not a date" }, NOW)).toBe(false);
  });
});

describe("activeSubscriptionBlockers", () => {
  test("returns only active, unexpired subscriptions, with per provider instructions", async () => {
    const tables = baseTables();
    tables.subscriptions = [
      // Active Stripe recurring: a blocker.
      { id: "s1", user_id: USER_A, provider: "stripe", provider_ref: "sub_future", plan: "pro", status: "active", current_period_end: FUTURE, created_at: PAST, updated_at: PAST },
      // Expired Stripe: runs out, no blocker.
      { id: "s2", user_id: USER_A, provider: "stripe", provider_ref: "sub_past", plan: "pro", status: "active", current_period_end: PAST, created_at: PAST, updated_at: PAST },
      // Canceled: no blocker.
      { id: "s3", user_id: USER_A, provider: "stripe", provider_ref: "sub_cancelled", plan: "pro", status: "canceled", current_period_end: FUTURE, created_at: PAST, updated_at: PAST },
      // PayNow one time: a blocker with its own instruction.
      { id: "s4", user_id: USER_A, provider: "stripe", provider_ref: "paynow:cs_123", plan: "pro", status: "active", current_period_end: FUTURE, created_at: PAST, updated_at: PAST },
      // Stars: a blocker cancelled by the student in Telegram.
      { id: "s5", user_id: USER_A, provider: "stars", provider_ref: "charge_abc", plan: "pro", status: "active", current_period_end: FUTURE, created_at: PAST, updated_at: PAST },
      // Another user's active row: never returned.
      { id: "s6", user_id: "other-user", provider: "stripe", provider_ref: "sub_other", plan: "pro", status: "active", current_period_end: FUTURE, created_at: PAST, updated_at: PAST },
    ];
    const fake = makeFakeDb(tables);
    const blockers = await activeSubscriptionBlockers(fake.client, USER_A, NOW);
    expect(blockers.map((b) => b.kind)).toEqual(["stripe", "paynow", "stars"]);
    expect(blockers.every((b) => b.provider_ref !== "sub_other")).toBe(true);
    expect(blockers[0]!.instruction).toContain("Stripe dashboard");
    expect(blockers[1]!.instruction).toContain("does not renew");
    expect(blockers[2]!.instruction).toContain("Telegram");
    // The query filters on status active for this user.
    const select = fake.ops[0]!;
    expect(select.kind).toBe("select");
    if (select.kind === "select") {
      expect(select.table).toBe("subscriptions");
      expect(select.filters).toContainEqual({ column: "status", op: "eq", value: "active" });
    }
  });

  test("no subscriptions means no blockers", async () => {
    const fake = makeFakeDb({ users: [{ id: USER_A }] });
    expect(await activeSubscriptionBlockers(fake.client, USER_A, NOW)).toEqual([]);
  });
});
