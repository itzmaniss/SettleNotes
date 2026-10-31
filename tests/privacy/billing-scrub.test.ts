import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./fake-supabase";
import { TELEGRAM_A, TELEGRAM_B, USER_A, USER_B, baseTables } from "./fixtures";
import {
  classifyBillingPayload,
  findBillingEventsForUser,
  scrubbedPayload,
  scrubBillingEvents,
} from "../../lib/privacy/billing-events";

describe("classifyBillingPayload (pure)", () => {
  test("Stars payloads are recognised by the invoice payload suffix", () => {
    expect(
      classifyBillingPayload({ invoice_payload: `settle:pro:monthly:${USER_A}` }, USER_A),
    ).toBe("stars");
    // A uuid that is a suffix of another uuid must not match.
    expect(
      classifyBillingPayload({ invoice_payload: `settle:pro:monthly:x${USER_A}` }, USER_A),
    ).toBe("stars");
  });

  test("Stripe payloads are recognised by the exact user_id", () => {
    expect(classifyBillingPayload({ user_id: USER_A, type: "t", object_id: "o" }, USER_A)).toBe("stripe");
    expect(classifyBillingPayload({ user_id: USER_B }, USER_A)).toBeNull();
  });

  test("refund rows are recognised only when the Telegram id is passed", () => {
    const payload = { telegram_user_id: TELEGRAM_A, telegram_payment_charge_id: "c1" };
    expect(classifyBillingPayload(payload, USER_A, TELEGRAM_A)).toBe("refund");
    expect(classifyBillingPayload(payload, USER_A)).toBeNull();
    expect(classifyBillingPayload({ telegram_user_id: TELEGRAM_B }, USER_A, TELEGRAM_A)).toBeNull();
  });

  test("garbage never matches", () => {
    expect(classifyBillingPayload(null, USER_A)).toBeNull();
    expect(classifyBillingPayload("text", USER_A)).toBeNull();
    expect(classifyBillingPayload({}, USER_A)).toBeNull();
    expect(classifyBillingPayload({ user_id: 12345 }, USER_A)).toBeNull();
  });
});

describe("scrubbedPayload (pure)", () => {
  const stars = {
    currency: "XTR",
    total_amount: 600,
    invoice_payload: `settle:pro:monthly:${USER_A}`,
    subscription_expiration_date: 1792412400,
    is_recurring: false,
    is_first_recurring: false,
    telegram_payment_charge_id: "charge_A1",
  };

  test("Stars: keeps the charge id and accounting fields, drops invoice_payload", () => {
    const scrubbed = scrubbedPayload("stars", stars);
    expect(scrubbed).toEqual({
      currency: "XTR",
      total_amount: 600,
      subscription_expiration_date: 1792412400,
      is_recurring: false,
      is_first_recurring: false,
      telegram_payment_charge_id: "charge_A1",
    });
    expect(scrubbed).not.toHaveProperty("invoice_payload");
  });

  test("Stripe: keeps type and object_id only, drops user_id", () => {
    const scrubbed = scrubbedPayload("stripe", { type: "checkout.session.completed", object_id: "cs_1", user_id: USER_A });
    expect(scrubbed).toEqual({ type: "checkout.session.completed", object_id: "cs_1" });
    expect(scrubbed).not.toHaveProperty("user_id");
  });

  test("Refund: keeps the charge id, drops the Telegram id", () => {
    const scrubbed = scrubbedPayload("refund", { telegram_user_id: TELEGRAM_A, telegram_payment_charge_id: "c1" });
    expect(scrubbed).toEqual({ telegram_payment_charge_id: "c1" });
  });
});

