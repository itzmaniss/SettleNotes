import "server-only";
import type { Bot } from "grammy";
import type { Chat, SuccessfulPayment, User } from "grammy/types";
import {
  createStarsInvoiceLink,
  handleSuccessfulPayment as recordStarsPayment,
  starsOffer,
  validatePreCheckout,
  type PaymentOutcome,
  type StarsInvoiceArgs,
  type SuccessfulPaymentLike,
} from "@/lib/billing/stars";
import { getActiveSubscription, type ActiveSubscription } from "@/lib/billing/queries";
import { PLANS } from "@/lib/billing/plans";
import { isBillingEnabled } from "@/lib/billing/flags";
import {
  requireLatestConfirmationAt,
  hasRecentConfirmation,
  recordPurchaseConfirmation,
} from "@/lib/billing/purchase-consent";
import {
  PURCHASE_CONFIRM_DECLINED,
  PURCHASE_CONFIRM_FAILED,
  PURCHASE_CONFIRM_FIRST,
  PURCHASE_CONFIRM_THANKS,
} from "@/lib/billing/purchase-consent-copy";
import {
  createSubscriptionsQueries,
} from "@/lib/billing/subscriptions";
import { getSupabase } from "@/lib/db/client";
import { getUserByTelegramId } from "@/lib/clarify/queries";
import type { UserRow } from "@/lib/db/types";
import { hasAcceptedCurrentTerms } from "@/lib/legal/consent";
import { CONSENT_PAY_FIRST } from "@/lib/legal/consent-copy";
import {
  PRE_CHECKOUT_CLOSED_REPLY,
  PURCHASE_CONFIRM_CALLBACK_DATA,
  PURCHASE_DECLINE_CALLBACK_DATA,
  clearedKeyboard,
  commandFailedReply,
  paySupportReply,
  preCheckoutErrorReply,
  proActivatedReply,
  proActiveReply,
  proInvoiceKeyboard,
  proInvoiceReply,
  proNotOnSaleReply,
  purchaseConfirmKeyboard,
  purchaseConfirmPrompt,
} from "@/lib/telegram/replies";

// Minimal structural view of the payment-related corners of a grammY context,
// so tests pass tiny fakes instead of building a real Bot.
export type PaymentsContextLike = {
  from?: User;
  chat?: Chat;
  message?: { successful_payment?: SuccessfulPayment };
  preCheckoutQuery?: {
    id: string;
    currency: string;
    total_amount: number;
    invoice_payload: string;
  };
  reply: (text: string, other?: { reply_markup?: unknown }) => Promise<unknown>;
  answerPreCheckoutQuery: (ok: boolean, other?: { error_message?: string }) => Promise<unknown>;
};

// Structural view for the purchase confirm taps (pc:ok / pc:no).
export type PurchaseConfirmCallbackContextLike = {
  from?: User;
  chat?: Chat;
  callbackQuery?: { data?: string };
  answerCallbackQuery: (other?: { text?: string }) => Promise<unknown>;
  editMessageText: (text: string, other?: { reply_markup?: unknown }) => Promise<unknown>;
  reply: (text: string, other?: { reply_markup?: unknown }) => Promise<unknown>;
};

export type PaymentsDeps = {
  billingEnabled: () => boolean;
  getUserByTelegramId: (telegramUserId: number) => Promise<UserRow | null>;
  getActiveSubscription: (userId: string, now: Date) => Promise<ActiveSubscription | null>;
  createInvoiceLink: (args: StarsInvoiceArgs) => Promise<string>;
  handleSuccessfulPayment: (args: {
    telegramUserId: number;
    payment: SuccessfulPaymentLike;
  }) => Promise<PaymentOutcome>;
  // Records the confirm evidence row (channel telegram). Throws only on a
  // broken caller; the handler treats any throw as not saved.
  recordConfirmation: (
    userId: string,
    now: Date,
  ) => Promise<{ ok: true } | { ok: false }>;
  // Newest confirmation, null when none. A lookup error throws, so the
  // pre-checkout gate can fail closed with an explicit failure line.
  latestConfirmationAt: (userId: string) => Promise<Date | null>;
};

function logError(message: string, error?: unknown): void {
  console.error(message, error ?? "");
}

// ---- /pro ------------------------------------------------------------------

