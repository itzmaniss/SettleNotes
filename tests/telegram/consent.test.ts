import { describe, expect, test } from "bun:test";
import type { Context, NextFunction } from "grammy";
import type { Chat, Message, User } from "grammy/types";
import {
  CONSENT_CALLBACK_DATA,
  buildConsentPrompt,
  consentKeyboard,
  consentMiddleware,
  createConsentAcceptHandler,
  type ConsentCallbackContextLike,
  type ConsentContextLike,
  type ConsentDeps,
} from "../../lib/telegram/consent";
import type { UpsertUserInput } from "../../lib/db/queries";
import type { UserRow } from "../../lib/db/types";
import {
  CONSENT_AGAIN_NOTE,
  CONSENT_INTRO,
  CONSENT_PAY_FIRST,
  CONSENT_PLAIN_LINES,
  CONSENT_RESEND_NOTE,
  CONSENT_THANKS,
} from "../../lib/legal/consent-copy";
import { LEGAL_PATHS } from "../../lib/legal/paths";
import { TERMS_VERSION } from "../../lib/legal/version";
import { commandFailedReply, startText } from "../../lib/telegram/replies";

const NOW = new Date("2026-10-31T09:00:00.000Z");
const BASE = "https://settle.example.com";
const USER_ID = 101;

function acceptedRow(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: "user-1",
    telegram_user_id: USER_ID,
    telegram_chat_id: USER_ID,
    first_name: "Tim",
    timezone: "Asia/Singapore",
    terms_accepted_at: NOW.toISOString(),
    terms_version: TERMS_VERSION,
    created_at: "2026-10-01T01:00:00.000Z",
    ...overrides,
  };
}

function staleRow(): UserRow {
  return acceptedRow({ terms_accepted_at: "2026-01-01T00:00:00.000Z", terms_version: "2020-01-01" });
}

type CtxSpec = {
  fromId?: number;
  chatType?: "private" | "group" | "channel";
  text?: string;
  callbackData?: string;
  preCheckoutId?: string;
  successfulPayment?: Record<string, unknown>;
  photo?: boolean;
  document?: boolean;
  voice?: boolean;
};

type CtxSpy = {
  ctx: ConsentContextLike;
  replies: Array<{ text: string; markup: unknown }>;
  answers: Array<{ ok: boolean; message?: string }>;
};

function makeCtx(spec: CtxSpec = {}): CtxSpy {
  const replies: CtxSpy["replies"] = [];
  const answers: CtxSpy["answers"] = [];
  const message: Record<string, unknown> = {};
  if (spec.text !== undefined) message.text = spec.text;
  if (spec.photo) message.photo = [{ file_id: "p1", width: 10, height: 10 }];
  if (spec.document) message.document = { file_id: "d1", mime_type: "application/pdf" };
  if (spec.voice) message.voice = { file_id: "v1", duration: 10 };
  if (spec.successfulPayment) message.successful_payment = spec.successfulPayment;

  const chatType = spec.chatType ?? "private";
  const ctx: ConsentContextLike = {
    from:
      spec.fromId === undefined
        ? undefined
        : ({ id: spec.fromId, is_bot: false, first_name: "Tim" } as User),
    chat: chatType === "channel" ? ({ id: -100, type: "channel" } as Chat) : ({ id: USER_ID, type: chatType } as Chat),
    message: Object.keys(message).length > 0 ? (message as unknown as Message) : undefined,
    callbackQuery: spec.callbackData === undefined ? undefined : { data: spec.callbackData },
    preCheckoutQuery: spec.preCheckoutId === undefined ? undefined : { id: spec.preCheckoutId },
    reply: async (text, other) => {
      replies.push({ text, markup: other?.reply_markup });
      return {};
    },
    answerPreCheckoutQuery: async (ok, other) => {
      answers.push({ ok, message: other?.error_message });
      return true;
    },
  };
  return { ctx, replies, answers };
}

type DepsSpy = {
  deps: ConsentDeps;
  upserts: UpsertUserInput[];
  prompts: Array<{ text: string; keyboard: unknown }>;
  lookups: number[];
};

function makeDeps(
  user: UserRow | null | Error = null,
  overrides: Partial<ConsentDeps> = {},
): DepsSpy {
  const upserts: UpsertUserInput[] = [];
  const prompts: DepsSpy["prompts"] = [];
  const lookups: number[] = [];
  const deps: ConsentDeps = {
    getUserByTelegramId: async (id) => {
      lookups.push(id);
      if (user instanceof Error) throw user;
      return user;
    },
    upsertUser: async (input) => {
      upserts.push(input);
      return acceptedRow();
    },
    now: () => NOW,
    appBaseUrl: BASE,
    sendConsentPrompt: async (ctx, text, keyboard) => {
      prompts.push({ text, keyboard });
      await ctx.reply(text, keyboard === undefined ? undefined : { reply_markup: keyboard });
      return {};
    },
    ...overrides,
  };
  return { deps, upserts, prompts, lookups };
}

