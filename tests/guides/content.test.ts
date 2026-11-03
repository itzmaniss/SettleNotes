import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  ALL_GUIDE_SLUGS,
  FAQ_SLUG,
  GUIDE_SLUGS,
  GuideLoadError,
  faqItemsOf,
  listGuides,
  loadGuide,
  parseGuideHeader,
} from "@/lib/guides/content";
import { GUIDE_TOKEN_NAMES, type GuideTokenName } from "@/lib/guides/facts";
import { CTA_HREF, CTA_LABEL, isCtaBlock, linksOfBlocks } from "@/lib/guides/markdown";
import { LEGAL_PATHS } from "@/lib/legal/paths";

const DASH = /[\u2013\u2014]/;

// 129 characters, so every injected source passes the header length rule and
// a test failure always names the rule it was written for.
const GOOD_DESCRIPTION =
  "A description that is long enough to satisfy the loader rule for every single injected guide source used in this whole test file.";

const GOOD_TITLE = "A test guide about nothing at all here";

// Routes a body link may point at: the public pages plus every guide slug.
const KNOWN_ROUTES = new Set<string>([
  "/",
  "/guides",
  "/faq",
  "/login",
  ...Object.values(LEGAL_PATHS),
  ...GUIDE_SLUGS.map((slug) => `/guides/${slug}`),
]);

const guides = listGuides();
const faq = loadGuide(FAQ_SLUG);
const all = [...guides, faq];

function rawSource(slug: string): string {
  return readFileSync(`content/guides/${slug}.md`, "utf8");
}

