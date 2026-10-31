import { describe, expect, test } from "bun:test";
import type { Bot, NextFunction } from "grammy";
import type { Chat, Message, Update, User } from "grammy/types";
import type { PaymentsDeps, PaymentsContextLike } from "../../lib/telegram/payments";
import {
  createPaySupportCommand,
  createPreCheckoutHandler,
  createProCommand,
  createSuccessfulPaymentHandler,
  registerPaymentHandlers,
} from "../../lib/telegram/payments";
import {
  allowlistMiddleware,
  KNOWN_COMMANDS,
  registerIngestHandlers,
} from "../../lib/telegram/handlers";
import { HELP_TEXT } from "../../lib/telegram/bot";
import { TELEGRAM_ALLOWED_UPDATES } from "../../lib/telegram/callbacks";
import { handleWebhook, senderIdOf } from "../../lib/telegram/guards";
import { PLANS } from "../../lib/billing/plans";
import { buildStarsPayload } from "../../lib/billing/stars";
import {
  PRE_CHECKOUT_CLOSED_REPLY,
  paySupportReply,
  preCheckoutErrorReply,
  proActivatedReply,
  proActiveReply,
  proInvoiceReply,
  proNotOnSaleReply,
} from "../../lib/telegram/replies";
import { ALLOWED_ID, SECRET, STRANGER_ID, webhookRequest } from "./fixtures";

const USER_UUID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const CHARGE_ID = "charge-1";

// ---- shared fakes ----------------------------------------------------------

type Registration = {
  kind: string;
  name: string;
  handler: (ctx: unknown, next?: NextFunction) => Promise<void>;
};

function makeFakeBot(): { bot: Bot; registrations: Registration[] } {
  const registrations: Registration[] = [];
  const bot = {
    command: (name: string, handler: (ctx: unknown, next?: NextFunction) => Promise<void>) =>
      registrations.push({ kind: "command", name, handler }),
    on: (name: string, handler: (ctx: unknown, next?: NextFunction) => Promise<void>) =>
      registrations.push({ kind: "on", name, handler }),
  } as unknown as Bot;
  return { bot, registrations };
}

function makeCtx(
  opts: {
    fromId?: number;
    preCheckout?: { id: string; currency: string; total_amount: number; invoice_payload: string };
    successfulPayment?: Record<string, unknown>;
  } = {},
) {
  const replies: Array<{ text: string; markup: unknown }> = [];
  const answers: Array<{ ok: boolean; message?: string }> = [];
  const ctx: PaymentsContextLike = {
    from:
      opts.fromId === undefined
        ? undefined
        : ({ id: opts.fromId, is_bot: false, first_name: "Tim" } as User),
    chat: { id: opts.fromId ?? ALLOWED_ID, type: "private" } as Chat,
    message:
      opts.successfulPayment !== undefined
        ? ({ successful_payment: opts.successfulPayment } as unknown as Message)
        : undefined,
    preCheckoutQuery: opts.preCheckout,
    reply: async (text, other) => {
      const markup = (other as { reply_markup?: unknown } | undefined)?.reply_markup;
      replies.push({ text, markup });
      return {};
    },
    answerPreCheckoutQuery: async (ok, other) => {
      answers.push({ ok, message: other?.error_message });
      return true;
    },
  };
  return { ctx, replies, answers };
}

type PaymentsDepsSpy = PaymentsDeps & {
  invoices: Array<{ userId: string; amount: number }>;
};

function makeDeps(
  overrides: Partial<PaymentsDeps> & { userUuid?: string } = {},
): PaymentsDepsSpy {
  const invoices: Array<{ userId: string; amount: number }> = [];
  const userUuid = overrides.userUuid ?? USER_UUID;
  return {
    billingEnabled: () => true,
    getUserByTelegramId: async (id) =>
      id === ALLOWED_ID
        ? {
            id: userUuid,
            telegram_user_id: id,
            telegram_chat_id: id,
            first_name: "Tim",
            timezone: "Asia/Singapore",
            created_at: "2026-10-01T01:00:00.000Z",
          }
        : null,
    getActiveSubscription: async () => null,
    createInvoiceLink: async (args) => {
      invoices.push(args);
      return `https://t.me/invoice-${args.amount}`;
    },
    handleSuccessfulPayment: async () => ({ kind: "duplicate" }),
    invoices,
    ...overrides,
  };
}

// ---- constants -------------------------------------------------------------