function nextSpy() {
  let called = 0;
  const next: NextFunction = async () => {
    called += 1;
  };
  return { next, called: () => called };
}

async function runGate(spy: CtxSpy, deps: ConsentDeps) {
  const { next, called } = nextSpy();
  await consentMiddleware(deps)(spy.ctx as unknown as Context, next);
  return { passed: called() > 0 };
}

type InlineButton = { text: string; url?: string; callback_data?: string };

// Reads the button matrix out of a reply_markup value the way Telegram sees it.
function inlineRows(markup: unknown): InlineButton[][] {
  return (markup as { inline_keyboard?: InlineButton[][] } | undefined)?.inline_keyboard ?? [];
}

const AGREE_ROW: InlineButton[] = [
  { text: "I agree and continue", callback_data: CONSENT_CALLBACK_DATA },
];

// ---- pure prompt builders ---------------------------------------------------

describe("consentKeyboard", () => {
  test("https base: two URL buttons on row 1, the agree callback on row 2", () => {
    const rows = inlineRows(consentKeyboard(BASE));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual([
      { text: "Terms", url: `${BASE}${LEGAL_PATHS.terms}` },
      { text: "Privacy Policy", url: `${BASE}${LEGAL_PATHS.privacy}` },
    ]);
    expect(rows[1]).toEqual(AGREE_ROW);
    expect(CONSENT_CALLBACK_DATA).toBe("tc:ok");
  });

  test("unusable URL base (http, loopback https, invalid): exactly one button, the agree callback", () => {
    for (const base of ["http://localhost:3000", "https://localhost", "not a url"]) {
      const rows = inlineRows(consentKeyboard(base));
      expect(rows, base).toEqual([AGREE_ROW]);
    }
  });
});

describe("buildConsentPrompt", () => {
  test("a first /start is just the intro with the URL buttons and the agree button", () => {
    const prompt = buildConsentPrompt("none", "start", BASE);
    expect(prompt.text).toBe(CONSENT_INTRO);
    expect(inlineRows(prompt.keyboard)).toEqual([
      [
        { text: "Terms", url: `${BASE}${LEGAL_PATHS.terms}` },
        { text: "Privacy Policy", url: `${BASE}${LEGAL_PATHS.privacy}` },
      ],
      AGREE_ROW,
    ]);
  });

  test("a stale user gets the again note first", () => {
    const prompt = buildConsentPrompt("stale", "start", BASE);
    expect(prompt.text).toBe(`${CONSENT_AGAIN_NOTE}\n\n${CONSENT_INTRO}`);
  });

  test("a dropped non-start message gets the resend note", () => {
    const prompt = buildConsentPrompt("none", "other", BASE);
    expect(prompt.text).toBe(`${CONSENT_RESEND_NOTE}\n\n${CONSENT_INTRO}`);
    const both = buildConsentPrompt("stale", "other", BASE);
    expect(both.text).toBe(`${CONSENT_AGAIN_NOTE}\n\n${CONSENT_RESEND_NOTE}\n\n${CONSENT_INTRO}`);
  });

  test("without usable button URLs the plain lines join the text and the keyboard keeps only the agree button", () => {
    const prompt = buildConsentPrompt("none", "start", "http://localhost:3000");
    expect(prompt.text).toBe(`${CONSENT_INTRO}\n\n${CONSENT_PLAIN_LINES("http://localhost:3000")}`);
    expect(inlineRows(prompt.keyboard)).toEqual([AGREE_ROW]);
  });
});

// ---- the gate ---------------------------------------------------------------