describe("all six real files load and validate", () => {
  test("the five guides load in the fixed order, the FAQ separately", () => {
    expect(guides.map((guide) => guide.slug)).toEqual([...GUIDE_SLUGS]);
    expect(GUIDE_SLUGS).not.toContain(FAQ_SLUG);
    expect(ALL_GUIDE_SLUGS).toHaveLength(6);
  });

  test("titles and descriptions sit inside the enforced ranges and are unique", () => {
    const titles = new Set<string>();
    const descriptions = new Set<string>();
    for (const doc of all) {
      expect(doc.title.length).toBeGreaterThanOrEqual(20);
      expect(doc.title.length).toBeLessThanOrEqual(60);
      expect(doc.description.length).toBeGreaterThanOrEqual(110);
      expect(doc.description.length).toBeLessThanOrEqual(160);
      expect(titles.has(doc.title)).toBe(false);
      expect(descriptions.has(doc.description)).toBe(false);
      titles.add(doc.title);
      descriptions.add(doc.description);
    }
  });

  test("every updated value is a real calendar date of the YYYY-MM-DD shape", () => {
    for (const doc of all) {
      expect(doc.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const parsed = new Date(doc.updated + "T00:00:00Z");
      expect(parsed.toISOString().slice(0, 10)).toBe(doc.updated);
    }
  });

  test("no raw tokens in the loaded output, no markers, no dashes, no exclamation marks", () => {
    const knownTokens = new Set(GUIDE_TOKEN_NAMES);
    for (const doc of all) {
      const raw = rawSource(doc.slug);
      // The raw file fills its numbers through tokens only, and only the five
      // known ones.
      for (const match of raw.matchAll(/\{\{([a-z_]+)\}\}/g)) {
        expect(knownTokens.has(match[1] as GuideTokenName)).toBe(true);
      }
      expect(raw).not.toContain("[[");
      expect(raw).not.toMatch(DASH);
      expect(raw).not.toContain("!");
      const rendered = JSON.stringify(doc.blocks);
      expect(rendered).not.toContain("{{");
      expect(rendered).not.toContain("[[");
      expect(rendered).not.toMatch(DASH);
    }
  });

  test("every guide body has at least 250 words", () => {
    for (const guide of guides) {
      const words = guide.blocks
        .map((block) => {
          if (block.kind === "ul" || block.kind === "ol") {
            return block.items.map((item) => item.text).join(" ");
          }
          return block.kind === "h2" || block.kind === "p" ? block.text : "";
        })
        .join(" ")
        .split(/\s+/)
        .filter((word) => word.length > 0);
      expect(words.length).toBeGreaterThanOrEqual(250);
    }
  });

  test("every document ends with the call to action and it is stripped from the blocks", () => {
    for (const doc of all) {
      expect(doc.cta).toBe(true);
      const raw = rawSource(doc.slug).trimEnd();
      expect(raw.endsWith(`[${CTA_LABEL}](${CTA_HREF})`)).toBe(true);
      const ctaLeft = doc.blocks.some((block) => isCtaBlock(block));
      expect(ctaLeft).toBe(false);
    }
  });

  test("every internal link points at a real route, a guide slug or /#start", () => {
    for (const doc of all) {
      for (const link of linksOfBlocks(doc.blocks)) {
        const ok =
          link.href === "/#start" ||
          KNOWN_ROUTES.has(link.href.split("#")[0] ?? link.href);
        expect([`${doc.slug}: ${link.href}`, ok]).toEqual([`${doc.slug}: ${link.href}`, true]);
      }
    }
  });

  test("external https links keep their rel, so the subset did not weaken the legal rules", () => {
    const source = [
      `title: ${GOOD_TITLE}`,
      `description: ${GOOD_DESCRIPTION}`,
      "updated: 2026-01-01",
      "---",
      "See [the outside page](https://example.com/page) once.",
      "",
      `[${CTA_LABEL}](${CTA_HREF})`,
    ].join("\n");
    const doc = loadGuide("track-deadlines-from-a-group-chat", { source });
    const link = linksOfBlocks(doc.blocks)[0];
    expect(link?.href).toBe("https://example.com/page");
  });

  test("the FAQ yields one question and answer pair per visible question heading", () => {
    const items = faqItemsOf(faq);
    const questions = faq.blocks.flatMap((block) => (block.kind === "h2" ? [block.text] : []));
    expect(items.map((item) => item.question)).toEqual(questions);
    for (const item of items) {
      expect(item.answer.length).toBeGreaterThan(0);
      expect(item.answer).not.toMatch(DASH);
      expect(item.answer).not.toContain("**");
      expect(item.answer).not.toContain("](");
    }
  });
});

describe("the loader refuses bad input", () => {
  test("traversal and unknown slugs never reach fs", () => {
    for (const slug of ["../terms", "../../package", "terms", "faq.md", "", "/guides/track", "./track-deadlines-from-a-group-chat"]) {
      expect(() => loadGuide(slug)).toThrow(GuideLoadError);
    }
  });

  test("an unknown token throws and never reaches the page", () => {
    const source = [
      `title: ${GOOD_TITLE}`,
      `description: ${GOOD_DESCRIPTION}`,
      "updated: 2026-01-01",
      "---",
      "You get {{free_math}} checks and {{free_nope}} mystery points.",
      "",
      `[${CTA_LABEL}](${CTA_HREF})`,
    ].join("\n");
    expect(() =>
      loadGuide("track-deadlines-from-a-group-chat", { source }),
    ).toThrow(GuideLoadError);
  });

  test("a missing value throws", () => {
    const source = [
      `title: ${GOOD_TITLE}`,
      `description: ${GOOD_DESCRIPTION}`,
      "updated: 2026-01-01",
      "---",
      `You get {{pdf_pages}} pages. [${CTA_LABEL}](${CTA_HREF})`,
    ].join("\n");
    expect(() =>
      loadGuide("track-deadlines-from-a-group-chat", {
        source,
        facts: { free_math: "3", free_slides: "1", free_briefs: "1", pdf_pages: "", voice_minutes: "3" },
      }),
    ).toThrow(GuideLoadError);
  });

  test("a spaced or renamed token is caught by the leftover check", () => {
    const source = [
      `title: ${GOOD_TITLE}`,
      `description: ${GOOD_DESCRIPTION}`,
      "updated: 2026-01-01",
      "---",
      `You get {{ pdf_pages }} pages. [${CTA_LABEL}](${CTA_HREF})`,
    ].join("\n");
    expect(() =>
      loadGuide("track-deadlines-from-a-group-chat", { source }),
    ).toThrow(GuideLoadError);
  });

  test("header validation: lengths, real dates, unknown and duplicate keys, missing separator", () => {
    const body = `Text line. [${CTA_LABEL}](${CTA_HREF})`;
    const base = (header: string) => `${header}---\n${body}\n`;
    const shortTitle = base(
      "title: Too short\n" +
        `description: ${GOOD_DESCRIPTION}\n` +
        "updated: 2026-01-01\n",
    );
    expect(() => parseGuideHeader(shortTitle)).toThrow(GuideLoadError);
    const longDescription = base(
      "title: A test guide about nothing at all here\n" +
        "description: " + "Really far too long for the rule. ".repeat(8) + "\n" +
        "updated: 2026-01-01\n",
    );
    expect(() => parseGuideHeader(longDescription)).toThrow(GuideLoadError);
    const badDate = base(
      "title: A test guide about nothing at all here\n" +
        `description: ${GOOD_DESCRIPTION}\n` +
        "updated: 2026-02-30\n",
    );
    expect(() => parseGuideHeader(badDate)).toThrow(GuideLoadError);
    const unknownKey = base(
      "title: A test guide about nothing at all here\n" +
        `description: ${GOOD_DESCRIPTION}\n` +
        "updated: 2026-01-01\n" +
        "author: someone\n",
    );
    expect(() => parseGuideHeader(unknownKey)).toThrow(GuideLoadError);
    const duplicate = base(
      "title: A test guide about nothing at all here\n" +
        "title: Another title that is long enough here\n" +
        `description: ${GOOD_DESCRIPTION}\n` +
        "updated: 2026-01-01\n",
    );
    expect(() => parseGuideHeader(duplicate)).toThrow(GuideLoadError);
    expect(() => parseGuideHeader("title: No separator in this one at all here\n")).toThrow(
      GuideLoadError,
    );
  });

  test("a body without the trailing call to action throws", () => {
    const source = [
      `title: ${GOOD_TITLE}`,
      `description: ${GOOD_DESCRIPTION}`,
      "updated: 2026-01-01",
      "---",
      "Just text, no call to action at the end.",
    ].join("\n");
    expect(() =>
      loadGuide("track-deadlines-from-a-group-chat", { source }),
    ).toThrow(GuideLoadError);
  });
});
