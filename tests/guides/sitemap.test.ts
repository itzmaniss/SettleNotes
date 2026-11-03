import { describe, expect, test } from "bun:test";

import { ALL_GUIDE_SLUGS, FAQ_SLUG, loadGuide } from "@/lib/guides/content";
import { buildSitemap, type ContentSitemapInput } from "@/lib/seo/sitemap";

const ORIGIN = new URL("https://settlenotes.com");

function realContent(): ContentSitemapInput[] {
  return ALL_GUIDE_SLUGS.map((slug) => {
    const path = slug === FAQ_SLUG ? "/faq" : `/guides/${slug}`;
    try {
      return { path, updated: loadGuide(slug).updated };
    } catch {
      return { path, updated: null };
    }
  });
}

describe("the sitemap content entries", () => {
  test("the guides index is weekly at 0.8 and always present", () => {
    const out = buildSitemap(ORIGIN, [], []);
    const guides = out.at(-1)!;
    expect(guides.url).toBe("https://settlenotes.com/guides");
    expect(guides.changeFrequency).toBe("weekly");
    expect(guides.priority).toBe(0.8);
  });

  test("all six content pages are listed monthly at 0.7 with their own dates", () => {
    const out = buildSitemap(ORIGIN, [], realContent());
    const urls = out.map((entry) => entry.url);
    for (const slug of ALL_GUIDE_SLUGS) {
      expect(urls).toContain(slug === FAQ_SLUG ? "https://settlenotes.com/faq" : `https://settlenotes.com/guides/${slug}`);
    }
    const content = out.slice(-ALL_GUIDE_SLUGS.length);
    for (const entry of content) {
      expect(entry.changeFrequency).toBe("monthly");
      expect(entry.priority).toBe(0.7);
      expect(entry.lastModified).toEqual(new Date("2026-11-04"));
    }
    expect(urls).toContain("https://settlenotes.com/faq");
  });

  test("a failing guide drops only that entry and never crashes the sitemap", () => {
    const content = realContent().map((entry) =>
      entry.path === "/guides/check-your-maths-working" ? { ...entry, updated: null } : entry,
    );
    const out = buildSitemap(ORIGIN, [], content);
    const urls = out.map((entry) => entry.url);
    expect(urls).not.toContain("https://settlenotes.com/guides/check-your-maths-working");
    expect(urls).toContain("https://settlenotes.com/guides/track-deadlines-from-a-group-chat");
    expect(urls).toContain("https://settlenotes.com/faq");
    expect(urls).toContain("https://settlenotes.com/guides");
  });

  test("legal pages and content pages share one output, legal behaviour untouched", () => {
    const out = buildSitemap(
      ORIGIN,
      [
        { path: "/terms", markers: [] },
        { path: "/privacy", markers: null },
      ],
      [{ path: "/faq", updated: "2026-11-04" }],
    );
    expect(out.map((entry) => entry.url)).toEqual([
      "https://settlenotes.com/",
      "https://settlenotes.com/terms",
      "https://settlenotes.com/guides",
      "https://settlenotes.com/faq",
    ]);
    // The legal page keeps its TERMS_VERSION date, the content page its own.
    expect(out[1]!.lastModified).toEqual(new Date("2026-11-01"));
    expect(out[3]!.lastModified).toEqual(new Date("2026-11-04"));
  });
});
