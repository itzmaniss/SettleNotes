import { describe, expect, test } from "bun:test";
import {
  BOT_COMMAND_MENU,
  syncBotCommands,
  type BotCommandMenuEntry,
  type BotCommandsApi,
} from "../../lib/telegram/commands";

// Telegram's rules for the "/" menu: command is 1 to 32 lowercase letters,
// digits or underscores; description is 3 to 256 characters.
const COMMAND_PATTERN = /^[a-z0-9_]{1,32}$/;

function assertMenuValid(menu: BotCommandMenuEntry[]): void {
  for (const { command, description } of menu) {
    expect(command).toMatch(COMMAND_PATTERN);
    expect(description.length).toBeGreaterThanOrEqual(3);
    expect(description.length).toBeLessThanOrEqual(256);
    expect(description.includes("\u2014")).toBe(false);
    expect(description.includes("\u2013")).toBe(false);
    expect(command.includes("\u2014")).toBe(false);
    expect(command.includes("\u2013")).toBe(false);
  }
}

describe("BOT_COMMAND_MENU", () => {
  test("billing off: exactly the five free commands, in order", () => {
    expect(BOT_COMMAND_MENU({ billingEnabled: false })).toEqual([
      { command: "start", description: "Say hello and get set up" },
      { command: "tasks", description: "See what is due next" },
      { command: "done", description: "Tick off a task, for example /done 1" },
      { command: "dashboard", description: "Open your dashboard on the web" },
      { command: "help", description: "What I can do" },
    ]);
  });

  test("billing on: pro is added, and only then", () => {
    const withPro = BOT_COMMAND_MENU({ billingEnabled: true });
    expect(withPro).toHaveLength(6);
    expect(withPro[withPro.length - 1]).toEqual({ command: "pro", description: "See the Pro plan" });
    expect(withPro.slice(0, 5)).toEqual(BOT_COMMAND_MENU({ billingEnabled: false }));
  });

  test("every entry in both variants is valid under Telegram's rules", () => {
    for (const billingEnabled of [false, true]) {
      assertMenuValid(BOT_COMMAND_MENU({ billingEnabled }));
    }
  });
});

describe("syncBotCommands", () => {
  type ApiCall =
    | { kind: "commands"; commands: BotCommandMenuEntry[] }
    | { kind: "menu"; menuButton: { type: string } };

  function fakeApi(fail?: (call: ApiCall) => void): { api: BotCommandsApi; calls: ApiCall[] } {
    const calls: ApiCall[] = [];
    return {
      calls,
      api: {
        setMyCommands: async (commands) => {
          const call: ApiCall = { kind: "commands", commands };
          calls.push(call);
          fail?.(call);
          return true;
        },
        setChatMenuButton: async (other) => {
          const call: ApiCall = { kind: "menu", menuButton: other.menu_button };
          calls.push(call);
          fail?.(call);
          return true;
        },
      },
    };
  }

  test("sends the exact menu and switches the menu button to commands", async () => {
    for (const billingEnabled of [false, true]) {
      const { api, calls } = fakeApi();
      await syncBotCommands(api, { billingEnabled });
      expect(calls).toEqual([
        { kind: "commands", commands: BOT_COMMAND_MENU({ billingEnabled }) },
        { kind: "menu", menuButton: { type: "commands" } },
      ]);
    }
  });

  test("a failing Telegram call never throws out of the sync", async () => {
    const { api } = fakeApi(() => {
      throw new Error("telegram is down");
    });
    await expect(syncBotCommands(api, { billingEnabled: true })).resolves.toBeUndefined();
  });
});
