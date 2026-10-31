// Telegram Stars subscription logic for Pro. The pure half (payload, offer,
// pre-checkout verdict, subscription row mapping) has no I/O at all; the I/O
// half takes every dependency as an argument so tests run on fakes and the
// grammY adapter in lib/telegram/payments.ts stays thin.
// Telegram policy: this is the only purchase path the bot may talk about, so
// none of these strings may mention the website, Stripe or fiat prices.
import { z } from "zod";
import { PLANS, type Plan, type PlanId } from "./plans";

// 30 days is the only subscription period Telegram allows for Stars.
export const STARS_SUBSCRIPTION_PERIOD_SECONDS = 2_592_000;
export const STARS_CURRENCY = "XTR";
// Refund promise shown by /paysupport; the user confirms the policy before
// launch, so it lives in one place.
export const REFUND_WINDOW_DAYS = 7;

export type StarsInterval = "monthly";

export type StarsPrice = { label: string; amount: number };

export type CreateInvoiceLinkFn = (
  title: string,
  description: string,
  payload: string,
  providerToken: string,
  currency: string,
  prices: StarsPrice[],
  other?: { subscription_period: number },
) => Promise<string>;

// ---- Pure: invoice payload -----------------------------------------------

const PAYLOAD_PREFIX = "settle:pro:monthly:";
// Strict lowercase uuid: the payload must round-trip exactly what
// buildStarsPayload produced, so anything else is treated as garbage.
const PAYLOAD_PATTERN = /^settle:pro:monthly:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export type ParsedStarsPayload = {
  plan: "pro";
  interval: StarsInterval;
  userId: string;
};

export function buildStarsPayload(userId: string, interval: StarsInterval = "monthly"): string {
  if (interval !== "monthly") {
    throw new Error(`unsupported Stars interval: ${interval}`);
  }
  const uuid = z.uuid().safeParse(userId);
  if (!uuid.success) {
    throw new Error(`buildStarsPayload needs a user uuid, got: ${userId}`);
  }
  const payload = `${PAYLOAD_PREFIX}${userId}`;
  if (Buffer.byteLength(payload, "utf8") > 128) {
    throw new Error("invoice payload exceeds the Telegram 128 byte limit");
  }
  return payload;
}

export function parseStarsPayload(payload: string): ParsedStarsPayload | null {
  if (typeof payload !== "string") return null;
  const match = PAYLOAD_PATTERN.exec(payload);
  if (match === null) return null;
  return { plan: "pro", interval: "monthly", userId: match[1] };
}

// ---- Pure: the offer ------------------------------------------------------

export type StarsOffer =
  | { available: false; reason: "billing_off" | "no_price" }
  | { available: true; amount: number };

// billing_off wins over no_price so the bot never hints at a price while
// billing is switched off.
export function starsOffer(
  plans: Record<PlanId, Plan> = PLANS,
  billingEnabled: boolean,
): StarsOffer {
  if (!billingEnabled) return { available: false, reason: "billing_off" };
  const stars = plans.pro.price.stars;
  if (
    stars == null ||
    !Number.isSafeInteger(stars.monthly) ||
    stars.monthly <= 0
  ) {
    return { available: false, reason: "no_price" };
  }
  return { available: true, amount: stars.monthly };
}

// ---- Pure: pre-checkout verdict ------------------------------------------

export type PreCheckoutQueryLike = {
  currency: string;
  total_amount: number;
  invoice_payload: string;
  fromTelegramId: number;
};

export type ValidatePreCheckoutArgs = {
  query: PreCheckoutQueryLike;
  // amount is the configured Stars price (null means not priced); userId is
  // the paying user's uuid, resolved by the caller from the Telegram sender.
  expected: { amount: number | null; userId: string };
  billingEnabled: boolean;
};

export type PreCheckoutVerdict = { ok: true } | { ok: false; message: string };

