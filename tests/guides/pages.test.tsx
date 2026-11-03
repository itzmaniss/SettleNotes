import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import GuidesIndexPage from "@/app/guides/page";
import FaqPage from "@/app/faq/page";
import { generateMetadata, default as GuideArticlePage } from "@/app/guides/[slug]/page";
import { loadGuide } from "@/lib/guides/content";
import { linksOfBlocks } from "@/lib/guides/markdown";

const DASH = /[\u2013\u2014]/;

const SLUG = "track-deadlines-from-a-group-chat";

// The bot button reads the bot username at render time, so the CTA tests pin
// it and afterEach hands the real environment back.
const SAVED_BOT_ENV = process.env.TELEGRAM_BOT_USERNAME;

afterEach(() => {
  if (SAVED_BOT_ENV === undefined) delete process.env.TELEGRAM_BOT_USERNAME;
  else process.env.TELEGRAM_BOT_USERNAME = SAVED_BOT_ENV;
});

function withBotEnv(): void {
  process.env.TELEGRAM_BOT_USERNAME = "settle_bot";
}

async function renderArticle(slug: string): Promise<string> {
  return renderToStaticMarkup(
    (await GuideArticlePage({ params: Promise.resolve({ slug }) })) as React.ReactElement,
  );
}

describe("the guides index page", () => {
  const html = renderToStaticMarkup(<GuidesIndexPage />);

  test("one h1, an intro and a card per guide", () => {
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain("Study guides");
    expect((html.match(/href="\/guides\//g) ?? []).length).toBe(5);
  });

  test("every card carries the file title and description", () => {
    for (const guide of [
      loadGuide("check-your-maths-working"),
      loadGuide("turn-lecture-slides-into-flashcards"),
    ]) {
      expect(html).toContain(guide.title);
      expect(html).toContain(guide.description);
    }
  });

  test("a link to the FAQ, exactly one ld+json script, no dashes", () => {
    expect(html).toContain('href="/faq"');
    expect(html.match(/application\/ld\+json/g)).toHaveLength(1);
    expect(html).not.toMatch(DASH);
    expect(html).not.toContain("{{");
  });
});

describe("a guide article page", () => {
  test("one h1 from the file title, the breadcrumb, the updated line and the bot button", async () => {
    withBotEnv();
    const guide = loadGuide(SLUG);
    const html = await renderArticle(SLUG);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain(guide.title);
    expect(html).toContain("Last updated 4 November 2026");
    // The breadcrumb row: Home and Study guides as real links, the title as words.
    expect(html).toContain('href="/">Home</a>');
    expect(html).toContain('href="/guides">Study guides</a>');
    // The real call to action: the bot anchor, never a plain link to /#start.
    expect(html).not.toContain('href="/#start"');
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toContain("Open the Settle bot on Telegram");
    expect(html.match(/application\/ld\+json/g)).toHaveLength(1);
    expect(html).not.toMatch(DASH);
  });

  test("related links come from the body itself and keep their targets", async () => {
    const guide = loadGuide("turn-lecture-slides-into-flashcards");
    const html = await renderArticle("turn-lecture-slides-into-flashcards");
    for (const link of linksOfBlocks(guide.blocks)) {
      expect(html).toContain(`href="${link.href}"`);
      expect(html).toContain(link.text);
    }
  });

  test("an unknown slug would never render: generateStaticParams lists the whitelist", async () => {
    const { generateStaticParams } = await import("@/app/guides/[slug]/page");
    expect(generateStaticParams().map((entry) => entry.slug)).toEqual([
      "track-deadlines-from-a-group-chat",
      "check-your-maths-working",
      "turn-lecture-slides-into-flashcards",
      "assignment-brief-checklist",
      "spaced-review-for-weak-spots",
    ]);
    expect(() => loadGuide("../terms")).toThrow();
  });

  test("generateMetadata builds the tested builder output", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ slug: SLUG }) });
    expect(meta.alternates).toEqual({ canonical: `/guides/${SLUG}` });
    expect(meta.title).toBe(loadGuide(SLUG).title);
  });
});

describe("the faq page", () => {
  const faq = loadGuide("faq");
  const html = renderToStaticMarkup(<FaqPage />);

  test("the h1 is Questions and answers and every question is an h2", () => {
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain("Questions and answers");
    const questions = faq.blocks.flatMap((block) => (block.kind === "h2" ? [block.text] : []));
    expect((html.match(/<h2\b/g) ?? []).length).toBe(questions.length);
    for (const question of questions) {
      expect(html).toContain(question);
    }
  });

  test("the answers render as visible text, links keep their labels, the CTA is the bot anchor", () => {
    withBotEnv();
    const rendered = renderToStaticMarkup(<FaqPage />);
    expect(rendered).toContain("The contact email is in the Terms and the Privacy Policy.");
    expect(rendered).toContain('href="/privacy"');
    expect(rendered).not.toContain('href="/#start"');
    expect(rendered).toContain("Open the Settle bot on Telegram");
    expect(rendered).toContain('target="_blank" rel="noopener noreferrer"');
  });

  test("exactly one ld+json script, parseable, FAQPage with thirteen questions", () => {
    expect(html.match(/application\/ld\+json/g)).toHaveLength(1);
    const match = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![1]!) as { "@graph": Array<Record<string, unknown>> };
    expect(parsed["@graph"].map((node) => node["@type"])).toEqual(["FAQPage", "BreadcrumbList"]);
    expect((parsed["@graph"][0]!["mainEntity"] as unknown[]).length).toBe(13);
    expect(html).not.toMatch(DASH);
  });

  test("the footer keeps the legal page shell with its legal links", () => {
    expect(html).toContain('aria-label="Legal"');
    expect(html).toContain('href="/terms"');
  });
});
