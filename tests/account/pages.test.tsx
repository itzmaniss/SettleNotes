import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

// The dashboard nav is a client component whose only render dependency is
// usePathname (same trick as tests/brand/placement.test.tsx), pinned here to
// /account so the active state on the new pill is visible.
mock.module("next/navigation", () => ({
  usePathname: () => "/account",
  redirect: (url: string) => {
    throw new Error(`redirect to ${url}`);
  },
}));

const FORBIDDEN_DASH = /[\u2013\u2014]/;
const ORIGIN = new URL("https://settlenotes.com");

const SAVED_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME;

describe("DashboardNav", () => {
  test("the Account pill sits in the same row with the same tap height", async () => {
    const { DashboardNav } = await import("../../components/dashboard/nav");
    const html = renderToStaticMarkup(<DashboardNav todayLabel="Sat, Nov 28" />);
    expect(html).toContain('href="/account"');
    expect(html).toContain("Account");
    expect(html).toContain('aria-current="page"');
    // The existing pills stay untouched.
    expect(html).toContain("Tasks");
    expect(html).toContain("Study");
    expect(html).toContain("Weak spots");
    expect(html).toContain('aria-label="Dashboard"');
    // Every pill keeps the 44px tap height and refuses to wrap at 390px.
    expect(html).toContain("min-h-[44px]");
    expect(html).toContain("whitespace-nowrap");
    expect(html).not.toMatch(FORBIDDEN_DASH);
  });

  test("the brand block keeps its mark and its 44px link", async () => {
    const { DashboardNav } = await import("../../components/dashboard/nav");
    const html = renderToStaticMarkup(<DashboardNav todayLabel="Sat, Nov 28" />);
    const brand = html.match(/<a[^>]*href="\/dashboard"[^>]*>[\s\S]*?<\/a>/);
    expect(brand).not.toBeNull();
    expect(brand![0]).toContain("<svg");
    expect(brand![0]).toContain('aria-label="settle"');
    expect(brand![0]).toContain("min-h-[44px]");
  });

  test("the nav stays within a 390px row: the mobile width budget holds", async () => {
    // Reasoned budget at 390px: container px-4 leaves 358px, chrome (borders
    // and padding of the pill bar) leaves 326px. The mark only brand link is
    // 24px, the gap 8px, the four pills at px-2 with 14px text are at most
    // 56 + 54 + 94 + 68 plus 12px of gaps, which totals about 316px. The
    // source pins the two rules that keep that true.
    const source = readFileSync(new URL("../../components/dashboard/nav.tsx", import.meta.url), "utf8");
    // The wordmark only shows from sm up, freeing the row on phones.
    expect(source).toContain('hidden sm:inline');
    // The pills stay compact on mobile and get roomier from sm up.
    expect(source).toContain("px-2 py-1 sm:px-3");
  });
});

describe("AccountDeletedPage", () => {
  test("it is a utility page: noindex and outside every sitemap", async () => {
    process.env.TELEGRAM_BOT_USERNAME = "@settlebot";
    try {
      const page = await import("../../app/account-deleted/page");
      expect(page.metadata.robots).toEqual({ index: false, follow: false });

      const { buildSitemap } = await import("../../lib/seo/sitemap");
      const sitemap = buildSitemap(ORIGIN, [
        { path: "/terms", markers: [] },
        { path: "/privacy", markers: [] },
      ]);
      expect(sitemap.map((entry) => entry.url).join(" ")).not.toContain("account");

      // And the sitemap builder has no path that could ever add it.
      const builder = readFileSync(new URL("../../lib/seo/sitemap.ts", import.meta.url), "utf8");
      expect(builder.includes("account")).toBe(false);
    } finally {
      if (SAVED_BOT_USERNAME === undefined) delete process.env.TELEGRAM_BOT_USERNAME;
      else process.env.TELEGRAM_BOT_USERNAME = SAVED_BOT_USERNAME;
    }
  });

  test("the page renders the title, the plain paragraph and the bot link", async () => {
    process.env.TELEGRAM_BOT_USERNAME = "@settlebot";
    try {
      const page = await import("../../app/account-deleted/page");
      const html = renderToStaticMarkup(<page.default />);
      expect((html.match(/<h1/g) ?? [])).toHaveLength(1);
      expect(html).toContain("Your account is deleted");
      expect(html).toContain("kept for 5 years for accounting");
      expect(html).toContain("Stripe keeps its own records");
      expect(html).toContain("sending /start to the bot");
      expect(html).toContain('href="https://t.me/settlebot"');
      expect(html).not.toMatch(FORBIDDEN_DASH);
    } finally {
      if (SAVED_BOT_USERNAME === undefined) delete process.env.TELEGRAM_BOT_USERNAME;
      else process.env.TELEGRAM_BOT_USERNAME = SAVED_BOT_USERNAME;
    }
  });

  test("with no bot username configured the button degrades instead of linking nowhere", async () => {
    const saved = process.env.TELEGRAM_BOT_USERNAME;
    delete process.env.TELEGRAM_BOT_USERNAME;
    try {
      const page = await import("../../app/account-deleted/page");
      const html = renderToStaticMarkup(<page.default />);
      expect(html).toContain("Bot link coming soon");
    } finally {
      if (saved !== undefined) process.env.TELEGRAM_BOT_USERNAME = saved;
    }
  });
});