describe("payment constants", () => {
  test("KNOWN_COMMANDS covers /pro and /paysupport", () => {
    expect(KNOWN_COMMANDS.has("/pro")).toBe(true);
    expect(KNOWN_COMMANDS.has("/paysupport")).toBe(true);
  });

  test("allowed updates include message, callback_query and pre_checkout_query", () => {
    expect([...TELEGRAM_ALLOWED_UPDATES]).toContain("message");
    expect([...TELEGRAM_ALLOWED_UPDATES]).toContain("callback_query");
    expect([...TELEGRAM_ALLOWED_UPDATES]).toContain("pre_checkout_query");
    expect(TELEGRAM_ALLOWED_UPDATES).toHaveLength(3);
  });

  test("HELP_TEXT lists both commands without dashes", () => {
    expect(HELP_TEXT).toContain("/pro - see Settle Pro and pay with Telegram Stars");
    expect(HELP_TEXT).toContain("/paysupport - help with a payment or a refund");
    expect(HELP_TEXT).not.toMatch(/[\u2013\u2014]/);
  });

  test("the offer reply text carries the Stars amount and nothing else", () => {
    expect(PLANS.pro.price.stars).toEqual({ monthly: 600 });
    const starsMonthly = PLANS.pro.price.stars?.monthly ?? -1;
    expect(proInvoiceReply(starsMonthly)).toBe(
      "Pro is 600 Stars a month for unlimited math checks, brief checklists and flashcards. Tap the button below to pay.",
    );
    for (const text of [
      proNotOnSaleReply(),
      proInvoiceReply(600),
      proActivatedReply(new Date("2026-12-05T02:00:00.000Z")),
      proActiveReply(new Date("2026-12-05T02:00:00.000Z")),
      proActiveReply(null),
      paySupportReply(),
      PRE_CHECKOUT_CLOSED_REPLY,
      preCheckoutErrorReply(),
    ]) {
      expect(text).not.toMatch(/[\u2013\u2014]/);
      expect(text).not.toMatch(/S\$|US\$|\$/);
      expect(text).not.toMatch(/website|stripe|discount|dashboard|sgd/i);
    }
    // The thank-you and already-on replies carry no price at all.
    expect(proActivatedReply(new Date("2026-12-05T02:00:00.000Z"))).not.toMatch(/600/);
    expect(proActiveReply(new Date("2026-12-05T02:00:00.000Z"))).not.toMatch(/600/);
    // The refund window is the only number in /paysupport and it is policy, not price.
    expect(paySupportReply()).toContain("7 days");
  });
});

// ---- /pro ------------------------------------------------------------------

describe("/pro command", () => {
  test("billing off: the not-on-sale reply and no invoice", async () => {
    const deps = makeDeps({ billingEnabled: () => false });
    const { ctx, replies } = makeCtx({ fromId: ALLOWED_ID });
    await createProCommand(deps)(ctx);
    expect(replies.map((r) => r.text)).toEqual([proNotOnSaleReply()]);
    expect(deps.invoices).toHaveLength(0);
  });

  test("available: one invoice and one reply with a single Pay with Stars button", async () => {
    const deps = makeDeps();
    const { ctx, replies } = makeCtx({ fromId: ALLOWED_ID });
    await createProCommand(deps)(ctx);

    expect(deps.invoices).toEqual([{ userId: USER_UUID, amount: 600 }]);
    expect(replies).toHaveLength(1);
    expect(replies[0].text).toBe(proInvoiceReply(600));
    const keyboard = replies[0].markup as {
      inline_keyboard: Array<Array<{ text: string; url: string }>>;
    };
    expect(keyboard.inline_keyboard).toHaveLength(1);
    expect(keyboard.inline_keyboard[0]).toEqual([
      { text: "Pay with Stars", url: "https://t.me/invoice-600" },
    ]);
  });

  test("already active: the end date reply and no invoice", async () => {
    const deps = makeDeps({
      getActiveSubscription: async () => ({
        plan: "pro",
        provider: "stars",
        current_period_end: "2026-12-05T02:00:00.000Z",
      }),
    });
    const { ctx, replies } = makeCtx({ fromId: ALLOWED_ID });
    await createProCommand(deps)(ctx);
    expect(deps.invoices).toHaveLength(0);
    expect(replies[0].text).toBe(proActiveReply(new Date("2026-12-05T02:00:00.000Z")));
  });

  test("unknown user: a plain failure reply and no invoice", async () => {
    const deps = makeDeps({ getUserByTelegramId: async () => null });
    const { ctx, replies } = makeCtx({ fromId: ALLOWED_ID });
    await createProCommand(deps)(ctx);
    expect(deps.invoices).toHaveLength(0);
    expect(replies).toHaveLength(1);
    expect(replies[0].text).toMatch(/try that again/i);
  });

  test("an invoice failure becomes a plain failure reply, never a throw", async () => {
    const deps = makeDeps({
      createInvoiceLink: async () => {
        throw new Error("telegram down");
      },
    });
    const { ctx, replies } = makeCtx({ fromId: ALLOWED_ID });
    await createProCommand(deps)(ctx);
    expect(replies).toHaveLength(1);
    expect(replies[0].text).toMatch(/try that again/i);
  });
});

