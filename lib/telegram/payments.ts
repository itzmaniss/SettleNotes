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
  createSubscriptionsQueries,
} from "@/lib/billing/subscriptions";
import { getSupabase } from "@/lib/db/client";
import { getUserByTelegramId } from "@/lib/clarify/queries";
import type { UserRow } from "@/lib/db/types";
import { hasAcceptedCurrentTerms } from "@/lib/legal/consent";
import { CONSENT_PAY_FIRST } from "@/lib/legal/consent-copy";
import {
  PRE_CHECKOUT_CLOSED_REPLY,
  commandFailedReply,
  paySupportReply,
  preCheckoutErrorReply,
  proActivatedReply,
  proActiveReply,
  proInvoiceKeyboard,
  proInvoiceReply,
  proNotOnSaleReply,
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

export type PaymentsDeps = {
  billingEnabled: () => boolean;
  getUserByTelegramId: (telegramUserId: number) => Promise<UserRow | null>;
  getActiveSubscription: (userId: string, now: Date) => Promise<ActiveSubscription | null>;
  createInvoiceLink: (args: StarsInvoiceArgs) => Promise<string>;
  handleSuccessfulPayment: (args: {
    telegramUserId: number;
    payment: SuccessfulPaymentLike;
  }) => Promise<PaymentOutcome>;
};

function logError(message: string, error?: unknown): void {
  console.error(message, error ?? "");
}

// ---- /pro ------------------------------------------------------------------

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
      const url = await deps.createInvoiceLink({ userId: user.id, amount: offer.amount });
      await ctx.reply(proInvoiceReply(offer.amount), { reply_markup: proInvoiceKeyboard(url) });
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
      if (verdict.ok) await answer(true);
      else await answer(false, verdict.message);
    } catch (error) {
      logError("[telegram] pre-checkout validation failed", error);
      await answer(false, preCheckoutErrorReply());
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
  bot.on("pre_checkout_query", (ctx) =>
    createPreCheckoutHandler(deps)(ctx as unknown as PaymentsContextLike),
  );
  bot.on("message:successful_payment", (ctx) =>
    createSuccessfulPaymentHandler(deps)(ctx as unknown as PaymentsContextLike),
  );
}

// Re-exported for the bot wiring and tests of the closed-checkout message.
export { PRE_CHECKOUT_CLOSED_REPLY };
