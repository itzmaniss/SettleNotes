import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { buildAccountPageView, statusBanner } from "../../lib/account/view";
import { AccountPanel } from "../../components/account/account-panel";
import {
  ACCOUNT_DELETE_BUTTON_LABEL,
  ACCOUNT_DELETE_CHECKBOX_LABEL,
  ACCOUNT_DELETE_HEADING,
  ACCOUNT_DELETE_WORD_LABEL,
  ACCOUNT_DOWNLOAD_BUTTON_LABEL,
  ACCOUNT_LOGOUT_NOTE,
  ACCOUNT_NAME_FALLBACK,
  ACCOUNT_PLAN_LABEL,
  ACCOUNT_PRIVACY_LINK_LABEL,
  ACCOUNT_TITLE,
  BOX_NEEDED_BANNER,
  CANCEL_FIRST_OTHER_BANNER,
  CANCEL_FIRST_STARS_BANNER,
  CANCEL_FIRST_STRIPE_BANNER,
  CANCEL_FIRST_STRIPE_LINK_LABEL,
  DELETE_FAILED_BANNER,
  LOG_OUT_BUTTON_LABEL,
  WORD_NEEDED_BANNER,
} from "../../lib/account/web-copy";

const FORBIDDEN_DASH = /[\u2013\u2014]/;

function view(
  overrides: Partial<Parameters<typeof buildAccountPageView>[0]> = {},
) {
  return buildAccountPageView({
    firstName: "Wei",
    planName: "Free",
    status: undefined,
    cancelKind: undefined,
    ...overrides,
  });
}

function render(
  overrides: Partial<Parameters<typeof buildAccountPageView>[0]> = {},
): string {
  return renderToStaticMarkup(
    <AccountPanel view={view(overrides)} logOut={() => {}} deleteAccount={() => {}} />,
  );
}

describe("buildAccountPageView", () => {
  test("carries the first name and plan through", () => {
    expect(view().firstName).toBe("Wei");
    expect(view().planName).toBe("Free");
    // A blank first name is the same as none: the fallback text shows.
    expect(view({ firstName: "  " }).firstName).toBeNull();
  });

  test("no status means no banner; unknown statuses stay quiet", () => {
    expect(view().banner).toBeNull();
    expect(statusBanner(undefined, undefined)).toBeNull();
    expect(statusBanner("", undefined)).toBeNull();
    expect(statusBanner("hacked=1", undefined)).toBeNull();
  });

  test("cancel_first picks the wording by subscription kind", () => {
    const stripe = statusBanner("cancel_first", "stripe");
    expect(stripe?.message).toBe(CANCEL_FIRST_STRIPE_BANNER);
    expect(stripe?.linkHref).toBe("/billing");
    expect(stripe?.linkLabel).toBe(CANCEL_FIRST_STRIPE_LINK_LABEL);

    const stars = statusBanner("cancel_first", "stars");
    expect(stars?.message).toBe(CANCEL_FIRST_STARS_BANNER);
    expect(stars?.linkHref).toBeNull();

    const other = statusBanner("cancel_first", "paynow");
    expect(other?.message).toBe(CANCEL_FIRST_OTHER_BANNER);
    // A missing kind still gets the generic, calm line.
    expect(statusBanner("cancel_first", undefined)?.message).toBe(CANCEL_FIRST_OTHER_BANNER);
  });

  test("the confirm and failure banners carry their exact copy", () => {
    expect(statusBanner("word_needed", undefined)?.message).toBe(WORD_NEEDED_BANNER);
    expect(statusBanner("box_needed", undefined)?.message).toBe(BOX_NEEDED_BANNER);
    expect(statusBanner("delete_failed", undefined)?.message).toBe(DELETE_FAILED_BANNER);
  });
});

describe("AccountPanel", () => {
  test("renders exactly one h1, the account title", () => {
    const html = render();
    expect((html.match(/<h1/g) ?? [])).toHaveLength(1);
    expect(html).toContain(ACCOUNT_TITLE);
    expect(html).toContain("Wei");
  });

  test("without a first name the Telegram fallback line shows instead", () => {
    expect(render({ firstName: null })).toContain(ACCOUNT_NAME_FALLBACK);
  });

  test("the plan line uses the view model plan name", () => {
    const html = render({ planName: "Pro" });
    expect(html).toContain(`${ACCOUNT_PLAN_LABEL}: Pro`);
  });

  test("the Log out control is a form button, with the browser note under it", () => {
    const html = render();
    expect(html).toContain("Log out");
    expect(html).toContain(LOG_OUT_BUTTON_LABEL);
    expect(html).toContain(ACCOUNT_LOGOUT_NOTE);
    // One form for logout, one for deletion: the download is a plain link.
    expect((html.match(/<form/g) ?? [])).toHaveLength(2);
    expect(html).toContain('href="/account/export"');
  });

  test("the download section links to the export route", () => {
    const html = render();
    expect(html).toContain(ACCOUNT_DOWNLOAD_BUTTON_LABEL);
    expect(html).toContain('href="/account/export"');
  });

  test("the delete form demands the word and the tick", () => {
    const html = render();
    expect(html).toContain(ACCOUNT_DELETE_HEADING);
    expect(html).toContain(ACCOUNT_DELETE_WORD_LABEL);
    expect(html).toContain('name="confirm_word"');
    expect(html).toContain('placeholder="DELETE"');
    expect(html).toContain('name="confirm_box"');
    expect(html).toContain('value="on"');
    expect(html).toContain("required");
    expect(html).toContain(ACCOUNT_DELETE_CHECKBOX_LABEL);
    expect(html).toContain(ACCOUNT_DELETE_BUTTON_LABEL);
    // The checkbox and its text share one 44px label, like the billing gate.
    const labelStart = html.indexOf('name="confirm_box"');
    expect(labelStart).toBeGreaterThan(-1);
    expect(html.slice(html.lastIndexOf("<label", labelStart), labelStart)).toContain("min-h-[44px]");
    // The word input is also a 44px tap target.
    const wordInput = html.indexOf('name="confirm_word"');
    expect(html.slice(html.lastIndexOf("<input", wordInput), wordInput)).toContain("min-h-[44px]");
  });

  test("the banner statuses render as calm chunks with their links", () => {
    const stripe = render({ status: "cancel_first", cancelKind: "stripe" });
    expect(stripe).toContain(CANCEL_FIRST_STRIPE_BANNER);
    expect(stripe).toContain('href="/billing"');
    expect(stripe).toContain(CANCEL_FIRST_STRIPE_LINK_LABEL);

    expect(render({ status: "cancel_first", cancelKind: "stars" })).toContain(
      CANCEL_FIRST_STARS_BANNER,
    );
    expect(render({ status: "delete_failed" })).toContain(DELETE_FAILED_BANNER);
    expect(render({ status: "word_needed" })).toContain(WORD_NEEDED_BANNER);
    expect(render({ status: "box_needed" })).toContain(BOX_NEEDED_BANNER);
  });

  test("links to the Privacy Notice", () => {
    const html = render();
    expect(html).toContain('href="/privacy"');
    expect(html).toContain(ACCOUNT_PRIVACY_LINK_LABEL);
  });

  test("no em or en dashes in the markup, no raw button JSX in the source", () => {
    expect(render()).not.toMatch(FORBIDDEN_DASH);
    const panel = readFileSync(
      new URL("../../components/account/account-panel.tsx", import.meta.url),
      "utf8",
    );
    expect(panel).not.toMatch(/<button/);
    expect(panel).not.toMatch(FORBIDDEN_DASH);
  });
});
