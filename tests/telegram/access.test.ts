import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import {
  announceBlockedOpen,
  isAccessAllowed,
  resolveAccessPolicy,
  toAccessPolicy,
  type AccessPolicyInputs,
} from "../../lib/telegram/access";
import { allowlistMiddleware } from "../../lib/telegram/handlers";
import { handleWebhook, type WebhookDeps } from "../../lib/telegram/guards";
import { completeTelegramLogin, type TelegramLoginDeps } from "../../lib/auth/telegram-login";
import {
  ALLOWED_ID,
  SECRET,
  STRANGER_ID,
  callbackUpdate,
  channelPostUpdate,
  textUpdate,
  webhookRequest,
} from "./fixtures";

const ALLOWED: AccessPolicyInputs = {
  allowlistEnabled: true,
  billingEnabled: false,
  allowedIds: [ALLOWED_ID],
};
const OPEN: AccessPolicyInputs = {
  allowlistEnabled: false,
  billingEnabled: true,
  allowedIds: [ALLOWED_ID],
};
const BLOCKED: AccessPolicyInputs = {
  allowlistEnabled: false,
  billingEnabled: false,
  allowedIds: [ALLOWED_ID],
};

function webhookDeps(access: number[] | WebhookDeps["access"], overrides: Partial<WebhookDeps> = {}) {
  const scheduled: Array<() => Promise<unknown>> = [];
  const refusals: number[] = [];
  const handled: unknown[] = [];
  const deps: WebhookDeps = {
    webhookSecret: SECRET,
    access,
    markUpdateSeen: async () => true,
    schedule: (fn) => {
      scheduled.push(fn);
    },
    handleUpdate: async (update) => {
      handled.push(update);
    },
    sendRefusal: async (chatId) => {
      refusals.push(chatId);
    },
    ...overrides,
  };
  return { deps, scheduled, refusals, handled };
}

function loginDeps(access: number[] | TelegramLoginDeps["access"]): TelegramLoginDeps {
  return {
    botToken: "123456:test-bot-token",
    access,
    getUserByTelegramId: async () => null,
    upsertUser: async () => ({ id: "user-1" }),
    createSession: async () => "session-token",
    now: new Date("2026-10-31T04:00:00.000Z"),
  };
}

// A widget payload signed with the token above, so verification passes.
function signedLoginParams(): Record<string, string> {
  const fields: Record<string, string> = {
    id: String(900000003),
    first_name: "New",
    auth_date: String(Math.floor(new Date("2026-10-31T04:00:00.000Z").getTime() / 1000)),
  };
  const secret = createHash("sha256").update("123456:test-bot-token", "utf8").digest();
  const hash = createHmac("sha256", secret)
    .update(
      Object.keys(fields)
        .sort()
        .map((key) => `${key}=${fields[key]}`)
        .join("\n"),
      "utf8",
    )
    .digest("hex");
  return { ...fields, hash };
}

describe("resolveAccessPolicy", () => {
  test("flag table: allowlist on keeps the list with reason default, billing on or off", () => {
    for (const billingEnabled of [false, true]) {
      const policy = resolveAccessPolicy({ ...ALLOWED, billingEnabled });
      expect(policy).toEqual({
        mode: "allowlist",
        allowedIds: [ALLOWED_ID],
        reason: "default",
      });
    }
  });

  test("open only when the allowlist is off AND billing is on, list content irrelevant", () => {
    expect(resolveAccessPolicy(OPEN)).toEqual({ mode: "open" });
    expect(resolveAccessPolicy({ ...OPEN, allowedIds: [] })).toEqual({ mode: "open" });
  });

  test("safety rule: opening with billing off stays allowlist and is flagged", () => {
    const policy = resolveAccessPolicy(BLOCKED);
    expect(policy).toEqual({
      mode: "allowlist",
      allowedIds: [ALLOWED_ID],
      reason: "blocked_billing_off",
    });
  });

  test("safety rule holds with an empty list too: nobody gets in, nobody gets unlimited AI", () => {
    const policy = resolveAccessPolicy({ ...BLOCKED, allowedIds: [] });
    expect(policy).toEqual({ mode: "allowlist", allowedIds: [], reason: "blocked_billing_off" });
    expect(isAccessAllowed(STRANGER_ID, policy)).toBe(false);
  });

  test("announceBlockedOpen logs the blocked pairing once, nothing for the others", () => {
    const lines: string[] = [];
    const log = (message: string) => lines.push(message);
    announceBlockedOpen(resolveAccessPolicy(ALLOWED), log);
    announceBlockedOpen(resolveAccessPolicy(OPEN), log);
    expect(lines).toEqual([]);
    announceBlockedOpen(resolveAccessPolicy(BLOCKED), log);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("BILLING_ENABLED=false");
    expect(lines[0]).not.toMatch(/[\u2013\u2014]/);
    // Once per process: a second blocked resolution stays quiet.
    announceBlockedOpen(resolveAccessPolicy(BLOCKED), log);
    expect(lines.length).toBe(1);
  });
});

