import { describe, expect, test } from "bun:test";
import type {
  BillingEventInput,
  StarsPaymentDeps,
  StarsSubscriptionUpsert,
  SuccessfulPaymentLike,
} from "../../lib/billing/stars";
import { buildStarsPayload, handleSuccessfulPayment } from "../../lib/billing/stars";

const USER_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const TELEGRAM_ID = 101;
const NOW = new Date("2026-11-01T02:00:00Z");

function makePayment(overrides: Partial<SuccessfulPaymentLike> = {}): SuccessfulPaymentLike {
  return {
    currency: "XTR",
    total_amount: 600,
    invoice_payload: buildStarsPayload(USER_ID),
    telegram_payment_charge_id: "charge-1",
    provider_payment_charge_id: "provider-1",
    ...overrides,
  };
}

// Fake store with recorders, mirroring the repo's fakes-only test rule.
function store(
  overrides: Partial<StarsPaymentDeps> & {
    existing?: { current_period_end: string | null } | null;
    upsertError?: Error | null;
  } = {},
) {
  const s = {
    recorded: [] as BillingEventInput[],
    deleted: [] as string[],
    upserts: [] as StarsSubscriptionUpsert[],
    existing: overrides.existing ?? null,
  };
  const deps: StarsPaymentDeps = {
    getUserByTelegramId:
      overrides.getUserByTelegramId ??
      (async (telegramUserId) => (telegramUserId === TELEGRAM_ID ? { id: USER_ID } : null)),
    findBillingEvent: overrides.findBillingEvent ?? (async () => false),
    recordBillingEvent:
      overrides.recordBillingEvent ??
      (async (event) => {
        s.recorded.push(event);
      }),
    deleteBillingEvent:
      overrides.deleteBillingEvent ??
      (async (id) => {
        s.deleted.push(id);
      }),
    getLatestSubscription: overrides.getLatestSubscription ?? (async () => s.existing),
    upsertSubscription:
      overrides.upsertSubscription ??
      (async (row) => {
        if (overrides.upsertError) throw overrides.upsertError;
        s.upserts.push(row);
      }),
    now: overrides.now ?? (() => NOW),
    logError: overrides.logError ?? (() => {}),
  };
  return { s, deps };
}

describe("handleSuccessfulPayment", () => {
  test("first payment records the event then inserts the subscription row", async () => {
    const { s, deps } = store();
    const outcome = await handleSuccessfulPayment(deps, {
      telegramUserId: TELEGRAM_ID,
      payment: makePayment({ subscription_expiration_date: 1793955600 }),
    });
    expect(outcome).toEqual({
      kind: "activated",
      currentPeriodEnd: new Date(1793955600 * 1000),
    });
    expect(s.recorded).toHaveLength(1);
    expect(s.recorded[0].id).toBe("stars:charge-1");
    expect(s.recorded[0].provider).toBe("stars");
    // Stored payload keeps what support needs and nothing provider side.
    expect(s.recorded[0].payload).toEqual({
      currency: "XTR",
      total_amount: 600,
      invoice_payload: buildStarsPayload(USER_ID),
      subscription_expiration_date: 1793955600,
      is_recurring: false,
      is_first_recurring: false,
      telegram_payment_charge_id: "charge-1",
    });
    expect(s.upserts).toHaveLength(1);
    expect(s.upserts[0]).toEqual({
      userId: USER_ID,
      provider: "stars",
      providerRef: "charge-1",
      plan: "pro",
      status: "active",
      currentPeriodEnd: new Date(1793955600 * 1000),
    });
  });

  test("a renewal extends the same row and never shortens the period", async () => {
    const later = new Date(NOW.getTime() + 40 * 24 * 60 * 60 * 1000);
    const { s, deps } = store({ existing: { current_period_end: later.toISOString() } });
    const outcome = await handleSuccessfulPayment(deps, {
      telegramUserId: TELEGRAM_ID,
      payment: makePayment({ is_recurring: true }),
    });
    expect(outcome.kind).toBe("activated");
    // Telegram's renewal expiration is earlier than the stored period, so the
    // longer (existing) end wins while the charge id is updated in place.
    expect(s.upserts[0].currentPeriodEnd).toEqual(later);
    expect(s.upserts[0].providerRef).toBe("charge-1");
  });

  test("a renewal after a lapse takes the newer expiration date", async () => {
    const stale = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000);
    const { s, deps } = store({ existing: { current_period_end: stale.toISOString() } });
    await handleSuccessfulPayment(deps, {
      telegramUserId: TELEGRAM_ID,
      payment: makePayment(),
    });
    expect(s.upserts[0].currentPeriodEnd).toEqual(new Date(NOW.getTime() + 2_592_000 * 1000));
  });

  test("a duplicate charge id is a no-op", async () => {
    const { s, deps } = store({
      findBillingEvent: async (id) => id === "stars:charge-1",
    });
    const outcome = await handleSuccessfulPayment(deps, {
      telegramUserId: TELEGRAM_ID,
      payment: makePayment(),
    });
    expect(outcome).toEqual({ kind: "duplicate" });
    expect(s.recorded).toHaveLength(0);
    expect(s.upserts).toHaveLength(0);
  });

  test("a payload for another user is ignored without writing anything", async () => {
    const { s, deps } = store({
      getUserByTelegramId: async () => ({ id: "b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d" }),
    });
    const outcome = await handleSuccessfulPayment(deps, {
      telegramUserId: TELEGRAM_ID,
      payment: makePayment(),
    });
    expect(outcome).toEqual({ kind: "ignored", reason: "foreign_payload" });
    expect(s.recorded).toHaveLength(0);
    expect(s.upserts).toHaveLength(0);
  });

  test("an unknown Telegram user and a malformed payload are ignored", async () => {
    const unknownUser = store({ getUserByTelegramId: async () => null });
    const outcome = await handleSuccessfulPayment(unknownUser.deps, {
      telegramUserId: 555,
      payment: makePayment(),
    });
    expect(outcome).toEqual({ kind: "ignored", reason: "no_user" });
    expect(unknownUser.s.recorded).toHaveLength(0);

    const badPayload = store();
    const outcome2 = await handleSuccessfulPayment(badPayload.deps, {
      telegramUserId: TELEGRAM_ID,
      payment: makePayment({ invoice_payload: "garbage" }),
    });
    expect(outcome2).toEqual({ kind: "ignored", reason: "bad_payload" });
    expect(badPayload.s.recorded).toHaveLength(0);
  });

  test("a failed subscription upsert deletes the billing event and rethrows", async () => {
    const boom = new Error("upsert exploded");
    const { s, deps } = store({ upsertError: boom });
    await expect(
      handleSuccessfulPayment(deps, {
        telegramUserId: TELEGRAM_ID,
        payment: makePayment(),
      }),
    ).rejects.toThrow(boom);
    // The event was recorded before the throw, then removed again so a retry
    // can replay the whole step.
    expect(s.recorded).toHaveLength(1);
    expect(s.deleted).toEqual(["stars:charge-1"]);
    expect(s.upserts).toHaveLength(0);
  });
});
