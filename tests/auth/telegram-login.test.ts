import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import {
  buildDataCheckString,
  completeTelegramLogin,
  safeNextPath,
  telegramLoginTarget,
  verifyTelegramLogin,
  type TelegramLoginDeps,
} from "../../lib/auth/telegram-login";

const BOT_TOKEN = "123456:TestTokenForVectorDoNotUse";
const OTHER_TOKEN = "123456:AnotherTokenEntirely";
const AUTH_DATE = 1760000000;
const NOW = new Date(AUTH_DATE * 1000);

// Pinned independently computed vectors (sha256 of token, hmac over the
// documented data check string). If the implementation drifts from Telegram's
// documented algorithm, these literals catch it.
const PINNED_MINIMAL_HASH =
  "62e508431f068f20395d988a09927d9dbd200c20ba3e4f362830eb7e42a4db59";
const PINNED_FULL_HASH =
  "8845149813dd7f6f3fdfeea7ddcde97ce16bce811b1162854187ad3bfa34afaf";

function sign(fields: Record<string, string>, botToken = BOT_TOKEN): string {
  const secret = createHash("sha256").update(botToken, "utf8").digest();
  return createHmac("sha256", secret)
    .update(buildDataCheckString(fields), "utf8")
    .digest("hex");
}

function widgetParams(
  fields: Record<string, string>,
  botToken = BOT_TOKEN,
): Record<string, string> {
  return { ...fields, hash: sign(fields, botToken) };
}

const MINIMAL_FIELDS = { id: "900000001", first_name: "Wei", auth_date: String(AUTH_DATE) };

const FULL_FIELDS = {
  id: "900000002",
  first_name: "Wei",
  last_name: "Tan",
  username: "weitan",
  photo_url: "https://t.me/i.png",
  auth_date: String(AUTH_DATE),
};

type Deps = Parameters<typeof completeTelegramLogin>[1];

type FakeDeps = {
  deps: TelegramLoginDeps;
  upsertCalls: Array<{ telegramUserId: number; telegramChatId: number; firstName: string | null }>;
  sessionCalls: string[];
  lookupCalls: number[];
};

function makeDeps(overrides: Partial<Deps> = {}, existing: { id: string; telegramChatId: number } | null = null): FakeDeps {
  const upsertCalls: FakeDeps["upsertCalls"] = [];
  const sessionCalls: string[] = [];
  const lookupCalls: number[] = [];
  return {
    upsertCalls,
    sessionCalls,
    lookupCalls,
    deps: {
      botToken: BOT_TOKEN,
      allowedIds: [900000001, 900000002],
      getUserByTelegramId: async (telegramUserId) => {
        lookupCalls.push(telegramUserId);
        return existing;
      },
      upsertUser: async (input) => {
        upsertCalls.push(input);
        return { id: existing ? existing.id : "new-user-row" };
      },
      createSession: async (userId) => {
        sessionCalls.push(userId);
        return `jwt-for-${userId}`;
      },
      now: NOW,
      ...overrides,
    },
  };
}

function omitField(fields: Record<string, string>, key: string): Record<string, string> {
  const rest = { ...fields };
  delete rest[key];
  return rest;
}