// ---- /paysupport -----------------------------------------------------------

describe("/paysupport command", () => {
  test("replies with the neutral help text including the refund window", async () => {
    const { ctx, replies } = makeCtx({ fromId: ALLOWED_ID });
    await createPaySupportCommand()(ctx);
    expect(replies.map((r) => r.text)).toEqual([paySupportReply()]);
  });
});

// ---- pre_checkout_query ----------------------------------------------------

describe("pre_checkout_query handler", () => {
  const goodQuery = {
    id: "pcq-1",
    currency: "XTR",
    total_amount: 600,
    invoice_payload: buildStarsPayload(USER_UUID),
  };

  test("answers true for a clean checkout", async () => {
    const deps = makeDeps();
    const { ctx, answers } = makeCtx({ fromId: ALLOWED_ID, preCheckout: goodQuery });
    await createPreCheckoutHandler(deps)(ctx);
    expect(answers).toEqual([{ ok: true, message: undefined }]);
  });

  test("answers false with the validation message for a wrong amount", async () => {
    const deps = makeDeps();
    const { ctx, answers } = makeCtx({
      fromId: ALLOWED_ID,
      preCheckout: { ...goodQuery, total_amount: 500 },
    });
    await createPreCheckoutHandler(deps)(ctx);
    expect(answers).toHaveLength(1);
    expect(answers[0].ok).toBe(false);
    expect(answers[0].message).toMatch(/not been charged/);
  });

  test("answers false when billing is disabled", async () => {
    const deps = makeDeps({ billingEnabled: () => false });
    const { ctx, answers } = makeCtx({ fromId: ALLOWED_ID, preCheckout: goodQuery });
    await createPreCheckoutHandler(deps)(ctx);
    expect(answers[0].ok).toBe(false);
    expect(answers[0].message).toMatch(/not open for new purchases/);
  });

  test("always answers, even when the validation itself throws", async () => {
    const deps = makeDeps({
      getUserByTelegramId: async () => {
        throw new Error("db down");
      },
    });
    const { ctx, answers } = makeCtx({ fromId: ALLOWED_ID, preCheckout: goodQuery });
    await createPreCheckoutHandler(deps)(ctx);
    expect(answers).toHaveLength(1);
    expect(answers[0].ok).toBe(false);
    expect(answers[0].message).toBe(preCheckoutErrorReply());
  });

  test("answers false for a payload that belongs to another account", async () => {
    const deps = makeDeps({ userUuid: "b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d" });
    const { ctx, answers } = makeCtx({ fromId: ALLOWED_ID, preCheckout: goodQuery });
    await createPreCheckoutHandler(deps)(ctx);
    expect(answers[0].ok).toBe(false);
    expect(answers[0].message).toMatch(/different account/);
  });
});

// ---- successful_payment ----------------------------------------------------

