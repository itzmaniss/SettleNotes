import { describe, expect, test } from "bun:test";
import { makeFakeDb, type RecordedOp } from "./fake-supabase";
import { FUTURE, USER_A, USER_B, baseTables } from "./fixtures";
import { eraseUser, externalStripeRefs, stripeRefsFromRows } from "../../lib/privacy/erase";
import type { StorageApi } from "../../lib/privacy/storage";

function storageOf(fakeDb: ReturnType<typeof makeFakeDb>): StorageApi {
  return (fakeDb.client as unknown as { storage: StorageApi }).storage;
}

const NOW = () => new Date("2026-10-31T00:00:00.000Z");
const UNBLOCKED = { userId: USER_A, dryRun: false, force: true };

function opIndexOf(ops: RecordedOp[], predicate: (op: RecordedOp) => boolean): number {
  return ops.findIndex(predicate);
}

describe("stripeRefsFromRows", () => {
  test("keeps sub_ refs only: PayNow sessions and Stars charges are not Stripe subscriptions", () => {
    const refs = stripeRefsFromRows([
      { provider: "stripe", provider_ref: "sub_abc" },
      { provider: "stripe", provider_ref: "paynow:cs_def" },
      { provider: "stars", provider_ref: "charge_123" },
      { provider: "manual", provider_ref: "granted-by-hand" },
    ]);
    expect(refs).toEqual(["sub_abc"]);
  });

  test("dedupes and keeps order stable", () => {
    const refs = stripeRefsFromRows([
      { provider: "stripe", provider_ref: "sub_b" },
      { provider: "stripe", provider_ref: "sub_a" },
      { provider: "stripe", provider_ref: "sub_b" },
    ]);
    expect(refs.sort()).toEqual(["sub_a", "sub_b"]);
  });
});

describe("eraseUser external records", () => {
  test("captures the Stripe subscription id before deletion and returns it in the report", async () => {
    const fake = makeFakeDb(baseTables(), { objects: [`${USER_A}/up/original.jpg`] });
    const report = await eraseUser(
      { client: fake.client, storage: storageOf(fake), bucket: "uploads", telegramUserId: 5500112233, now: NOW },
      UNBLOCKED,
    );
    expect(report.status).toBe("erased");
    expect(report.externalRecords.stripe).toEqual(["sub_secret_ref_1"]);
    // The cascade really removed the subscriptions rows; the report is the
    // only place the id survives.
    expect((fake.data.subscriptions ?? []).some((row) => row.user_id === USER_A)).toBe(false);
    // The capture query ran BEFORE the users row delete.
    const ops = fake.ops;
    const captureIdx = opIndexOf(
      ops,
      (op) => op.kind === "select" && op.table === "subscriptions" && op.columns === "provider,provider_ref",
    );
    const deleteIdx = opIndexOf(ops, (op) => op.kind === "delete" && op.table === "users");
    expect(captureIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(captureIdx);
  });

  test("a student with no Stripe subscription gets an empty list", async () => {
    const fake = makeFakeDb(baseTables(), { objects: [`${USER_B}/up/original.jpg`] });
    const report = await eraseUser(
      { client: fake.client, storage: storageOf(fake), bucket: "uploads", telegramUserId: 6600223344, now: NOW },
      { userId: USER_B, dryRun: false, force: true },
    );
    expect(report.status).toBe("erased");
    // The Stars charge id is not a Stripe subscription.
    expect(report.externalRecords.stripe).toEqual([]);
  });

  test("the dry run lists the ids too, and a canceled Stripe subscription still counts", async () => {
    const tables = baseTables();
    for (const row of tables.subscriptions ?? []) {
      if (row.user_id === USER_A) {
        row.status = "canceled";
        row.current_period_end = FUTURE;
      }
    }
    const fake = makeFakeDb(tables);
    const report = await eraseUser(
      { client: fake.client, storage: storageOf(fake), bucket: "uploads", telegramUserId: 5500112233, now: NOW },
      { userId: USER_A, dryRun: true },
    );
    expect(report.status).toBe("dry_run");
    expect(report.externalRecords.stripe).toEqual(["sub_secret_ref_1"]);
    expect((fake.data.users ?? []).length).toBe(2);
  });

  test("a second run after the erase has nothing to report", async () => {
    const tables = baseTables();
    for (const row of tables.subscriptions ?? []) {
      if (row.user_id === USER_A) row.current_period_end = "2026-01-01T00:00:00.000Z";
    }
    const fake = makeFakeDb(tables, { objects: [`${USER_A}/up/original.jpg`] });
    const deps = { client: fake.client, storage: storageOf(fake), bucket: "uploads", telegramUserId: 5500112233, now: NOW };
    const first = await eraseUser(deps, { userId: USER_A, dryRun: false });
    expect(first.status).toBe("erased");
    expect(first.externalRecords.stripe).toEqual(["sub_secret_ref_1"]);

    const second = await eraseUser(deps, { userId: USER_A, dryRun: false });
    expect(second.status).toBe("nothing_to_delete");
    expect(second.externalRecords.stripe).toEqual([]);
  });

  test("externalStripeRefs reads every status for one student only", async () => {
    const tables = baseTables();
    (tables.subscriptions ?? []).push({
      id: "77770000-0000-4000-8000-000000000009",
      user_id: USER_A,
      provider: "stripe",
      provider_ref: "sub_old_canceled",
      plan: "pro",
      status: "canceled",
      current_period_end: "2026-02-01T00:00:00.000Z",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const fake = makeFakeDb(tables);
    const refs = await externalStripeRefs(fake.client, USER_A);
    expect(refs.sort()).toEqual(["sub_old_canceled", "sub_secret_ref_1"]);
    // Other students' rows are never read.
    expect(refs.some((ref) => ref.includes("B"))).toBe(false);
  });
});