// The invoice send shared by /pro (after a recorded confirm tap) and by the
// pc:ok callback, so both surfaces build the offer exactly the same way.
// Throws on failure; each caller decides how to report it.
async function sendProInvoices(
  deps: PaymentsDeps,
  ctx: Pick<PaymentsContextLike, "reply">,
  userId: string,
): Promise<void> {
  const offer = starsOffer(PLANS, deps.billingEnabled());
  if (!offer.available) {
    await ctx.reply(proNotOnSaleReply());
    return;
  }
  const url = await deps.createInvoiceLink({ userId, amount: offer.amount });
  await ctx.reply(proInvoiceReply(offer.amount), { reply_markup: proInvoiceKeyboard(url) });
}

export function createProCommand(deps: PaymentsDeps) {
  return async (ctx: PaymentsContextLike): Promise<void> => {
    const from = ctx.from;
    if (from === undefined) return;
    try {
      const offer = starsOffer(PLANS, deps.billingEnabled());
      if (!offer.available) {
        await ctx.reply(proNotOnSaleReply());
        return;
      }
      const user = await deps.getUserByTelegramId(from.id);
      if (user == null) {
        // Only possible before the student's first message upserted a row;
        // there is nobody to bill, so this reads like any other hiccup.
        await ctx.reply(commandFailedReply());
        return;
      }
      // Defense in depth: the consent middleware already gates /pro, but an
      // invoice must never be created without a current acceptance even if a
      // version bump races the request.
      if (!hasAcceptedCurrentTerms(user)) {
        await ctx.reply(CONSENT_PAY_FIRST);
        return;
      }
      const active = await deps.getActiveSubscription(user.id, new Date());
      if (active != null) {
        const end =
          active.current_period_end != null ? new Date(active.current_period_end) : null;
        await ctx.reply(proActiveReply(end != null && !Number.isNaN(end.getTime()) ? end : null));
        return;
      }
      // No invoice here: first the student taps the confirm button. The
      // pc:ok callback records the tap and only then sends the invoice.
      await ctx.reply(purchaseConfirmPrompt(), { reply_markup: purchaseConfirmKeyboard() });
    } catch (error) {
      logError("[telegram] /pro failed", error);
      await ctx.reply(commandFailedReply());
    }
  };
}

// ---- /paysupport -----------------------------------------------------------

export function createPaySupportCommand() {
  return async (ctx: Pick<PaymentsContextLike, "reply">): Promise<void> => {
    await ctx.reply(paySupportReply());
  };
}

// ---- pre_checkout_query ----------------------------------------------------
// Telegram only waits 10 seconds, so this handler answers fast and ALWAYS:
// on any internal error it answers false with a friendly message instead of
// letting the checkout hang.

export function createPreCheckoutHandler(deps: PaymentsDeps) {
  return async (ctx: PaymentsContextLike): Promise<void> => {
    const query = ctx.preCheckoutQuery;
    if (query === undefined) return;
    const answer = async (ok: boolean, message?: string): Promise<void> => {
      try {
        await ctx.answerPreCheckoutQuery(ok, ok ? undefined : { error_message: message });
      } catch (error) {
        // A failed answer cannot be retried after the handler returns; log it.
        logError("[telegram] answering the pre-checkout query failed", error);
      }
    };
    try {
      const user =
        ctx.from?.id !== undefined ? await deps.getUserByTelegramId(ctx.from.id) : null;
      const offer = starsOffer(PLANS, deps.billingEnabled());
      const verdict = validatePreCheckout({
        query: {
          currency: query.currency,
          total_amount: query.total_amount,
          invoice_payload: query.invoice_payload,
          fromTelegramId: ctx.from?.id ?? 0,
        },
        expected: { amount: offer.available ? offer.amount : null, userId: user?.id ?? "" },
        billingEnabled: deps.billingEnabled(),
      });
      if (!verdict.ok) {
        await answer(false, verdict.message);
        return;
      }
      // Defense in depth: an old invoice can stay in the chat long after the
      // prompt, so the confirm tap is re-checked here. A renewal by someone
      // with an active Stars subscription is never blocked. A lookup error
      // fails closed with the failure line.
      try {
        const now = new Date();
        const confirmedAt = user != null ? await deps.latestConfirmationAt(user.id) : null;
        if (hasRecentConfirmation(confirmedAt, now)) {
          await answer(true);
          return;
        }
        const active = user != null ? await deps.getActiveSubscription(user.id, now) : null;
        if (active != null && active.provider === "stars") {
          await answer(true);
          return;
        }
        await answer(false, PURCHASE_CONFIRM_FIRST);
      } catch (gateError) {
        logError("[telegram] purchase confirm gate failed", gateError);
        await answer(false, PURCHASE_CONFIRM_FAILED);
      }
    } catch (error) {
      logError("[telegram] pre-checkout validation failed", error);
      await answer(false, preCheckoutErrorReply());
    }
  };
}