describe("successful_payment handler", () => {
  const payment = {
    currency: "XTR",
    total_amount: 600,
    invoice_payload: buildStarsPayload(USER_UUID),
    telegram_payment_charge_id: CHARGE_ID,
    provider_payment_charge_id: "provider-1",
  };

  test("replies with the thank-you when the subscription is activated", async () => {
    const handled: Array<{ telegramUserId: number; charge: string }> = [];
    const deps = makeDeps({
      handleSuccessfulPayment: async (args) => {
        handled.push({
          telegramUserId: args.telegramUserId,
          charge: args.payment.telegram_payment_charge_id,
        });
        return { kind: "activated", currentPeriodEnd: new Date("2026-12-05T02:00:00.000Z") };
      },
    });
    const { ctx, replies } = makeCtx({ fromId: ALLOWED_ID, successfulPayment: payment });
    await createSuccessfulPaymentHandler(deps)(ctx);

    expect(handled).toEqual([{ telegramUserId: ALLOWED_ID, charge: CHARGE_ID }]);
    expect(replies).toHaveLength(1);
    expect(replies[0].text).toBe(proActivatedReply(new Date("2026-12-05T02:00:00.000Z")));
    expect(replies[0].text).toMatch(
      /^Pro is on\. It runs until \w{3} \d{1,2} \w{3}, \d{1,2}:\d{2}(am|pm)\. Thanks for backing Settle\.$/,
    );
  });

  test("stays silent on a duplicate charge and on ignored payments", async () => {
    for (const outcome of [
      { kind: "duplicate" as const },
      { kind: "ignored" as const, reason: "foreign_payload" as const },
    ]) {
      const deps = makeDeps({ handleSuccessfulPayment: async () => outcome });
      const { ctx, replies } = makeCtx({ fromId: ALLOWED_ID, successfulPayment: payment });
      await createSuccessfulPaymentHandler(deps)(ctx);
      expect(replies).toHaveLength(0);
    }
  });

  test("never throws when booking fails", async () => {
    const deps = makeDeps({
      handleSuccessfulPayment: async () => {
        throw new Error("db down");
      },
    });
    const { ctx, replies } = makeCtx({ fromId: ALLOWED_ID, successfulPayment: payment });
    await createSuccessfulPaymentHandler(deps)(ctx);
    expect(replies).toHaveLength(0);
  });

  test("payment registration adds all four handlers", () => {
    const { bot, registrations } = makeFakeBot();
    registerPaymentHandlers(bot, makeDeps());
    const names = registrations.map((r) => `${r.kind}:${r.name}`);
    expect(names).toEqual([
      "command:pro",
      "command:paysupport",
      "on:pre_checkout_query",
      "on:message:successful_payment",
    ]);
  });

  test("registered before the catch-all message handler and stops the chain", async () => {
    const { bot, registrations } = makeFakeBot();
    registerPaymentHandlers(bot, makeDeps());
    registerIngestHandlers(bot, {} as Parameters<typeof registerIngestHandlers>[1]);

    const kinds = registrations.map((r) => `${r.kind}:${r.name}`);
    const paymentIndex = kinds.indexOf("on:message:successful_payment");
    const catchAllIndex = kinds.indexOf("on:message");
    expect(paymentIndex).toBeGreaterThan(-1);
    expect(catchAllIndex).toBeGreaterThan(paymentIndex);

    // The payment middleware never calls next, so a successful_payment
    // message can never fall through into ingest.
    let nextCalled = 0;
    const next: NextFunction = async () => {
      nextCalled += 1;
    };
    const { ctx, replies } = makeCtx({ fromId: ALLOWED_ID, successfulPayment: payment });
    await registrations[paymentIndex].handler(ctx, next);
    expect(nextCalled).toBe(0);
    expect(replies).toHaveLength(0); // duplicate outcome by default
  });
});

// ---- allowlist middleware --------------------------------------------------

describe("allowlist middleware with pre_checkout_query", () => {
  function preCtx(fromId: number) {
    const answers: Array<{ queryId: string; ok: boolean; message?: string }> = [];
    const ctx = {
      from: { id: fromId, is_bot: false, first_name: "X" } as User,
      preCheckoutQuery: { id: "pcq-9", currency: "XTR", total_amount: 600, invoice_payload: "x" },
    } as unknown as Parameters<ReturnType<typeof allowlistMiddleware>>[0];
    return {
      ctx,
      answers,
      answer: async (queryId: string, ok: boolean, message?: string) => {
        answers.push({ queryId, ok, message });
        return {};
      },
    };
  }

  const noopNext: NextFunction = async () => {};

  test("a stranger's checkout is answered false, not silently dropped", async () => {
    const refusals: number[] = [];
    let nextCalled = 0;
    const { ctx, answers, answer } = preCtx(STRANGER_ID);
    const mw = allowlistMiddleware(
      [ALLOWED_ID],
      async (chatId) => {
        refusals.push(chatId);
      },
      async (queryId) => answer(queryId, false, PRE_CHECKOUT_CLOSED_REPLY),
    );
    await mw(ctx, async () => {
      nextCalled += 1;
    });
    expect(nextCalled).toBe(0);
    expect(refusals).toEqual([]);
    expect(answers).toEqual([{ queryId: "pcq-9", ok: false, message: PRE_CHECKOUT_CLOSED_REPLY }]);
  });

  test("an allowlisted payer passes through untouched", async () => {
    let nextCalled = 0;
    const { ctx, answers, answer } = preCtx(ALLOWED_ID);
    const mw = allowlistMiddleware(
      [ALLOWED_ID],
      async () => {},
      async (queryId) => answer(queryId, false, PRE_CHECKOUT_CLOSED_REPLY),
    );
    await mw(ctx, async () => {
      nextCalled += 1;
    });
    expect(nextCalled).toBe(1);
    expect(answers).toEqual([]);
  });

  test("without an answer hook a stranger's checkout still never reaches handlers", async () => {
    let nextCalled = 0;
    const { ctx } = preCtx(STRANGER_ID);
    const mw = allowlistMiddleware([ALLOWED_ID], async () => {});
    await mw(ctx, async () => {
      nextCalled += 1;
    });
    expect(nextCalled).toBe(0);
  });

  test("a stranger's plain message still gets the chat refusal", async () => {
    const refusals: number[] = [];
    const ctx = {
      from: { id: STRANGER_ID, is_bot: false, first_name: "X" } as User,
      chat: { id: STRANGER_ID, type: "private" } as Chat,
    } as unknown as Parameters<ReturnType<typeof allowlistMiddleware>>[0];
    const mw = allowlistMiddleware([ALLOWED_ID], async (chatId) => {
      refusals.push(chatId);
    });
    await mw(ctx, noopNext);
    expect(refusals).toEqual([STRANGER_ID]);
  });
});

