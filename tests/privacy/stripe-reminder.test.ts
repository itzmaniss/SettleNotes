import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./fake-supabase";
import { BASE_OBJECTS, NAME_A, TELEGRAM_A, TELEGRAM_B, USER_A, baseTables } from "./fixtures";
import { runDelete, STRIPE_REMINDER, STARS_REMINDER } from "../../scripts/delete-user";
import type { StorageApi } from "../../lib/privacy/storage";

function storageOf(fakeDb: ReturnType<typeof makeFakeDb>): StorageApi {
  return (fakeDb.client as unknown as { storage: StorageApi }).storage;
}

function recorder() {
  const lines: string[] = [];
  return {
    lines,
    log: (line: string) => lines.push(line),
    error: (line: string) => lines.push(line),
  };
}

describe("delete-user external record reminders", () => {
  test("the Stripe reminder covers the tax record and, with Managed Payments, the seller of record path", () => {
    // Pins the exact wording, including the Managed Payments sentence.
    expect(STRIPE_REMINDER).toContain(
      "Stripe keeps its own record for tax and accounting.",
    );
    expect(STRIPE_REMINDER).toContain(
      "With Managed Payments on, Stripe is also the seller of record for web payments and holds its own payment record, so a removal request for that record goes through Stripe support.",
    );
    expect(STRIPE_REMINDER).not.toMatch(/[\u2013\u2014]/);
  });

  test("a successful erase prints the Stripe ids and both reminders", async () => {
    const fake = makeFakeDb(baseTables(), { objects: BASE_OBJECTS });
    const out = recorder();
    // The fixture subscription is active, so --force takes the erase through.
    const code = await runDelete(
      { client: fake.client, storage: storageOf(fake), bucket: "uploads", log: out.log, error: out.error },
      { telegramId: TELEGRAM_A, yes: true, force: true },
    );
    expect(code).toBe(0);
    const text = out.lines.join("\n");
    expect(text).toContain("Stripe subscription ids the student had: sub_secret_ref_1.");
    expect(text).toContain(STRIPE_REMINDER);
    // The student had a Stars payment, so the Telegram reminder shows too.
    expect(text).toContain(STARS_REMINDER);
    expect(text).toContain("Erasure complete and verified for user 11111111.");
    expect(text).not.toContain(NAME_A);
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });

  test("the dry run lists the Stripe ids as well", async () => {
    const fake = makeFakeDb(baseTables(), { objects: BASE_OBJECTS });
    const out = recorder();
    const code = await runDelete(
      { client: fake.client, storage: storageOf(fake), bucket: "uploads", log: out.log, error: out.error },
      { telegramId: TELEGRAM_A, yes: false, force: false },
    );
    expect(code).toBe(0);
    const text = out.lines.join("\n");
    expect(text).toContain("Stripe subscription ids on file: sub_secret_ref_1");
    expect(text).toContain("Dry run: nothing has been changed");
    // Reminders belong to the erase itself, not the dry run.
    expect(text).not.toContain(STRIPE_REMINDER);
  });

  test("a student who never had Stripe gets no Stripe reminder, only the Stars one", async () => {
    const fake = makeFakeDb(baseTables(), { objects: BASE_OBJECTS });
    const out = recorder();
    const code = await runDelete(
      { client: fake.client, storage: storageOf(fake), bucket: "uploads", log: out.log, error: out.error },
      { telegramId: TELEGRAM_B, yes: true, force: true },
    );
    expect(code).toBe(0);
    const text = out.lines.join("\n");
    expect(text).toContain(STARS_REMINDER);
    expect(text).not.toContain(STRIPE_REMINDER);
    expect(text).not.toContain("Stripe subscription ids");
  });

  test("a second run on the erased student prints nothing about them at all", async () => {
    const tables = baseTables();
    for (const row of tables.subscriptions ?? []) {
      if (row.user_id === USER_A) row.current_period_end = "2026-01-01T00:00:00.000Z";
    }
    const fake = makeFakeDb(tables, { objects: BASE_OBJECTS });
    const first = recorder();
    const firstCode = await runDelete(
      { client: fake.client, storage: storageOf(fake), bucket: "uploads", log: first.log, error: first.error },
      { telegramId: TELEGRAM_A, yes: true, force: false },
    );
    expect(firstCode).toBe(0);
    expect(first.lines.join("\n")).toContain(STRIPE_REMINDER);

    const second = recorder();
    const secondCode = await runDelete(
      { client: fake.client, storage: storageOf(fake), bucket: "uploads", log: second.log, error: second.error },
      { telegramId: TELEGRAM_A, yes: true, force: false },
    );
    expect(secondCode).toBe(0);
    expect(second.lines).toEqual(["No Settle account exists for this Telegram id. Nothing to delete."]);
    expect(second.lines.join("\n")).not.toContain("Stripe");
    expect(second.lines.join("\n")).not.toContain("Telegram keeps");
  });
});