describe("consentMiddleware", () => {
  test("unknown user /start: one prompt, next not called, nothing stored", async () => {
    const spy = makeCtx({ fromId: USER_ID, text: "/start" });
    const { deps, upserts, prompts } = makeDeps(null);
    const { passed } = await runGate(spy, deps);

    expect(passed).toBe(false);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].text).toBe(CONSENT_INTRO);
    expect(inlineRows(prompts[0].keyboard)).toHaveLength(2);
    expect(spy.replies).toHaveLength(1);
    expect(upserts).toEqual([]);
  });

  test("unknown user plain text: prompt with the resend note and the agree button", async () => {
    const spy = makeCtx({ fromId: USER_ID, text: "check this out" });
    const { deps, prompts } = makeDeps(null);
    await runGate(spy, deps);
    expect(prompts[0].text).toBe(`${CONSENT_RESEND_NOTE}\n\n${CONSENT_INTRO}`);
    expect(inlineRows(prompts[0].keyboard)).toEqual([
      [
        { text: "Terms", url: `${BASE}${LEGAL_PATHS.terms}` },
        { text: "Privacy Policy", url: `${BASE}${LEGAL_PATHS.privacy}` },
      ],
      AGREE_ROW,
    ]);
  });

  test("unknown user photo, voice and document each get the prompt with the resend note", async () => {
    for (const spec of [{ photo: true }, { voice: true }, { document: true }] as const) {
      const spy = makeCtx({ fromId: USER_ID, ...spec });
      const { deps, prompts, upserts } = makeDeps(null);
      const { passed } = await runGate(spy, deps);
      expect(passed, JSON.stringify(spec)).toBe(false);
      expect(prompts[0].text, JSON.stringify(spec)).toContain(CONSENT_RESEND_NOTE);
      expect(upserts, JSON.stringify(spec)).toEqual([]);
    }
  });

  test("an unknown command gets the prompt, not a command reply", async () => {
    const spy = makeCtx({ fromId: USER_ID, text: "/tasks" });
    const { deps, prompts } = makeDeps(null);
    await runGate(spy, deps);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].text).toContain(CONSENT_RESEND_NOTE);
  });

  test("/help is always allowed and never even looks the user up", async () => {
    const spy = makeCtx({ fromId: USER_ID, text: "/help" });
    const { deps, prompts, upserts, lookups } = makeDeps(new Error("no db in this test"));
    const { passed } = await runGate(spy, deps);
    expect(passed).toBe(true);
    expect(prompts).toEqual([]);
    expect(upserts).toEqual([]);
    expect(lookups).toEqual([]);
  });

  test("a stale user gets the again note and the agree button", async () => {
    const spy = makeCtx({ fromId: USER_ID, text: "/start" });
    const { deps, prompts } = makeDeps(staleRow());
    await runGate(spy, deps);
    expect(prompts[0].text).toBe(`${CONSENT_AGAIN_NOTE}\n\n${CONSENT_INTRO}`);
    expect(inlineRows(prompts[0].keyboard)).toEqual([
      [
        { text: "Terms", url: `${BASE}${LEGAL_PATHS.terms}` },
        { text: "Privacy Policy", url: `${BASE}${LEGAL_PATHS.privacy}` },
      ],
      AGREE_ROW,
    ]);
  });

  test("an accepted user passes straight through untouched", async () => {
    const spy = makeCtx({ fromId: USER_ID, text: "hello again" });
    const { deps, prompts, upserts } = makeDeps(acceptedRow());
    const { passed } = await runGate(spy, deps);
    expect(passed).toBe(true);
    expect(prompts).toEqual([]);
    expect(upserts).toEqual([]);
  });

  test("a lookup error fails closed with the friendly reply, for a message", async () => {
    const spy = makeCtx({ fromId: USER_ID, text: "/start" });
    const { deps, prompts } = makeDeps(new Error("db down"));
    const { passed } = await runGate(spy, deps);
    expect(passed).toBe(false);
    expect(prompts).toEqual([]);
    expect(spy.replies.map((r) => r.text)).toEqual([commandFailedReply()]);
  });

  test("a non-https base sends plain lines in the text and a keyboard with only the agree button", async () => {
    const spy = makeCtx({ fromId: USER_ID, text: "/start" });
    const { deps, prompts } = makeDeps(null, { appBaseUrl: "http://localhost:3000" });
    await runGate(spy, deps);
    expect(prompts[0].text).toBe(`${CONSENT_INTRO}\n\n${CONSENT_PLAIN_LINES("http://localhost:3000")}`);
    expect(inlineRows(prompts[0].keyboard)).toEqual([AGREE_ROW]);
  });

  test("every blocked sender keeps the agree button: none or stale, /start or other", async () => {
    for (const user of [null, staleRow()]) {
      for (const text of ["/start", "just a message"]) {
        const spy = makeCtx({ fromId: USER_ID, text });
        const { deps, prompts } = makeDeps(user, { appBaseUrl: "http://localhost:3000" });
        await runGate(spy, deps);
        expect(prompts, JSON.stringify({ user, text })).toHaveLength(1);
        const rows = inlineRows(prompts[0].keyboard);
        expect(rows, JSON.stringify({ user, text })).toEqual([AGREE_ROW]);
        expect(rows[0][0].callback_data, JSON.stringify({ user, text })).toBe("tc:ok");
        expect(rows[0][0].url, JSON.stringify({ user, text })).toBeUndefined();
      }
    }
  });

  test("a pre_checkout_query from an unaccepted user is answered false with the pay line", async () => {
    const spy = makeCtx({ fromId: USER_ID, preCheckoutId: "pcq-1" });
    const { deps } = makeDeps(null);
    const { passed } = await runGate(spy, deps);
    expect(passed).toBe(false);
    expect(spy.answers).toEqual([{ ok: false, message: CONSENT_PAY_FIRST }]);
  });

  test("a pre_checkout_query from a stale user is answered false too", async () => {
    const spy = makeCtx({ fromId: USER_ID, preCheckoutId: "pcq-1" });
    const { deps } = makeDeps(staleRow());
    await runGate(spy, deps);
    expect(spy.answers).toEqual([{ ok: false, message: CONSENT_PAY_FIRST }]);
  });

  test("a pre_checkout_query from an accepted user passes through", async () => {
    const spy = makeCtx({ fromId: USER_ID, preCheckoutId: "pcq-1" });
    const { deps } = makeDeps(acceptedRow());
    const { passed } = await runGate(spy, deps);
    expect(passed).toBe(true);
    expect(spy.answers).toEqual([]);
  });

  test("a pre_checkout lookup error answers false instead of hanging the payer", async () => {
    const spy = makeCtx({ fromId: USER_ID, preCheckoutId: "pcq-1" });
    const { deps } = makeDeps(new Error("db down"));
    const { passed } = await runGate(spy, deps);
    expect(passed).toBe(false);
    expect(spy.answers).toEqual([{ ok: false, message: commandFailedReply() }]);
  });

  test("a successful_payment always passes through, acceptance or not", async () => {
    for (const user of [null, staleRow(), acceptedRow()]) {
      const spy = makeCtx({ fromId: USER_ID, successfulPayment: { currency: "XTR" } });
      const { deps, prompts, upserts } = makeDeps(user);
      const { passed } = await runGate(spy, deps);
      expect(passed, JSON.stringify(user)).toBe(true);
      expect(prompts, JSON.stringify(user)).toEqual([]);
      expect(upserts, JSON.stringify(user)).toEqual([]);
    }
  });

  test("the consent tap passes through to the accept handler, even before acceptance", async () => {
    const spy = makeCtx({ fromId: USER_ID, callbackData: CONSENT_CALLBACK_DATA });
    const { deps, prompts, upserts } = makeDeps(null);
    const { passed } = await runGate(spy, deps);
    expect(passed).toBe(true);
    expect(prompts).toEqual([]);
    expect(upserts).toEqual([]);
  });

  test("any other callback from an unaccepted user is dropped with the resend note", async () => {
    const spy = makeCtx({ fromId: USER_ID, callbackData: "pa:y:abc" });
    const { deps, prompts } = makeDeps(null);
    const { passed } = await runGate(spy, deps);
    expect(passed).toBe(false);
    expect(prompts[0].text).toContain(CONSENT_RESEND_NOTE);
  });

  test("a group chat with an unaccepted sender is ignored quietly", async () => {
    const spy = makeCtx({ fromId: USER_ID, chatType: "group", text: "hello" });
    const { deps, prompts, upserts } = makeDeps(null);
    const { passed } = await runGate(spy, deps);
    expect(passed).toBe(false);
    expect(prompts).toEqual([]);
    expect(upserts).toEqual([]);
  });

  test("an accepted user in a group still passes through", async () => {
    const spy = makeCtx({ fromId: USER_ID, chatType: "group", text: "hello" });
    const { deps, prompts } = makeDeps(acceptedRow());
    const { passed } = await runGate(spy, deps);
    expect(passed).toBe(true);
    expect(prompts).toEqual([]);
  });

  test("an update with no sender is ignored", async () => {
    const spy = makeCtx({});
    const { deps, prompts } = makeDeps(acceptedRow());
    const { passed } = await runGate(spy, deps);
    expect(passed).toBe(false);
    expect(prompts).toEqual([]);
  });
});

