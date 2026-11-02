import { describe, expect, test } from "bun:test";
import type { NextFunction } from "grammy";
import type { Chat, User } from "grammy/types";
import type {
  PaymentsDeps,
  PurchaseConfirmCallbackContextLike,
} from "../../lib/telegram/payments";
import {
  createPurchaseConfirmCallback,
  createPreCheckoutHandler,
  registerPaymentHandlers,
  type PaymentsContextLike,
} from "../../lib/telegram/payments";
import { buildStarsPayload } from "../../lib/billing/stars";
import { TERMS_VERSION } from "../../lib/legal/version";
import {
  PURCHASE_CONFIRM_DECLINED,
  PURCHASE_CONFIRM_FAILED,
  PURCHASE_CONFIRM_FIRST,
  PURCHASE_CONFIRM_THANKS,
} from "../../lib/billing/purchase-consent-copy";
import {
  PURCHASE_CONFIRM_CALLBACK_DATA,
  PURCHASE_DECLINE_CALLBACK_DATA,
  clearedKeyboard,
  commandFailedReply,
  proInvoiceReply,
} from "../../lib/telegram/replies";
import { ALLOWED_ID } from "./fixtures";

const USER_UUID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const MINUTE_MS = 60 * 1000;

type Bot = import("grammy").Bot;

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

type CbSpec = {
  fromId?: number;
  chatType?: "private" | "group";
  data?: string;
  editFailsOnCall?: number;
};

function makeCbCtx(spec: CbSpec = {}, timeline: string[] = []) {
  const replies: Array<{ text: string; markup: unknown }> = [];
  const edits: Array<{ text: string; markup: unknown }> = [];
  const answers: number[] = [];
  let editCalls = 0;
  const ctx: PurchaseConfirmCallbackContextLike = {
    from:
      spec.fromId === undefined
        ? undefined
        : ({ id: spec.fromId, is_bot: false, first_name: "Tim" } as User),
    chat: { id: spec.fromId ?? ALLOWED_ID, type: spec.chatType ?? "private" } as Chat,
    callbackQuery: { data: spec.data ?? PURCHASE_CONFIRM_CALLBACK_DATA },
    answerCallbackQuery: async () => {
      answers.push(1);
      timeline.push("answer");
      return true;
    },
    editMessageText: async (text, other) => {
      editCalls += 1;
      if (spec.editFailsOnCall !== undefined && editCalls === spec.editFailsOnCall) {
        throw new Error("message is not modified");
      }
      edits.push({ text, markup: other?.reply_markup });
      timeline.push("edit");
      return {};
    },
    reply: async (text, other) => {
      replies.push({ text, markup: other?.reply_markup });
      timeline.push("reply");
      return {};
    },
  };
  return { ctx, timeline, replies, edits, answers };
}

type DepsSpy = PaymentsDeps & {
  invoices: Array<{ userId: string; amount: number }>;
  confirmations: Array<{ userId: string; at: Date }>;
  timeline: string[];
};

function makeDeps(overrides: Partial<PaymentsDeps> = {}, timeline: string[] = []): DepsSpy {
  const invoices: Array<{ userId: string; amount: number }> = [];
  const confirmations: Array<{ userId: string; at: Date }> = [];
  const makeUser = () => ({
    id: USER_UUID,
    telegram_user_id: ALLOWED_ID,
    telegram_chat_id: ALLOWED_ID,
    first_name: "Tim",
    timezone: "Asia/Singapore",
    terms_accepted_at: "2026-10-31T01:00:00.000Z",
    terms_version: TERMS_VERSION,
    created_at: "2026-10-01T01:00:00.000Z",
  });
  return {
    billingEnabled: () => true,
    getUserByTelegramId: async (id) => (id === ALLOWED_ID ? makeUser() : null),
    getActiveSubscription: async () => null,
    recordConfirmation: async (userId, at) => {
      timeline.push("record");
      confirmations.push({ userId, at });
      return { ok: true };
    },
    latestConfirmationAt: async () => new Date(Date.now() - 5 * MINUTE_MS),
    createInvoiceLink: async (args) => {
      timeline.push("invoice");
      invoices.push(args);
      return `https://t.me/invoice-${args.amount}`;
    },
    handleSuccessfulPayment: async () => ({ kind: "duplicate" }),
    invoices,
    confirmations,
    timeline,
    ...overrides,
  };
}

// ---- pc:ok ------------------------------------------------------------------