describe("isAccessAllowed", () => {
  test("allowlist mode: listed ids pass, others fail, undefined sender fails", () => {
    const policy = resolveAccessPolicy(ALLOWED);
    expect(isAccessAllowed(ALLOWED_ID, policy)).toBe(true);
    expect(isAccessAllowed(STRANGER_ID, policy)).toBe(false);
    expect(isAccessAllowed(undefined, policy)).toBe(false);
  });

  test("open mode: any identified sender passes, a missing sender still does not", () => {
    const policy = resolveAccessPolicy(OPEN);
    expect(isAccessAllowed(ALLOWED_ID, policy)).toBe(true);
    expect(isAccessAllowed(STRANGER_ID, policy)).toBe(true);
    expect(isAccessAllowed(123456789, policy)).toBe(true);
    expect(isAccessAllowed(undefined, policy)).toBe(false);
  });

  test("a bare id list keeps meaning the default allowlist", () => {
    expect(isAccessAllowed(ALLOWED_ID, [ALLOWED_ID])).toBe(true);
    expect(isAccessAllowed(STRANGER_ID, [ALLOWED_ID])).toBe(false);
    expect(toAccessPolicy([ALLOWED_ID])).toEqual({
      mode: "allowlist",
      allowedIds: [ALLOWED_ID],
      reason: "default",
    });
  });
});

describe("call sites honour the policy", () => {
  test("webhook: allowlist mode refuses a stranger with a scheduled refusal", async () => {
    const ctx = webhookDeps(resolveAccessPolicy(ALLOWED));
    const res = await handleWebhook(webhookRequest(textUpdate(1, STRANGER_ID, 555)), ctx.deps);
    expect(res.status).toBe(200);
    expect(ctx.handled).toEqual([]);
    await ctx.scheduled[0]!();
    expect(ctx.refusals).toEqual([555]);
  });

  test("webhook: open mode handles the same stranger's update like anyone else", async () => {
    const ctx = webhookDeps(resolveAccessPolicy(OPEN));
    const update = textUpdate(2, STRANGER_ID, 555);
    const res = await handleWebhook(webhookRequest(update), ctx.deps);
    expect(res.status).toBe(200);
    await ctx.scheduled[0]!();
    expect(ctx.handled).toEqual([update]);
    expect(ctx.refusals).toEqual([]);
  });

  test("webhook: open mode still ignores updates without a sender", async () => {
    const ctx = webhookDeps(resolveAccessPolicy(OPEN));
    const res = await handleWebhook(webhookRequest(channelPostUpdate(3)), ctx.deps);
    expect(res.status).toBe(200);
    expect(ctx.scheduled).toEqual([]);
    expect(ctx.handled).toEqual([]);
  });

  test("webhook: open mode lets a stranger's pre-checkout through to the payment validator", async () => {
    const answered: string[] = [];
    const ctx = webhookDeps(resolveAccessPolicy(OPEN), {
      answerPreCheckoutRefusal: async (queryId) => {
        answered.push(queryId);
      },
    });
    const update = {
      update_id: 4,
      pre_checkout_query: {
        id: "pcq-4",
        from: { id: STRANGER_ID, is_bot: false, first_name: "X" },
        currency: "XTR",
        total_amount: 600,
        invoice_payload: "payload",
      },
    };
    const res = await handleWebhook(webhookRequest(update), ctx.deps);
    expect(res.status).toBe(200);
    // Not refused at the gate: the bot's own pre-checkout validation decides.
    await ctx.scheduled[0]!();
    expect(ctx.handled).toHaveLength(1);
    expect(answered).toEqual([]);
  });

  test("bot middleware: allowlist mode refuses, open mode passes the stranger through", async () => {
    let nextAllowlist = 0;
    let nextOpen = 0;
    const refusals: number[] = [];
    const ctx = { from: { id: STRANGER_ID, is_bot: false, first_name: "X" }, chat: { id: STRANGER_ID, type: "private" } };
    const mwAllowlist = allowlistMiddleware(
      resolveAccessPolicy(ALLOWED),
      async (chatId) => {
        refusals.push(chatId);
      },
    );
    await mwAllowlist(ctx as never, async () => {
      nextAllowlist += 1;
    });
    expect(nextAllowlist).toBe(0);
    expect(refusals).toEqual([STRANGER_ID]);

    const mwOpen = allowlistMiddleware(resolveAccessPolicy(OPEN), async (chatId) => {
      refusals.push(chatId);
    });
    await mwOpen(ctx as never, async () => {
      nextOpen += 1;
    });
    expect(nextOpen).toBe(1);
    expect(refusals).toEqual([STRANGER_ID]);
  });

  test("web login: allowlist mode denies an unlisted verified user, open mode admits them", async () => {
    const params = signedLoginParams();
    const denied = await completeTelegramLogin(loginDeps(resolveAccessPolicy(ALLOWED)), params);
    expect(denied.kind).toBe("denied");
    const allowed = await completeTelegramLogin(loginDeps(resolveAccessPolicy(OPEN)), params);
    expect(allowed.kind).toBe("ok");
  });

  test("web login: open mode still verifies the Telegram hash first", async () => {
    const badHash = { ...signedLoginParams(), hash: "0".repeat(64) };
    const outcome = await completeTelegramLogin(loginDeps(resolveAccessPolicy(OPEN)), badHash);
    expect(outcome.kind).toBe("invalid");
  });

  test("web login: open mode still refuses a tampered id field", async () => {
    const params = signedLoginParams();
    const tampered = { ...params, id: "1" };
    const outcome = await completeTelegramLogin(loginDeps(resolveAccessPolicy(OPEN)), tampered);
    expect(outcome.kind).toBe("invalid");
  });

  test("callback updates: open mode lets a stranger's tap reach the handlers", async () => {
    const ctx = webhookDeps(resolveAccessPolicy(OPEN));
    const update = callbackUpdate(5, STRANGER_ID);
    const res = await handleWebhook(webhookRequest(update), ctx.deps);
    expect(res.status).toBe(200);
    await ctx.scheduled[0]!();
    expect(ctx.handled).toEqual([update]);
  });
});
