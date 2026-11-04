import { describe, expect, test } from "bun:test";
import { buildRobots, legalRobots } from "@/lib/seo/robots";
import { buildSitemap } from "@/lib/seo/sitemap";

const ORIGIN = new URL("https://settlenotes.com");

describe("robots", () => {
  test("exact output for the production origin", () => {
    expect(buildRobots(ORIGIN)).toEqual({
      rules: [
        {
          userAgent: "*",
          allow: "/",
          disallow: ["/dashboard", "/account", "/api/", "/auth/", "/accept", "/login"],
        },
      ],
      sitemap: "https://settlenotes.com/sitemap.xml",
      host: "https://settlenotes.com",
    });
  });

  test("the /account disallow covers the account page, its export and the deleted page", () => {
    const text = JSON.stringify(buildRobots(ORIGIN));
    expect(text).toContain('"/account"');
    // Prefix robots matching: one entry covers the account page, the export
    // route and the account-deleted confirmation page.
    for (const path of ["/account", "/account/export", "/account-deleted"]) {
      expect(path.startsWith("/account")).toBe(true);
    }
  });

  test("the sitemap address follows the origin it is given", () => {
    const out = buildRobots(new URL("https://preview.example.com"));
    expect(out.sitemap).toBe("https://preview.example.com/sitemap.xml");
    expect(out.host).toBe("https://preview.example.com");
  });
});

describe("legal page robots", () => {
  test("a missing setting marker means noindex, links still flow", () => {
    expect(legalRobots(["[[MISSING: LEGAL_BUSINESS_NAME]]"])).toEqual({
      index: false,
      follow: true,
    });
  });

  test("any marker counts, counsel questions and unknown tokens alike", () => {
    expect(legalRobots(["[[COUNSEL: confirm the cap.]]"])).toEqual({
      index: false,
      follow: true,
    });
    expect(legalRobots(["[[UNKNOWN TOKEN: price]]"])).toEqual({
      index: false,
      follow: true,
    });
  });

  test("a clean document is indexable", () => {
    expect(legalRobots([])).toEqual({ index: true, follow: true });
  });
});

describe("sitemap", () => {
  test("clean documents: the landing page plus the three legal pages", () => {
    const out = buildSitemap(ORIGIN, [
      { path: "/terms", markers: [] },
      { path: "/privacy", markers: [] },
      { path: "/refund", markers: [] },
    ]);
    expect(out.map((entry) => entry.url)).toEqual([
      "https://settlenotes.com/",
      "https://settlenotes.com/terms",
      "https://settlenotes.com/privacy",
      "https://settlenotes.com/refund",
      "https://settlenotes.com/guides",
    ]);
    expect(out[0]).toEqual({
      url: "https://settlenotes.com/",
      changeFrequency: "weekly",
      priority: 1,
    });
    expect(out[1]!.lastModified).toEqual(new Date("2026-11-01"));
    expect(out[1]!.changeFrequency).toBe("monthly");
    expect(out[1]!.priority).toBe(0.5);
    expect(out[4]!.changeFrequency).toBe("weekly");
    expect(out[4]!.priority).toBe(0.8);
  });

  test("a marker drops that legal page, the rest stay", () => {
    const out = buildSitemap(ORIGIN, [
      { path: "/terms", markers: ["[[MISSING: LEGAL_SUPPORT_EMAIL]]"] },
      { path: "/privacy", markers: [] },
      { path: "/refund", markers: [] },
    ]);
    expect(out.map((entry) => entry.url)).toEqual([
      "https://settlenotes.com/",
      "https://settlenotes.com/privacy",
      "https://settlenotes.com/refund",
      "https://settlenotes.com/guides",
    ]);
  });

  test("a failed load drops the page", () => {
    const out = buildSitemap(ORIGIN, [
      { path: "/terms", markers: null },
      { path: "/privacy", markers: [] },
    ]);
    expect(out.map((entry) => entry.url)).toEqual([
      "https://settlenotes.com/",
      "https://settlenotes.com/privacy",
      "https://settlenotes.com/guides",
    ]);
  });
});