describe("verifyTelegramLogin", () => {
  test("pinned vector: minimal fields verify and return the numeric id", () => {
    const result = verifyTelegramLogin(widgetParams(MINIMAL_FIELDS), BOT_TOKEN, NOW);
    expect(result).toEqual({ ok: true, user: { id: 900000001, firstName: "Wei" } });
    // The signature really is the pinned literal, not just self consistent.
    expect(sign(MINIMAL_FIELDS)).toBe(PINNED_MINIMAL_HASH);
  });

  test("pinned vector: every optional field present verifies", () => {
    const result = verifyTelegramLogin(widgetParams(FULL_FIELDS), BOT_TOKEN, NOW);
    expect(result).toEqual({ ok: true, user: { id: 900000002, firstName: "Wei" } });
    expect(sign(FULL_FIELDS)).toBe(PINNED_FULL_HASH);
  });

  test("data check string sorts alphabetically, omits hash, handles absent and present optional fields", () => {
    expect(buildDataCheckString({ hash: "x", ...MINIMAL_FIELDS })).toBe(
      `auth_date=${AUTH_DATE}\nfirst_name=Wei\nid=900000001`,
    );
    expect(buildDataCheckString({ hash: "x", ...FULL_FIELDS })).toBe(
      `auth_date=${AUTH_DATE}\nfirst_name=Wei\nid=900000002\nlast_name=Tan\nphoto_url=https://t.me/i.png\nusername=weitan`,
    );
  });

  test("missing first_name verifies with a null name", () => {
    const fields = { id: "900000001", auth_date: String(AUTH_DATE) };
    const result = verifyTelegramLogin(widgetParams(fields), BOT_TOKEN, NOW);
    expect(result).toEqual({ ok: true, user: { id: 900000001, firstName: null } });
  });

  test("a tampered field fails the hash", () => {
    const params = widgetParams(MINIMAL_FIELDS);
    const result = verifyTelegramLogin(
      { ...params, first_name: "Mallory" },
      BOT_TOKEN,
      NOW,
    );
    expect(result).toEqual({ ok: false, reason: "bad_hash" });
  });

  test("a different bot token fails the hash", () => {
    const result = verifyTelegramLogin(widgetParams(MINIMAL_FIELDS), OTHER_TOKEN, NOW);
    expect(result).toEqual({ ok: false, reason: "bad_hash" });
  });

  test("missing hash is malformed", () => {
    expect(verifyTelegramLogin(omitField(widgetParams(MINIMAL_FIELDS), "hash"), BOT_TOKEN, NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  test("uppercase hex hash is malformed", () => {
    const params = widgetParams(MINIMAL_FIELDS);
    const result = verifyTelegramLogin({ ...params, hash: params.hash.toUpperCase() }, BOT_TOKEN, NOW);
    expect(result).toEqual({ ok: false, reason: "malformed" });
  });

  test("non hex hash is malformed", () => {
    const params = widgetParams(MINIMAL_FIELDS);
    expect(verifyTelegramLogin({ ...params, hash: "g".repeat(64) }, BOT_TOKEN, NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  test("wrong length hash is malformed", () => {
    const params = widgetParams(MINIMAL_FIELDS);
    expect(verifyTelegramLogin({ ...params, hash: "a".repeat(63) }, BOT_TOKEN, NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  test("a repeated param is malformed", () => {
    const params = widgetParams(MINIMAL_FIELDS);
    expect(verifyTelegramLogin({ ...params, id: ["900000001", "900000001"] }, BOT_TOKEN, NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  test("auth_date older than 5 minutes is expired, exactly 5 minutes is fine", () => {
    const fields = { ...MINIMAL_FIELDS };
    const stale = verifyTelegramLogin(widgetParams({ ...fields, auth_date: String(AUTH_DATE - 301) }), BOT_TOKEN, NOW);
    expect(stale).toEqual({ ok: false, reason: "expired" });
    const edge = verifyTelegramLogin(widgetParams({ ...fields, auth_date: String(AUTH_DATE - 300) }), BOT_TOKEN, NOW);
    expect(edge).toEqual({ ok: true, user: { id: 900000001, firstName: "Wei" } });
  });

  test("auth_date more than 1 minute in the future is expired, exactly 1 minute is fine", () => {
    const fields = { ...MINIMAL_FIELDS };
    const future = verifyTelegramLogin(widgetParams({ ...fields, auth_date: String(AUTH_DATE + 61) }), BOT_TOKEN, NOW);
    expect(future).toEqual({ ok: false, reason: "expired" });
    const edge = verifyTelegramLogin(widgetParams({ ...fields, auth_date: String(AUTH_DATE + 60) }), BOT_TOKEN, NOW);
    expect(edge).toEqual({ ok: true, user: { id: 900000001, firstName: "Wei" } });
  });

  test("an unknown extra field is malformed even when signed", () => {
    const fields = { ...MINIMAL_FIELDS, session_token: "extra" };
    expect(verifyTelegramLogin(widgetParams(fields), BOT_TOKEN, NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  test("id must be a positive safe integer", () => {
    for (const bad of ["900000001.5", "-5", "0", "abc", "", "99999999999999999999"]) {
      const fields = { ...MINIMAL_FIELDS, id: bad };
      expect(verifyTelegramLogin(widgetParams(fields), BOT_TOKEN, NOW), `id ${JSON.stringify(bad)}`).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  test("non numeric auth_date is malformed", () => {
    const fields = { ...MINIMAL_FIELDS, auth_date: "yesterday" };
    expect(verifyTelegramLogin(widgetParams(fields), BOT_TOKEN, NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  test("missing auth_date is malformed", () => {
    expect(verifyTelegramLogin(omitField(widgetParams(MINIMAL_FIELDS), "auth_date"), BOT_TOKEN, NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  test("failures never echo the token or the hash", () => {
    const params = widgetParams(MINIMAL_FIELDS);
    const mutatedList: Array<Record<string, string>> = [
      { ...params, first_name: "Mallory" },
      { ...params, hash: "g".repeat(64) },
      { ...params, auth_date: "0" },
    ];
    for (const mutated of mutatedList) {
      const result = verifyTelegramLogin(mutated, BOT_TOKEN, NOW);
      expect(result.ok).toBe(false);
      const encoded = JSON.stringify(result);
      expect(encoded).not.toContain(BOT_TOKEN);
      expect(encoded).not.toContain(mutated.hash);
    }
  });
});

describe("completeTelegramLogin", () => {
  test("allowlisted new user: upsert with chat id = telegram id, session created", async () => {
    const ctx = makeDeps();
    const outcome = await completeTelegramLogin(ctx.deps, widgetParams(MINIMAL_FIELDS));

    expect(outcome).toEqual({ kind: "ok", userId: "new-user-row", sessionToken: "jwt-for-new-user-row" });
    expect(ctx.lookupCalls).toEqual([900000001]);
    expect(ctx.upsertCalls).toEqual([
      { telegramUserId: 900000001, telegramChatId: 900000001, firstName: "Wei" },
    ]);
    expect(ctx.sessionCalls).toEqual(["new-user-row"]);
  });

  test("existing user: first name refreshed, chat id untouched", async () => {
    const ctx = makeDeps({}, { id: "user-1", telegramChatId: 555000 });
    const outcome = await completeTelegramLogin(ctx.deps, widgetParams(MINIMAL_FIELDS));

    expect(outcome).toEqual({ kind: "ok", userId: "user-1", sessionToken: "jwt-for-user-1" });
    expect(ctx.upsertCalls).toEqual([
      { telegramUserId: 900000001, telegramChatId: 555000, firstName: "Wei" },
    ]);
  });

  test("stranger is denied and nothing is written or looked up", async () => {
    const ctx = makeDeps({}, { id: "user-1", telegramChatId: 555000 });
    ctx.deps.allowedIds = [111111111];

    const outcome = await completeTelegramLogin(ctx.deps, widgetParams(FULL_FIELDS));

    expect(outcome).toEqual({ kind: "denied" });
    expect(ctx.lookupCalls).toEqual([]);
    expect(ctx.upsertCalls).toEqual([]);
    expect(ctx.sessionCalls).toEqual([]);
  });

  test("an empty allowlist admits nobody", async () => {
    const ctx = makeDeps();
    ctx.deps.allowedIds = [];

    const outcome = await completeTelegramLogin(ctx.deps, widgetParams(MINIMAL_FIELDS));

    expect(outcome).toEqual({ kind: "denied" });
    expect(ctx.upsertCalls).toEqual([]);
  });

  test("a matching username never grants access, only the numeric id does", async () => {
    const ctx = makeDeps();
    // The allowed user is 900000002 (username weitan); the visitor reuses that
    // username from a stranger id. Identity is the id alone, so denied.
    ctx.deps.allowedIds = [900000002];
    const stranger = {
      id: "999999999",
      first_name: "Wei",
      username: "weitan",
      auth_date: String(AUTH_DATE),
    };

    const outcome = await completeTelegramLogin(ctx.deps, widgetParams(stranger));

    expect(outcome).toEqual({ kind: "denied" });
    expect(ctx.upsertCalls).toEqual([]);
  });

  test("invalid params never touch the database", async () => {
    const ctx = makeDeps();
    const params = widgetParams(MINIMAL_FIELDS);

    for (const mutated of [
      { ...params, first_name: "Mallory" },
      { ...params, hash: "g".repeat(64) },
      { ...params, auth_date: String(AUTH_DATE - 100000) },
      { id: ["1", "1"] },
    ]) {
      const outcome = await completeTelegramLogin(ctx.deps, mutated);
      expect(outcome).toEqual({ kind: "invalid" });
    }

    expect(ctx.lookupCalls).toEqual([]);
    expect(ctx.upsertCalls).toEqual([]);
    expect(ctx.sessionCalls).toEqual([]);
  });
});

describe("safeNextPath", () => {
  test("keeps allowed same-site paths", () => {
    expect(safeNextPath("/dashboard")).toBe("/dashboard");
    expect(safeNextPath("/tasks")).toBe("/tasks");
    expect(safeNextPath("/tasks/12")).toBe("/tasks/12");
    expect(safeNextPath("/weak-spots")).toBe("/weak-spots");
    expect(safeNextPath("/billing")).toBe("/billing");
  });

  test("open redirect attempts fall back to the dashboard", () => {
    for (const evil of [
      "//evil.com",
      "https://evil.com",
      "/\\evil",
      "/dashboard/../x",
      "/%2e%2e/secret",
      "/login",
      "tasks",
      "",
      null,
      undefined,
      " /dashboard",
      "/dashboard?next=//evil.com",
      "/not-allowed/path",
    ]) {
      expect(safeNextPath(evil), `next ${JSON.stringify(evil)}`).toBe("/dashboard");
    }
  });
});

describe("telegramLoginTarget", () => {
  test("builds the widget target from an https base and strips the @", () => {
    expect(telegramLoginTarget("https://settle.example.com/", "@settle_bot")).toEqual({
      botUsername: "settle_bot",
      authUrl: "https://settle.example.com/auth/telegram",
    });
  });

  test("http, missing username and invalid urls get the fallback", () => {
    expect(telegramLoginTarget("http://localhost:3000", "settle_bot")).toBeNull();
    expect(telegramLoginTarget("https://settle.example.com", undefined)).toBeNull();
    expect(telegramLoginTarget("https://settle.example.com", "")).toBeNull();
    expect(telegramLoginTarget("https://settle.example.com", "  @  ")).toBeNull();
    expect(telegramLoginTarget("not a url", "settle_bot")).toBeNull();
    expect(telegramLoginTarget(undefined, "settle_bot")).toBeNull();
  });
});
