import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { TelegramLoginButton } from "@/components/auth/telegram-login-button";
import { Nav } from "@/components/marketing/nav";
import ExpiredPage from "@/app/auth/expired/page";
import { metadata } from "@/app/login/page";
import {
  LOGIN_ERROR_BANNERS,
  LOGIN_PAGE_BOT_LINE,
  LOGIN_PAGE_INTRO,
  loginErrorBanner,
  telegramLoginTarget,
} from "../../lib/auth/telegram-login";

const ROOT = join(import.meta.dir, "..", "..");
const FORBIDDEN_DASH = /[\u2013\u2014]/;

const SAVED_ENV = new Map(
  ["TELEGRAM_BOT_USERNAME"].map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const [key, value] of SAVED_ENV) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("TelegramLoginButton", () => {
  test("renders a mount container, not a hoisted script tag", () => {
    const html = renderToStaticMarkup(
      <TelegramLoginButton botUsername="settle_bot" authUrl="https://settle.example.com/auth/telegram" />,
    );
    // React 19 hoists server rendered <script async> into <head>, where the
    // widget renders 0x0. The HTML ships only the container; the widget script
    // is appended client side inside it (unit tested in telegram-widget.test.ts).
    // The outer wrapper centres the widget; the container clips the opaque
    // iframe to a fully rounded pill so no black corners show.
    expect(html).toContain("flex w-full justify-center");
    expect(html).toContain("mx-auto");
    expect(html).toContain("rounded-full");
    expect(html).toContain("overflow-hidden");
    expect(html).toContain("w-fit");
    expect(html).toContain("min-h-10");
    // React escapes the ampersand in server rendered attribute values.
    expect(html).toContain("[&amp;_iframe]:block");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("telegram-widget.js");
    expect(html).not.toContain("@");
    expect(html).toContain("<noscript");
    expect(html).toContain("Enable JavaScript to log in with Telegram.");
  });
});

describe("login page wiring", () => {
  test("metadata title is Log in", () => {
    expect(metadata.title).toBe("Log in");
  });

  test("page renders the widget only when https and a bot username exist", () => {
    const source = readFileSync(join(ROOT, "app", "login", "page.tsx"), "utf8");
    expect(source).toContain("Log in to Settle");
    expect(source).toContain("telegramLoginTarget(process.env.APP_BASE_URL");
    expect(source).toContain("process.env.TELEGRAM_BOT_USERNAME");
    expect(source).toContain("LOGIN_PAGE_INTRO");
    expect(source).toContain("LOGIN_PAGE_BOT_LINE");
    expect(source).toContain("loginErrorBanner(query.error)");
    expect(source).toContain('role="alert"');
    expect(source).not.toMatch(FORBIDDEN_DASH);
  });

  test("page copy is plain and free of em or en dashes", () => {
    for (const text of [
      LOGIN_PAGE_INTRO,
      LOGIN_PAGE_BOT_LINE,
      ...Object.values(LOGIN_ERROR_BANNERS),
    ]) {
      expect(FORBIDDEN_DASH.test(text), text).toBe(false);
    }
    expect(LOGIN_PAGE_INTRO).toContain("same Telegram account");
    expect(LOGIN_PAGE_BOT_LINE).toContain("Send /dashboard to the bot and I will send you a link.");
  });

  test("error banners map only the known values", () => {
    expect(loginErrorBanner("failed")).toBe("That login did not work. Please try again.");
    expect(loginErrorBanner("not_invited")).toBe("This account is not on the invite list yet.");
    expect(loginErrorBanner("unknown")).toBeNull();
    expect(loginErrorBanner(undefined)).toBeNull();
    expect(loginErrorBanner(["failed"])).toBeNull();
  });

  test("widget target comes from APP_BASE_URL and only on https", () => {
    expect(telegramLoginTarget("https://settle.example.com", "@settle_bot")).toEqual({
      botUsername: "settle_bot",
      authUrl: "https://settle.example.com/auth/telegram",
    });
    expect(telegramLoginTarget("http://localhost:3000", "settle_bot")).toBeNull();
  });
});

describe("nav gains a Log in link", () => {
  test("the marketing nav links to /login without breaking the rest", () => {
    process.env.TELEGRAM_BOT_USERNAME = "settle_bot";
    const html = renderToStaticMarkup(<Nav />);
    expect(html).toContain('href="/login"');
    expect(html).toContain("Log in");
    expect(html).toContain("Open in Telegram");
    expect(html).toContain('aria-label="Site"');
    expect(html).toContain("#how");
    expect(html).toContain("#pricing");
    expect(html).not.toMatch(FORBIDDEN_DASH);
  });

  test("Log in stays on one line at small widths", () => {
    const source = readFileSync(join(ROOT, "components", "marketing", "nav.tsx"), "utf8");
    const loginBlock = source.slice(source.indexOf('href="/login"') - 60, source.indexOf('href="/login"') + 120);
    expect(loginBlock).toContain("whitespace-nowrap");
    expect(loginBlock).not.toContain("hidden");
  });
});

describe("expired page offers the web login", () => {
  test("keeps the existing copy and adds a link to /login", () => {
    const html = renderToStaticMarkup(<ExpiredPage />);
    expect(html).toContain("That link has expired.");
    expect(html).toContain("Open Telegram, send /dashboard to your Settle bot");
    expect(html).toContain('href="/login"');
    expect(html).toContain("log in on the website");
    expect(html).not.toMatch(FORBIDDEN_DASH);
  });
});