// ---- purchase confirm taps (pc:ok / pc:no) ----------------------------------

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function answerTapQuietly(ctx: PurchaseConfirmCallbackContextLike): Promise<void> {
  try {
    await ctx.answerCallbackQuery();
  } catch (error) {
    logError("[telegram] answering the purchase confirm tap failed:", describeError(error));
  }
}

// The prompt message becomes the given text, keyboard removed. A failed edit
// falls back to a plain reply so the student always sees the line.
async function editPromptQuietly(ctx: PurchaseConfirmCallbackContextLike, text: string): Promise<void> {
  try {
    await ctx.editMessageText(text, { reply_markup: clearedKeyboard() });
  } catch {
    try {
      await ctx.reply(text);
    } catch (error) {
      logError("[telegram] purchase confirm reply failed:", describeError(error));
    }
  }
}

async function replyQuietly(ctx: PurchaseConfirmCallbackContextLike, text: string): Promise<void> {
  try {
    await ctx.reply(text);
  } catch (error) {
    logError("[telegram] purchase confirm reply failed:", describeError(error));
  }
}

/**
 * Handles the pc:ok and pc:no taps and hands every other callback to next(),
 * so the pending action resolver still sees its pa: taps. Registered inside
 * registerPaymentHandlers, which bot.ts calls after the consent accept
 * callback: unaccepted users are dropped by the consent gate middleware and
 * never reach this, and pc: taps never fall into the pa: resolver.
 *
 * pc:ok records the evidence row first, then swaps the prompt for the thanks
 * and sends the invoice; on a failed save nothing is sent. pc:no never writes
 * and never invoices. A tap outside a private chat is ignored entirely, and
 * a double tap just repeats a harmless sequence.
 */
export function createPurchaseConfirmCallback(deps: PaymentsDeps) {
  return async (
    ctx: PurchaseConfirmCallbackContextLike,
    next?: () => Promise<void>,
  ): Promise<void> => {
    const data = ctx.callbackQuery?.data;
    if (data !== PURCHASE_CONFIRM_CALLBACK_DATA && data !== PURCHASE_DECLINE_CALLBACK_DATA) {
      if (next !== undefined) return next();
      return;
    }
    const from = ctx.from;
    // The prompt only ever appears in the student's private chat, so a stale
    // button forwarded anywhere else is noise.
    if (from === undefined || ctx.chat?.type !== "private") return;
    await answerTapQuietly(ctx);
    if (data === PURCHASE_DECLINE_CALLBACK_DATA) {
      await editPromptQuietly(ctx, PURCHASE_CONFIRM_DECLINED);
      return;
    }
    let user: UserRow | null = null;
    try {
      user = await deps.getUserByTelegramId(from.id);
    } catch (error) {
      logError("[telegram] purchase confirm user lookup failed", error);
    }
    if (user == null) {
      await replyQuietly(ctx, PURCHASE_CONFIRM_FAILED);
      return;
    }
    let saved: { ok: boolean } = { ok: false };
    try {
      saved = await deps.recordConfirmation(user.id, new Date());
    } catch (error) {
      logError("[telegram] saving the purchase confirmation failed", error);
    }
    if (!saved.ok) {
      await replyQuietly(ctx, PURCHASE_CONFIRM_FAILED);
      return;
    }
    await editPromptQuietly(ctx, PURCHASE_CONFIRM_THANKS);
    try {
      await sendProInvoices(deps, ctx, user.id);
    } catch (error) {
      logError("[telegram] invoice after purchase confirm failed", error);
      await replyQuietly(ctx, commandFailedReply());
    }
  };
}