export function validatePreCheckout(args: ValidatePreCheckoutArgs): PreCheckoutVerdict {
  if (!args.billingEnabled) {
    return {
      ok: false,
      message:
        "Settle Pro is not open for new purchases right now, so I stopped this checkout. You have not been charged.",
    };
  }
  if (args.expected.amount == null) {
    return {
      ok: false,
      message:
        "This purchase cannot be completed right now, so I stopped the checkout. You have not been charged.",
    };
  }
  if (args.query.currency !== STARS_CURRENCY) {
    return {
      ok: false,
      message:
        "This payment has to go through Telegram Stars. Please start again with /pro in the bot.",
    };
  }
  const parsed = parseStarsPayload(args.query.invoice_payload);
  if (parsed == null) {
    return {
      ok: false,
      message:
        "I could not read this purchase, so I stopped it. You have not been charged. Please send /pro to start again.",
    };
  }
  if (parsed.userId !== args.expected.userId) {
    return {
      ok: false,
      message:
        "This purchase was started from a different account, so I stopped it. Please send /pro in your own chat.",
    };
  }
  if (args.query.total_amount !== args.expected.amount) {
    return {
      ok: false,
      message:
        "The price changed since this checkout started, so I stopped it. You have not been charged. Please send /pro again.",
    };
  }
  return { ok: true };
}

// ---- Pure: payment to subscription row ------------------------------------

// Structural view of Telegram's SuccessfulPayment; grammy's type satisfies it.
export type SuccessfulPaymentLike = {
  currency: string;
  total_amount: number;
  invoice_payload: string;
  subscription_expiration_date?: number;
  is_recurring?: true;
  is_first_recurring?: true;
  telegram_payment_charge_id: string;
  provider_payment_charge_id: string;
};

export type StarsSubscriptionUpsert = {
  userId: string;
  provider: "stars";
  providerRef: string;
  plan: "pro";
  status: "active";
  currentPeriodEnd: Date;
};

export function subscriptionFromPayment(
  payment: SuccessfulPaymentLike,
  userId: string,
  now: Date,
): StarsSubscriptionUpsert {
  const fromExpiration =
    payment.subscription_expiration_date !== undefined
      ? new Date(payment.subscription_expiration_date * 1000)
      : new Date(now.getTime() + STARS_SUBSCRIPTION_PERIOD_SECONDS * 1000);
  return {
    userId,
    provider: "stars",
    providerRef: payment.telegram_payment_charge_id,
    plan: "pro",
    status: "active",
    currentPeriodEnd: fromExpiration,
  };
}

// ---- I/O with injected deps -----------------------------------------------

export type StarsInvoiceArgs = { userId: string; amount: number };

export const INVOICE_TITLE = "Settle Pro";
export const INVOICE_DESCRIPTION =
  "Unlimited math checks, brief checklists and flashcards, one month at a time.";
export const INVOICE_LABEL = "Settle Pro, 1 month";

export async function createStarsInvoiceLink(
  deps: { createInvoiceLink: CreateInvoiceLinkFn },
  args: StarsInvoiceArgs,
): Promise<string> {
  const payload = buildStarsPayload(args.userId, "monthly");
  return deps.createInvoiceLink(
    INVOICE_TITLE,
    INVOICE_DESCRIPTION,
    payload,
    "", // Stars payments never use a provider token.
    STARS_CURRENCY,
    [{ label: INVOICE_LABEL, amount: args.amount }],
    { subscription_period: STARS_SUBSCRIPTION_PERIOD_SECONDS },
  );
}

export type LatestStarsSubscription = { current_period_end: string | null };

export type BillingEventInput = {
  id: string;
  provider: "stars";
  payload: Record<string, unknown>;
};