describe("purchase confirm callback pc:ok", () => {
  test("answers, records, edits the prompt to the thanks, then sends the invoice, in order", async () => {
    const timeline: string[] = [];
    const deps = makeDeps({}, timeline);
    const { ctx, replies, edits, answers } = makeCbCtx({ fromId: ALLOWED_ID }, timeline);
    await createPurchaseConfirmCallback(deps)(ctx);

    expect(answers).toHaveLength(1);
    // The invoice send itself is a ctx reply after the invoice link.
    expect(timeline).toEqual(["answer", "record", "edit", "invoice", "reply"]);
    expect(deps.confirmations).toEqual([
      { userId: USER_UUID, at: expect.any(Date) },
    ]);
    expect(edits).toEqual([{ text: PURCHASE_CONFIRM_THANKS, markup: JSON.parse(JSON.stringify(clearedKeyboard())) }]);
    expect(deps.invoices).toEqual([{ userId: USER_UUID, amount: 600 }]);
    expect(replies).toEqual([
      { text: proInvoiceReply(600), markup: expect.anything() },
    ]);
  });

  test("a failed save sends the failure line, no edit and no invoice", async () => {
    const timeline: string[] = [];
    const deps = makeDeps(
      {
        recordConfirmation: async () => {
          timeline.push("record");
          return { ok: false };
        },
      },
      timeline,
    );
    const { ctx, replies, edits } = makeCbCtx({ fromId: ALLOWED_ID }, timeline);
    await createPurchaseConfirmCallback(deps)(ctx);

    expect(timeline).toEqual(["answer", "record", "reply"]);
    expect(deps.confirmations).toHaveLength(0);
    expect(replies.map((r) => r.text)).toEqual([PURCHASE_CONFIRM_FAILED]);
    expect(edits).toEqual([]);
    expect(deps.invoices).toHaveLength(0);
  });

  test("a thrown save is treated like a failed save", async () => {
    const deps = makeDeps({
      recordConfirmation: async () => {
        throw new Error("db down");
      },
    });
    const { ctx, replies, edits } = makeCbCtx({ fromId: ALLOWED_ID });
    await createPurchaseConfirmCallback(deps)(ctx);
    expect(replies.map((r) => r.text)).toEqual([PURCHASE_CONFIRM_FAILED]);
    expect(edits).toEqual([]);
    expect(deps.invoices).toHaveLength(0);
  });

  test("a missing user row fails closed with the failure line", async () => {
    const deps = makeDeps({ getUserByTelegramId: async () => null });
    const { ctx, replies } = makeCbCtx({ fromId: ALLOWED_ID });
    await createPurchaseConfirmCallback(deps)(ctx);
    expect(replies.map((r) => r.text)).toEqual([PURCHASE_CONFIRM_FAILED]);
    expect(deps.invoices).toHaveLength(0);
  });

  test("a failed edit falls back to a plain thanks reply, then the invoice", async () => {
    const timeline: string[] = [];
    const deps = makeDeps({}, timeline);
    const { ctx, replies, edits } = makeCbCtx(
      {
        fromId: ALLOWED_ID,
        editFailsOnCall: 1,
      },
      timeline,
    );
    await createPurchaseConfirmCallback(deps)(ctx);
    expect(timeline).toEqual(["answer", "record", "reply", "invoice", "reply"]);
    expect(edits).toEqual([]);
    expect(replies[0].text).toBe(PURCHASE_CONFIRM_THANKS);
    expect(deps.invoices).toHaveLength(1);
  });

  test("an invoice failure after the save keeps the thanks and says the bot side failed", async () => {
    const timeline: string[] = [];
    const deps = makeDeps(
      {
        createInvoiceLink: async () => {
          throw new Error("telegram down");
        },
      },
      timeline,
    );
    const { ctx, replies, edits } = makeCbCtx({ fromId: ALLOWED_ID }, timeline);
    await createPurchaseConfirmCallback(deps)(ctx);
    expect(timeline).toEqual(["answer", "record", "edit", "reply"]);
    expect(edits).toHaveLength(1);
    expect(replies.map((r) => r.text)).toEqual([commandFailedReply()]);
  });

  test("a double tap never throws: the second edit falls back and the flow simply repeats", async () => {
    const deps = makeDeps();
    const { ctx, replies, edits, answers } = makeCbCtx({
      fromId: ALLOWED_ID,
      // Telegram refuses an identical second edit ("message is not modified").
      editFailsOnCall: 2,
    });
    const handler = createPurchaseConfirmCallback(deps);
    await handler(ctx);
    await handler(ctx);

    expect(answers).toHaveLength(2);
    expect(deps.confirmations).toHaveLength(2);
    expect(edits).toHaveLength(1);
    // First tap edits thanks + invoice reply; second tap thanks reply + invoice reply.
    expect(replies.map((r) => r.text)).toEqual([proInvoiceReply(600), PURCHASE_CONFIRM_THANKS, proInvoiceReply(600)]);
    expect(deps.invoices).toHaveLength(2);
  });

  test("a tap outside a private chat is ignored completely", async () => {
    const deps = makeDeps();
    const { ctx, replies, edits, answers } = makeCbCtx({
      fromId: ALLOWED_ID,
      chatType: "group",
    });
    await createPurchaseConfirmCallback(deps)(ctx);
    expect(answers).toHaveLength(0);
    expect(deps.confirmations).toHaveLength(0);
    expect(edits).toHaveLength(0);
    expect(replies).toHaveLength(0);
    expect(deps.invoices).toHaveLength(0);
  });

  test("any other callback data is handed to next(), never swallowed", async () => {
    const deps = makeDeps();
    const { ctx } = makeCbCtx({ fromId: ALLOWED_ID, data: "pa:y:abc" });
    let nextCalled = 0;
    const next: NextFunction = async () => {
      nextCalled += 1;
    };
    await createPurchaseConfirmCallback(deps)(ctx, next);
    expect(nextCalled).toBe(1);
    expect(deps.confirmations).toHaveLength(0);
  });
});