// ---- webhook route and guards ----------------------------------------------

function preCheckoutUpdate(updateId: number, fromId: number): Update {
  return {
    update_id: updateId,
    pre_checkout_query: {
      id: `pcq-${updateId}`,
      from: { id: fromId, is_bot: false, first_name: "X" },
      currency: "XTR",
      total_amount: 600,
      invoice_payload: buildStarsPayload(USER_UUID),
    },
  } as unknown as Update;
}

type WebhookSpyDeps = Parameters<typeof handleWebhook>[1] & {
  handled: Update[];
  refusals: number[];
  answered: string[];
};

function makeWebhookSpyDeps(
  overrides: Partial<Parameters<typeof handleWebhook>[1]> = {},
): WebhookSpyDeps {
  const handled: Update[] = [];
  const refusals: number[] = [];
  const answered: string[] = [];
  const deps = {
    webhookSecret: SECRET,
    access: [ALLOWED_ID],
    markUpdateSeen: async () => true,
    schedule: (fn: () => Promise<unknown>) => {
      void fn();
    },
    handleUpdate: async (update: Update) => {
      handled.push(update);
    },
    sendRefusal: async (chatId: number) => {
      refusals.push(chatId);
    },
    ...overrides,
  };
  return Object.assign(deps, { handled, refusals, answered }) as WebhookSpyDeps;
}

describe("webhook handling of pre_checkout_query", () => {
  test("senderIdOf reads the payer id from pre_checkout_query", () => {
    expect(senderIdOf(preCheckoutUpdate(1, ALLOWED_ID))).toBe(ALLOWED_ID);
  });

  test("a stranger's query is answered false inline and never handled", async () => {
    const deps = makeWebhookSpyDeps({
      answerPreCheckoutRefusal: async (queryId: string) => {
        deps.answered.push(queryId);
      },
    });
    const res = await handleWebhook(webhookRequest(preCheckoutUpdate(10, STRANGER_ID)), deps);
    expect(res.status).toBe(200);
    expect(deps.answered).toEqual(["pcq-10"]);
    expect(deps.handled).toHaveLength(0);
    expect(deps.refusals).toHaveLength(0);
  });

  test("an allowlisted payer's query flows into the bot handlers", async () => {
    const deps = makeWebhookSpyDeps({
      answerPreCheckoutRefusal: async (queryId: string) => {
        deps.answered.push(queryId);
      },
    });
    const res = await handleWebhook(webhookRequest(preCheckoutUpdate(11, ALLOWED_ID)), deps);
    expect(res.status).toBe(200);
    expect(deps.handled).toHaveLength(1);
    expect(deps.answered).toEqual([]);
    expect(deps.refusals).toEqual([]);
  });

  test("a successful_payment message flows through like any other message", async () => {
    const deps = makeWebhookSpyDeps({});
    const update = {
      update_id: 12,
      message: {
        message_id: 12,
        date: 1_700_000_000,
        chat: { id: ALLOWED_ID, type: "private", first_name: "Tim" },
        from: { id: ALLOWED_ID, is_bot: false, first_name: "Tim" },
        successful_payment: {
          currency: "XTR",
          total_amount: 600,
          invoice_payload: buildStarsPayload(USER_UUID),
          telegram_payment_charge_id: CHARGE_ID,
          provider_payment_charge_id: "provider-1",
        },
      },
    } as unknown as Update;
    const res = await handleWebhook(webhookRequest(update), deps);
    expect(res.status).toBe(200);
    expect(deps.handled).toHaveLength(1);
    expect(deps.refusals).toHaveLength(0);
  });
});
