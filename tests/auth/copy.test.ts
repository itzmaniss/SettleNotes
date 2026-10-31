import { describe, expect, test } from "bun:test";
import type { Bot } from "grammy";
import * as copy from "../../lib/auth/copy";
import { KNOWN_COMMANDS, handleTextMessage } from "../../lib/telegram/handlers";
import { registerHandlers } from "../../lib/telegram/bot";

const FORBIDDEN = /[\u2013\u2014]/;

function checkNoDashes(text: string, label: string) {
  expect(FORBIDDEN.test(text), `${label} contains an em or en dash`).toBe(false);
}

describe("auth copy", () => {
  test("no em or en dashes anywhere in the copy", () => {
    checkNoDashes(copy.dashboardLinkReply("https://x.test/auth/abc"), "dashboardLinkReply");
    checkNoDashes(copy.dashboardLinkFailureReply(), "dashboardLinkFailureReply");
    checkNoDashes(copy.EXPIRED_PAGE_TITLE, "EXPIRED_PAGE_TITLE");
    checkNoDashes(copy.EXPIRED_PAGE_BODY, "EXPIRED_PAGE_BODY");
    checkNoDashes(copy.EXPIRED_PAGE_HINT, "EXPIRED_PAGE_HINT");
  });

  test("dashboard link reply explains single use and the 15 minute expiry", () => {
    const reply = copy.dashboardLinkReply("https://x.test/auth/abc");
    expect(reply).toContain("https://x.test/auth/abc");
    expect(reply).toContain("works once");
    expect(reply).toContain("15 minutes");
  });

  test("failure reply asks for /dashboard again", () => {
    expect(copy.dashboardLinkFailureReply()).toContain("/dashboard");
  });
});

describe("/dashboard registration", () => {
  test("dashboard is a known command so the text handler leaves it alone", () => {
    expect([...KNOWN_COMMANDS].sort()).toEqual([
      "/dashboard",
      "/done",
      "/help",
      "/paysupport",
      "/pro",
      "/start",
      "/tasks",
    ]);
  });

  test("registerHandlers registers dashboard before the ingest handlers", () => {
    const calls: Array<{ kind: string; name: string }> = [];
    const fakeBot = {
      command: (name: string) => calls.push({ kind: "command", name }),
      on: (name: string) => calls.push({ kind: "on", name }),
    } as unknown as Bot;

    registerHandlers(fakeBot);

    const names = calls.map((call) => `${call.kind}:${call.name}`);
    expect(names.filter((name) => name === "command:dashboard")).toHaveLength(1);
    expect(names.indexOf("command:dashboard")).toBeLessThan(names.indexOf("on:message:text"));
    expect(names).toContain("command:start");
    expect(names).toContain("command:help");
  });

  test("a /dashboard text message reaching the text handler gets no unknown command nudge", async () => {
    // Safety net: even if the command middleware is bypassed, /dashboard must
    // never be answered as an unknown command.
    let replied = 0;
    const ctx = {
      from: { id: 101, is_bot: false, first_name: "Tim" },
      chat: { id: 101, type: "private" },
      message: { text: "/dashboard", date: 1 },
      reply: async () => {
        replied += 1;
        return {};
      },
      replyWithChatAction: async () => ({}),
      api: { getFile: async () => ({}) },
    };
    // Deps are never reached for known commands; empty fakes are enough.
    const deps = {
      upsertUser: async () => {
        throw new Error("must not be called");
      },
    } as unknown as Parameters<typeof handleTextMessage>[1];

    await handleTextMessage(ctx as never, deps);

    expect(replied).toBe(0);
  });
});
