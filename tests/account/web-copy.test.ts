import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as copy from "../../lib/account/web-copy";

// Every new student facing string: plain second person, no engineer words,
// no emoji, no exclamation marks, no em or en dashes.

const FORBIDDEN_DASH = /[\u2013\u2014]/;

function exportedStrings(): string[] {
  return Object.values(copy).filter((value): boolean => typeof value === "string") as string[];
}

describe("account copy leaf", () => {
  test("the leaf module imports nothing, so client components stay clean", () => {
    const source = readFileSync(new URL("../../lib/account/web-copy.ts", import.meta.url), "utf8");
    expect(source.match(/^import /m)).toBeNull();
    expect(source.match(/^export .* from /m)).toBeNull();
  });

  test("no string carries an em or en dash", () => {
    for (const text of exportedStrings()) {
      expect([text, FORBIDDEN_DASH.test(text)]).toEqual([text, false]);
    }
  });

  test("no string shouts: no exclamation marks, no emoji", () => {
    for (const text of exportedStrings()) {
      expect(text.includes("!")).toBe(false);
      expect(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u.test(text)).toBe(false);
    }
  });

  test("the wording the flow depends on is pinned exactly", () => {
    expect(copy.ACCOUNT_TITLE).toBe("Your account");
    expect(copy.LOG_OUT_BUTTON_LABEL).toBe("Log out");
    expect(copy.ACCOUNT_DELETE_CHECKBOX_LABEL).toBe("I understand this cannot be undone");
    expect(copy.DELETED_PAGE_TITLE).toBe("Your account is deleted");
    expect(copy.CANCEL_FIRST_STRIPE_BANNER).toBe(
      "Cancel your Pro plan on the Billing page first (Manage plan), then come back here so you are not charged again.",
    );
    expect(copy.DELETE_FAILED_BANNER).toBe(
      "We could not delete everything just now. Nothing has been lost. Please try again in a minute or email us.",
    );
    // The privacy notice is the source of truth for the 5 years retention.
    expect(copy.DELETED_PAGE_BODY).toContain("kept for 5 years for accounting");
    expect(copy.DELETED_PAGE_BODY).toContain("sending /start to the bot");
  });

  test("the log out note says plainly that only this browser is cleared", () => {
    expect(copy.ACCOUNT_LOGOUT_NOTE).toContain("this browser");
    expect(copy.ACCOUNT_LOGOUT_NOTE).toContain("only");
  });

  test("the download and delete buttons exist with plain labels", () => {
    expect(copy.ACCOUNT_DOWNLOAD_BUTTON_LABEL).toBe("Download your data");
    expect(copy.ACCOUNT_DELETE_BUTTON_LABEL).toBe("Delete my account");
    expect(copy.ACCOUNT_DELETE_WORD_PLACEHOLDER).toBe("DELETE");
    expect(copy.EXPORT_RATE_LIMIT_LINE).toContain("Wait ten minutes");
  });
});