describe("findBillingEventsForUser", () => {
  test("finds Stars, Stripe and refund rows for the subject, deduped, and nothing of anyone else", async () => {
    const fake = makeFakeDb(baseTables());
    const rows = await findBillingEventsForUser(fake.client, USER_A, { telegramUserId: TELEGRAM_A });
    expect(rows.map((r) => r.id).sort()).toEqual([
      "stars:charge_A1",
      "stars:refund:charge_A1",
      "stripe:evt_A1",
    ]);
  });

  test("without the Telegram id, refund rows are out of scope", async () => {
    const fake = makeFakeDb(baseTables());
    const rows = await findBillingEventsForUser(fake.client, USER_A);
    expect(rows.map((r) => r.id).sort()).toEqual(["stars:charge_A1", "stripe:evt_A1"]);
  });

  test("other users' events are never returned", async () => {
    const fake = makeFakeDb(baseTables());
    const rows = await findBillingEventsForUser(fake.client, USER_B, { telegramUserId: TELEGRAM_B });
    expect(rows.map((r) => r.id).sort()).toEqual(["stars:charge_B1", "stripe:evt_B1"]);
  });
});

describe("scrubBillingEvents", () => {
  test("keeps every row, replaces only the identifying fields, touches nobody else", async () => {
    const fake = makeFakeDb(baseTables());
    const { matched, scrubbed } = await scrubBillingEvents(fake.client, USER_A, {
      telegramUserId: TELEGRAM_A,
    });
    expect(matched).toBe(3);
    expect(scrubbed).toBe(3);

    const events = fake.data.billing_events ?? [];
    // Rows survive (dedupe and accounting keep working).
    expect(events.length).toBe(5);

    const stars = events.find((r) => r.id === "stars:charge_A1")! as Record<string, unknown>;
    expect(stars.payload).toEqual({
      currency: "XTR",
      total_amount: 600,
      subscription_expiration_date: 1792412400,
      is_recurring: false,
      is_first_recurring: false,
      telegram_payment_charge_id: "charge_A1",
    });
    expect(JSON.stringify(stars.payload)).not.toContain(USER_A);

    const stripe = events.find((r) => r.id === "stripe:evt_A1")! as Record<string, unknown>;
    expect(stripe.payload).toEqual({ type: "checkout.session.completed", object_id: "cs_A1" });

    const refund = events.find((r) => r.id === "stars:refund:charge_A1")! as Record<string, unknown>;
    expect(refund.payload).toEqual({ telegram_payment_charge_id: "charge_A1" });

    // The other user's rows are byte identical to the fixtures.
    const starsB = events.find((r) => r.id === "stars:charge_B1")! as Record<string, unknown>;
    expect(starsB.payload).toEqual((baseTables().billing_events!.find((r) => r.id === "stars:charge_B1") as { payload: unknown }).payload);
    const stripeB = events.find((r) => r.id === "stripe:evt_B1")! as Record<string, unknown>;
    expect(stripeB.payload).toEqual({ type: "customer.subscription.updated", object_id: "sub_B1", user_id: USER_B });
  });

  test("never deletes a billing event", async () => {
    const fake = makeFakeDb(baseTables());
    await scrubBillingEvents(fake.client, USER_A, { telegramUserId: TELEGRAM_A });
    expect(
      fake.ops.some((op) => op.kind === "delete" && op.table === "billing_events"),
    ).toBe(false);
  });

  test("a scrub failure names the row and stops", async () => {
    const found = [
      {
        id: "stars:charge_A1",
        provider: "stars",
        payload: { invoice_payload: `settle:pro:monthly:${USER_A}` },
      },
    ];
    const broken = {
      from(table: string) {
        if (table !== "billing_events") throw new Error(`unexpected table ${table}`);
        return {
          // The find succeeds; the update fails.
          select() {
            const q = {
              filter: () => q,
              eq: () => q,
              then: (res?: (v: unknown) => unknown) =>
                Promise.resolve({ data: found, error: null }).then(res),
            };
            return q;
          },
          update() {
            const u = {
              eq: () => u,
              then: (res?: (v: unknown) => unknown) =>
                Promise.resolve({ data: null, error: { message: "update refused" } }).then(res),
            };
            return u;
          },
        };
      },
    } as never;
    expect(scrubBillingEvents(broken, USER_A)).rejects.toThrow(
      /billing event scrub failed for stars:charge_A1/,
    );
  });
});