// ---- the accept callback ----------------------------------------------------

type AcceptSpy = {
  ctx: ConsentCallbackContextLike;
  replies: Array<{ text: string; markup: unknown }>;
  edits: Array<{ text: string; markup: unknown }>;
  answers: number[];
};

function makeAcceptCtx(spec: { chatType?: "private" | "group"; editFails?: boolean } = {}): AcceptSpy {
  const replies: AcceptSpy["replies"] = [];
  const edits: AcceptSpy["edits"] = [];
  const answers: number[] = [];
  const chatType = spec.chatType ?? "private";
  const ctx: ConsentCallbackContextLike = {
    from: { id: USER_ID, is_bot: false, first_name: "Tim" } as User,
    chat: { id: USER_ID, type: chatType } as Chat,
    callbackQuery: { data: CONSENT_CALLBACK_DATA },
    answerCallbackQuery: async () => {
      answers.push(1);
      return true;
    },
    editMessageText: async (text, other) => {
      if (spec.editFails) throw new Error("message cannot be edited");
      edits.push({ text, markup: other?.reply_markup });
      return {};
    },
    reply: async (text, other) => {
      replies.push({ text, markup: other?.reply_markup });
      return {};
    },
  };
  return { ctx, replies, edits, answers };
}

describe("createConsentAcceptHandler", () => {
  test("a tap creates the row with the terms fields, thanks, then the normal welcome", async () => {
    const spy = makeAcceptCtx();
    const { deps, upserts } = makeDeps(null);
    await createConsentAcceptHandler(deps)(spy.ctx);

    expect(spy.answers).toEqual([1]);
    expect(upserts).toEqual([
      {
        telegramUserId: USER_ID,
        telegramChatId: USER_ID,
        firstName: "Tim",
        termsAcceptedAt: NOW,
        termsVersion: TERMS_VERSION,
      },
    ]);
    expect(spy.edits).toHaveLength(1);
    expect(spy.edits[0].text).toBe(CONSENT_THANKS);
    // The keyboard is actually removed, not left on the message.
    expect(JSON.stringify(spy.edits[0].markup)).not.toContain(CONSENT_CALLBACK_DATA);
    expect(spy.replies.map((r) => r.text)).toEqual([startText("Tim", BASE)]);
  });

  test("the welcome carries the dashboard keyboard when the base allows URL buttons", async () => {
    const spy = makeAcceptCtx();
    const { deps } = makeDeps(null);
    await createConsentAcceptHandler(deps)(spy.ctx);
    expect(spy.replies[0].markup).toBeDefined();
    expect(JSON.stringify(spy.replies[0].markup)).toContain(`${BASE}/dashboard`);
  });

  test("a double tap is harmless: the upsert is idempotent and the flow repeats", async () => {
    const spy = makeAcceptCtx();
    const { deps, upserts } = makeDeps(null);
    const handler = createConsentAcceptHandler(deps);
    await handler(spy.ctx);
    await handler(spy.ctx);
    expect(upserts).toHaveLength(2);
    expect(upserts[0].telegramUserId).toBe(upserts[1].telegramUserId);
  });

  test("a failed edit falls back to a plain thanks reply", async () => {
    const spy = makeAcceptCtx({ editFails: true });
    const { deps, upserts } = makeDeps(null);
    await createConsentAcceptHandler(deps)(spy.ctx);
    expect(upserts).toHaveLength(1);
    expect(spy.edits).toEqual([]);
    expect(spy.replies.map((r) => r.text)).toContain(CONSENT_THANKS);
  });

  test("a failed upsert says so instead of pretending the acceptance saved", async () => {
    const spy = makeAcceptCtx();
    const failing: ConsentDeps = {
      ...makeDeps(null).deps,
      upsertUser: async () => {
        throw new Error("db down");
      },
    };
    await createConsentAcceptHandler(failing)(spy.ctx);
    expect(spy.edits).toEqual([]);
    expect(spy.replies.map((r) => r.text)).toEqual([commandFailedReply()]);
  });

  test("a tap anywhere but a private chat never writes a group id as the chat id", async () => {
    const spy = makeAcceptCtx({ chatType: "group" });
    const { deps, upserts } = makeDeps(null);
    await createConsentAcceptHandler(deps)(spy.ctx);
    expect(upserts[0].telegramChatId).toBe(USER_ID);
  });

  test("any other callback data is handed to next(), never swallowed", async () => {
    const spy = makeAcceptCtx();
    spy.ctx.callbackQuery = { data: "pa:y:abc" };
    const { deps, upserts } = makeDeps(acceptedRow());
    const { next, called } = nextSpy();
    await createConsentAcceptHandler(deps)(spy.ctx, next);
    expect(called()).toBe(1);
    expect(upserts).toEqual([]);
  });
});