// ---- successful_payment ----------------------------------------------------
// Registered before the ingest handlers, so a payment message never reaches
// the catch-all. Never throws: a failed booking is logged, and Telegram
// retries the update.

export function createSuccessfulPaymentHandler(deps: PaymentsDeps) {
  return async (ctx: PaymentsContextLike): Promise<void> => {
    const payment = ctx.message?.successful_payment;
    const fromId = ctx.from?.id;
    if (payment === undefined || fromId === undefined) return;
    try {
      const outcome = await deps.handleSuccessfulPayment({ telegramUserId: fromId, payment });
      if (outcome.kind === "activated") {
        await ctx.reply(proActivatedReply(outcome.currentPeriodEnd));
      }
      // duplicate and ignored stay silent on purpose; stars.ts logged why.
    } catch (error) {
      logError("[telegram] successful payment handling failed", error);
    }
  };
}

// ---- registration ----------------------------------------------------------

// Real deps resolved lazily so importing this module (and registering the
// handlers) never touches env or the database.
function realPaymentsDeps(bot: Bot): PaymentsDeps {
  const subscriptions = () => createSubscriptionsQueries(getSupabase());
  return {
    billingEnabled: isBillingEnabled,
    get getUserByTelegramId() {
      return getUserByTelegramId;
    },
    get getActiveSubscription() {
      return (userId: string, now: Date) => getActiveSubscription(userId, now);
    },
    get recordConfirmation() {
      return (userId: string, now: Date) =>
        recordPurchaseConfirmation(getSupabase(), { userId, channel: "telegram", now });
    },
    get latestConfirmationAt() {
      return (userId: string) => requireLatestConfirmationAt(getSupabase(), userId);
    },
    get createInvoiceLink() {
      return (args: StarsInvoiceArgs) =>
        createStarsInvoiceLink(
          {
            createInvoiceLink: (title, description, payload, providerToken, currency, prices, other) =>
              bot.api.createInvoiceLink(title, description, payload, providerToken, currency, prices, {
                subscription_period: other?.subscription_period,
              }),
          },
          args,
        );
    },
    get handleSuccessfulPayment() {
      return (args: { telegramUserId: number; payment: SuccessfulPaymentLike }) =>
        recordStarsPayment(
          {
            getUserByTelegramId,
            findBillingEvent: (id) => subscriptions().findBillingEvent(id),
            recordBillingEvent: (event) => subscriptions().recordBillingEvent(event),
            deleteBillingEvent: (id) => subscriptions().deleteBillingEvent(id),
            getLatestSubscription: (userId, provider) => subscriptions().getLatestSubscription(userId, provider),
            upsertSubscription: (row) => subscriptions().upsertSubscription(row),
          },
          args,
        );
    },
  };
}

// Payment handlers must be registered BEFORE the ingest handlers so a
// successful_payment message is answered here and never lands in the
// catch-all message handler.
export function registerPaymentHandlers(bot: Bot, overrides: Partial<PaymentsDeps> = {}): void {
  const deps: PaymentsDeps = { ...realPaymentsDeps(bot), ...overrides };
  bot.command("pro", (ctx) => createProCommand(deps)(ctx as unknown as PaymentsContextLike));
  bot.command("paysupport", (ctx) =>
    createPaySupportCommand()(ctx as unknown as Pick<PaymentsContextLike, "reply">),
  );
  // The purchase confirm taps. bot.ts registers payment handlers right after
  // the consent accept callback, so pc: taps sit next to tc:ok (behind the
  // consent gate) and in front of the pa: resolver, which sees everything
  // this handler hands to next().
  bot.on("callback_query:data", (ctx, next) =>
    createPurchaseConfirmCallback(deps)(
      ctx as unknown as PurchaseConfirmCallbackContextLike,
      next,
    ),
  );
  bot.on("pre_checkout_query", (ctx) =>
    createPreCheckoutHandler(deps)(ctx as unknown as PaymentsContextLike),
  );
  bot.on("message:successful_payment", (ctx) =>
    createSuccessfulPaymentHandler(deps)(ctx as unknown as PaymentsContextLike),
  );
}

// Re-exported for the bot wiring and tests of the closed-checkout message.
export { PRE_CHECKOUT_CLOSED_REPLY };
