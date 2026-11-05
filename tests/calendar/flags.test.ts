import { describe, expect, test } from "bun:test";
import { isCalendarSyncEnabled } from "../../lib/calendar/flags";

const ALL_ON: Record<string, string> = {
  CALENDAR_SYNC_ENABLED: "true",
  GOOGLE_CLIENT_ID: "cid",
  GOOGLE_CLIENT_SECRET: "csecret",
  CALENDAR_TOKEN_KEY: "key",
  CALENDAR_CRON_SECRET: "cron",
};

describe("isCalendarSyncEnabled", () => {
  test("true only when the switch is on and all four secrets are present", () => {
    expect(isCalendarSyncEnabled(ALL_ON)).toBe(true);
  });

  test("off when the switch is missing, blank or anything but true", () => {
    for (const value of [undefined, "", "  ", "false", "yes", "1"]) {
      const envInput = { ...ALL_ON, CALENDAR_SYNC_ENABLED: value };
      expect(isCalendarSyncEnabled(envInput)).toBe(false);
    }
  });

  test("off when any one value is missing or blank", () => {
    for (const name of [
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "CALENDAR_TOKEN_KEY",
      "CALENDAR_CRON_SECRET",
    ]) {
      expect(isCalendarSyncEnabled({ ...ALL_ON, [name]: undefined })).toBe(false);
      expect(isCalendarSyncEnabled({ ...ALL_ON, [name]: "   " })).toBe(false);
    }
  });

  test("reads the real process env by default", () => {
    expect(typeof isCalendarSyncEnabled()).toBe("boolean");
  });
});