export type StarsPaymentDeps = {
  getUserByTelegramId: (telegramUserId: number) => Promise<{ id: string } | null>;
  findBillingEvent: (id: string) => Promise<boolean>;
  recordBillingEvent: (event: BillingEventInput) => Promise<void>;
  deleteBillingEvent: (id: string) => Promise<void>;
  getLatestSubscription: (userId: string, provider: "stars") => Promise<LatestStarsSubscription | null>;
  upsertSubscription: (row: StarsSubscriptionUpsert) => Promise<void>;
  now?: () => Date;
  logError?: (message: string, error?: unknown) => void;
};

export type PaymentOutcome =
  | { kind: "activated"; currentPeriodEnd: Date }
  | { kind: "duplicate" }
  | { kind: "ignored"; reason: "no_user" | "bad_payload" | "foreign_payload" };

export type HandlePaymentArgs = {
  telegramUserId: number;
  payment: SuccessfulPaymentLike;
};

function logTo(deps: StarsPaymentDeps): (message: string, error?: unknown) => void {
  return deps.logError ?? ((message, error) => console.error(message, error ?? ""));
}

// What we store in billing_events: the payment fields we need for support and
// dedupe, and nothing from the provider side. Telegram retries of the same
// charge carry the same telegram_payment_charge_id, so the event id below
// makes the whole flow idempotent.
function paymentEventPayload(payment: SuccessfulPaymentLike): Record<string, unknown> {
  return {
    currency: payment.currency,
    total_amount: payment.total_amount,
    invoice_payload: payment.invoice_payload,
    subscription_expiration_date: payment.subscription_expiration_date ?? null,
    is_recurring: payment.is_recurring === true,
    is_first_recurring: payment.is_first_recurring === true,
    telegram_payment_charge_id: payment.telegram_payment_charge_id,
  };
}

export async function handleSuccessfulPayment(
  deps: StarsPaymentDeps,
  args: HandlePaymentArgs,
): Promise<PaymentOutcome> {
  const log = logTo(deps);
  const parsed = parseStarsPayload(args.payment.invoice_payload);
  if (parsed == null) {
    log(`[billing] ignoring payment with unreadable payload: ${args.payment.invoice_payload}`);
    return { kind: "ignored", reason: "bad_payload" };
  }
  const user = await deps.getUserByTelegramId(args.telegramUserId);
  if (user == null) {
    log(`[billing] ignoring payment from unknown Telegram user ${args.telegramUserId}`);
    return { kind: "ignored", reason: "no_user" };
  }
  if (parsed.userId !== user.id) {
    log(
      `[billing] ignoring payment whose payload belongs to another user (${parsed.userId} vs ${user.id})`,
    );
    return { kind: "ignored", reason: "foreign_payload" };
  }

  const eventId = `stars:${args.payment.telegram_payment_charge_id}`;
  if (await deps.findBillingEvent(eventId)) {
    return { kind: "duplicate" };
  }

  // Event first: it is the dedupe marker. If the subscription write then
  // fails, delete the event again so Telegram's retry (or an operator) can
  // redo the whole step.
  await deps.recordBillingEvent({
    id: eventId,
    provider: "stars",
    payload: paymentEventPayload(args.payment),
  });

  const at = deps.now?.() ?? new Date();
  const row = subscriptionFromPayment(args.payment, user.id, at);
  try {
    const existing = await deps.getLatestSubscription(user.id, "stars");
    const existingEnd = existing?.current_period_end;
    if (existingEnd != null) {
      const existingMs = Date.parse(existingEnd);
      if (!Number.isNaN(existingMs) && existingMs > row.currentPeriodEnd.getTime()) {
        row.currentPeriodEnd = new Date(existingMs);
      }
    }
    await deps.upsertSubscription(row);
  } catch (error) {
    log(`[billing] subscription upsert failed for ${eventId}, removing the billing event`, error);
    try {
      await deps.deleteBillingEvent(eventId);
    } catch (deleteError) {
      log(`[billing] failed to remove billing event ${eventId} after the failed upsert`, deleteError);
    }
    throw error;
  }
  return { kind: "activated", currentPeriodEnd: row.currentPeriodEnd };
}
