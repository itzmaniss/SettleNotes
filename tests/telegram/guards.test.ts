import { describe, expect, test } from "bun:test";
import {
  chatIdOf,
  isAllowedUser,
  resolveWebhookUrl,
  senderIdOf,
  verifySecret,
} from "../../lib/telegram/guards";
import {
  ALLOWED_ID,
  STRANGER_ID,
  callbackUpdate,
  channelPostUpdate,
  textUpdate,
} from "./fixtures";

describe("verifySecret", () => {
  test("accepts a matching secret", () => {
    expect(verifySecret("secret-token", "secret-token")).toBe(true);
  });

  test("rejects a wrong secret", () => {
    expect(verifySecret("wrong-token", "secret-token")).toBe(false);
  });

  test("rejects without throwing when lengths differ", () => {
    expect(verifySecret("short", "a-much-longer-secret")).toBe(false);
    expect(verifySecret("a-much-longer-secret", "short")).toBe(false);
  });

  test("rejects a missing header", () => {
    expect(verifySecret(null, "secret-token")).toBe(false);
  });

  test("rejects an empty expected secret", () => {
    expect(verifySecret("anything", "")).toBe(false);
  });
});

describe("isAllowedUser", () => {
  test("accepts an allowlisted id", () => {
    expect(isAllowedUser(ALLOWED_ID, [ALLOWED_ID])).toBe(true);
  });

  test("rejects an unknown id", () => {
    expect(isAllowedUser(STRANGER_ID, [ALLOWED_ID])).toBe(false);
  });

  test("rejects an absent sender", () => {
    expect(isAllowedUser(undefined, [ALLOWED_ID])).toBe(false);
  });
});

describe("senderIdOf and chatIdOf", () => {
  test("reads message.from.id and message.chat.id", () => {
    const update = textUpdate(1, ALLOWED_ID, 555);
    expect(senderIdOf(update)).toBe(ALLOWED_ID);
    expect(chatIdOf(update)).toBe(555);
  });

  test("reads callback_query.from.id and its message chat", () => {
    const update = callbackUpdate(2, 777);
    expect(senderIdOf(update)).toBe(777);
    expect(chatIdOf(update)).toBe(777);
  });

  test("returns undefined for a channel post", () => {
    const update = channelPostUpdate(3);
    expect(senderIdOf(update)).toBeUndefined();
    expect(chatIdOf(update)).toBeUndefined();
  });
});

describe("resolveWebhookUrl", () => {
  test("accepts a public https host and appends the route", () => {
    expect(resolveWebhookUrl("https://x.vercel.app")).toBe(
      "https://x.vercel.app/api/telegram",
    );
  });

  test("keeps an existing base path and drops the trailing slash", () => {
    expect(resolveWebhookUrl("https://x.vercel.app/app/")).toBe(
      "https://x.vercel.app/app/api/telegram",
    );
  });

  test("rejects http URLs", () => {
    expect(() => resolveWebhookUrl("http://example.com")).toThrow(/https/);
  });

  test("rejects localhost even over https", () => {
    expect(() => resolveWebhookUrl("https://localhost:3000")).toThrow(
      /localhost/,
    );
  });

  test("rejects http://localhost:3000", () => {
    expect(() => resolveWebhookUrl("http://localhost:3000")).toThrow();
  });

  test("rejects loopback IPs", () => {
    expect(() => resolveWebhookUrl("http://127.0.0.1:3000")).toThrow();
    expect(() => resolveWebhookUrl("https://[::1]:3000")).toThrow();
  });

  test("rejects a value that is not a URL", () => {
    expect(() => resolveWebhookUrl("not a url")).toThrow(/not a valid URL/);
  });
});