// ---- pc:no --------------------------------------------------------------------

describe("purchase confirm callback pc:no", () => {
  test("answers and edits to the declined line, writes nothing, sends no invoice", async () => {
    const timeline: string[] = [];
    const deps = makeDeps({}, timeline);
    const { ctx, replies, edits } = makeCbCtx(
      {
        fromId: ALLOWED_ID,
        data: PURCHASE_DECLINE_CALLBACK_DATA,
      },
      timeline,
    );
    await createPurchaseConfirmCallback(deps)(ctx);

    expect(timeline).toEqual(["answer", "edit"]);
    expect(edits).toEqual([
      { text: PURCHASE_CONFIRM_DECLINED, markup: JSON.parse(JSON.stringify(clearedKeyboard())) },
    ]);
    expect(deps.confirmations).toHaveLength(0);
    expect(deps.invoices).toHaveLength(0);
    expect(replies).toHaveLength(0);
  });
});

// ---- registration order ---------------------------------------------------------

describe("purchase confirm registration", () => {
  test("the callback handler is registered with the other payment handlers", () => {
    const { bot, registrations } = makeFakeBot();
    registerPaymentHandlers(bot, makeDeps());
    const names = registrations.map((r) => `${r.kind}:${r.name}`);
    expect(names).toContain("on:callback_query:data");
    // pc: sits in front of the pa: resolver's callback handler, which is
    // registered separately by bot.ts.
    expect(names.indexOf("on:callback_query:data")).toBe(names.indexOf("on:pre_checkout_query") - 1);
  });
});

// ---- pre_checkout decision table --------------------------------------------------

function preCtx(): { ctx: PaymentsContextLike; answers: Array<{ ok: boolean; message?: string }> } {
  const answers: Array<{ ok: boolean; message?: string }> = [];
  const ctx: PaymentsContextLike = {
    from: { id: ALLOWED_ID, is_bot: false, first_name: "Tim" } as User,
    chat: { id: ALLOWED_ID, type: "private" } as Chat,
    preCheckoutQuery: {
      id: "pcq-1",
      currency: "XTR",
      total_amount: 600,
      invoice_payload: buildStarsPayload(USER_UUID),
    },
    reply: async () => ({}),
    answerPreCheckoutQuery: async (ok, other) => {
      answers.push({ ok, message: other?.error_message });
      return true;
    },
  };
  return { ctx, answers };
}

describe("pre_checkout confirm gate", () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * MINUTE_MS);

  test("a confirmation 5 minutes old answers true", async () => {
    const deps = makeDeps({ latestConfirmationAt: async () => minutesAgo(5) });
    const { ctx, answers } = preCtx();
    await createPreCheckoutHandler(deps)(ctx);
    expect(answers).toEqual([{ ok: true, message: undefined }]);
  });

  test("a confirmation 61 minutes old answers false with the confirm line", async () => {
    const deps = makeDeps({ latestConfirmationAt: async () => minutesAgo(61) });
    const { ctx, answers } = preCtx();
    await createPreCheckoutHandler(deps)(ctx);
    expect(answers).toEqual([{ ok: false, message: PURCHASE_CONFIRM_FIRST }]);
  });

  test("an active Stars subscriber without a confirmation answers true (renewal)", async () => {
    const deps = makeDeps({
      latestConfirmationAt: async () => null,
      getActiveSubscription: async () => ({
        plan: "pro",
        provider: "stars",
        current_period_end: "2026-12-05T02:00:00.000Z",
      }),
    });
    const { ctx, answers } = preCtx();
    await createPreCheckoutHandler(deps)(ctx);
    expect(answers).toEqual([{ ok: true, message: undefined }]);
  });

  test("a subscription lookup error fails closed with the failure line", async () => {
    const deps = makeDeps({
      latestConfirmationAt: async () => null,
      getActiveSubscription: async () => {
        throw new Error("db down");
      },
    });
    const { ctx, answers } = preCtx();
    await createPreCheckoutHandler(deps)(ctx);
    expect(answers).toHaveLength(1);
    expect(answers[0].ok).toBe(false);
    expect(answers[0].message).toBe(PURCHASE_CONFIRM_FAILED);
  });
});
