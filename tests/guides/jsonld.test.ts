import { describe, expect, test } from "bun:test";

import {
  buildBreadcrumbJsonld,
  buildFaqJsonld,
  buildGuideJsonld,
  buildGuidesIndexJsonld,
  toJsonLdScript,
} from "@/lib/seo/jsonld";
import { faqItemsOf, loadGuide } from "@/lib/guides/content";
import { parseGuideMarkdown } from "@/lib/guides/markdown";

type Node = Record<string, unknown>;

const ORIGIN = new URL("https://settlenotes.com");
const DASH = /[\u2013\u2014]/;

const guide = loadGuide("check-your-maths-working");
const faq = loadGuide("faq");

function graphOf(value: Record<string, unknown>): Node[] {
  return value["@graph"] as Node[];
}

describe("buildGuideJsonld", () => {
  const value = buildGuideJsonld(ORIGIN, guide);
  const [article, breadcrumb] = graphOf(value);

  test("a graph of exactly Article plus BreadcrumbList", () => {
    expect(value["@context"]).toBe("https://schema.org");
    expect(graphOf(value).map((node) => node["@type"])).toEqual(["Article", "BreadcrumbList"]);
  });

  test("the article states only what the page shows and the updated date", () => {
    expect(article!["headline"]).toBe(guide.title);
    expect(article!["description"]).toBe(guide.description);
    expect(article!["datePublished"]).toBe(guide.updated);
    expect(article!["dateModified"]).toBe(guide.updated);
    const main = article!["mainEntityOfPage"] as Node;
    expect(main["@type"]).toBe("WebPage");
    expect(main["@id"]).toBe(`https://settlenotes.com/guides/${guide.slug}`);
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain("aggregateRating");
    expect(serialized).not.toContain("reviewRating");
    expect(serialized).not.toContain("price");
    expect(serialized).not.toMatch(DASH);
  });

  test("author and publisher are the Settle organisation with url and logo", () => {
    const expected = {
      "@type": "Organization",
      name: "Settle",
      url: "https://settlenotes.com/",
      logo: "https://settlenotes.com/brand/settle-icon-512.png",
    };
    expect(article!["author"]).toEqual(expected);
    expect(article!["publisher"]).toEqual(expected);
  });

  test("the breadcrumb is Home, Study guides, the article", () => {
    expect(breadcrumb!["itemListElement"]).toEqual([
      { "@type": "ListItem", position: 1, name: "Home", item: "https://settlenotes.com/" },
      { "@type": "ListItem", position: 2, name: "Study guides", item: "https://settlenotes.com/guides" },
      {
        "@type": "ListItem",
        position: 3,
        name: guide.title,
        item: `https://settlenotes.com/guides/${guide.slug}`,
      },
    ]);
  });

  test("every guide builds a graph that parses back to itself", () => {
    for (const slug of ["track-deadlines-from-a-group-chat", "assignment-brief-checklist", "spaced-review-for-weak-spots", "turn-lecture-slides-into-flashcards"] as const) {
      const doc = loadGuide(slug);
      const built = buildGuideJsonld(ORIGIN, doc);
      expect(JSON.parse(toJsonLdScript(built))).toEqual(built);
    }
  });

  test("a hostile headline cannot break out of the script tag", () => {
    const hostile = buildGuideJsonld(ORIGIN, {
      title: "</script><script>alert(1)</script>",
      description: "A description long enough to satisfy the header rule of the loader here.",
      updated: "2026-01-01",
      slug: "check-your-maths-working",
    });
    const body = toJsonLdScript(hostile);
    expect(body).not.toContain("<");
    expect(JSON.parse(body)).toEqual(hostile);
  });
});

describe("buildFaqJsonld", () => {
  const items = faqItemsOf(faq);
  const value = buildFaqJsonld(ORIGIN, items);
  const [faqPage, breadcrumb] = graphOf(value);

  test("a graph of exactly FAQPage plus BreadcrumbList", () => {
    expect(value["@context"]).toBe("https://schema.org");
    expect(graphOf(value).map((node) => node["@type"])).toEqual(["FAQPage", "BreadcrumbList"]);
  });

  test("every question and answer equals the visible text, plain words only", () => {
    // Independent extraction: walk the loaded blocks again here instead of
    // reusing faqItemsOf, so a bug in one cannot hide in the other.
    const visible: Array<{ question: string; answer: string }> = [];
    let question: string | null = null;
    let answer: string[] = [];
    const flush = () => {
      if (question !== null && answer.length > 0) visible.push({ question, answer: answer.join(" ") });
      question = null;
      answer = [];
    };
    for (const block of faq.blocks) {
      if (block.kind === "h2") {
        flush();
        question = block.text;
      } else if (block.kind === "p") {
        if (question !== null) answer.push(block.text);
      } else if (block.kind === "ul" || block.kind === "ol") {
        if (question !== null) answer.push(...block.items.map((item) => item.text));
      }
    }
    flush();

    expect(items.length).toBe(visible.length);
    expect(items).toEqual(visible);
    const mainEntity = faqPage!["mainEntity"] as Node[];
    expect(mainEntity).toHaveLength(items.length);
    mainEntity.forEach((node, at) => {
      expect(node["@type"]).toBe("Question");
      expect(node["name"]).toBe(items[at]!.question);
      const accepted = node["acceptedAnswer"] as Node;
      expect(accepted["@type"]).toBe("Answer");
      expect(accepted["text"]).toBe(items[at]!.answer);
    });
  });

  test("links are reduced to their labels, no markdown syntax survives", () => {
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain("**");
    expect(serialized).not.toContain("](");
    expect(serialized).not.toMatch(DASH);
  });

  test("the breadcrumb is Home, Questions and answers", () => {
    expect(breadcrumb!["itemListElement"]).toEqual([
      { "@type": "ListItem", position: 1, name: "Home", item: "https://settlenotes.com/" },
      {
        "@type": "ListItem",
        position: 2,
        name: "Questions and answers",
        item: "https://settlenotes.com/faq",
      },
    ]);
  });
});

describe("buildGuidesIndexJsonld", () => {
  test("the index carries its trail only", () => {
    const value = buildGuidesIndexJsonld(ORIGIN);
    expect(value["@context"]).toBe("https://schema.org");
    expect(graphOf(value)).toHaveLength(1);
    expect(graphOf(value)[0]!["@type"]).toBe("BreadcrumbList");
    expect(JSON.parse(toJsonLdScript(value))).toEqual(value);
  });
});

describe("buildBreadcrumbJsonld", () => {
  test("positions are one based and paths resolve against the origin", () => {
    const node = buildBreadcrumbJsonld(new URL("https://preview.example.com"), [
      { name: "Home", path: "/" },
      { name: "Study guides", path: "/guides" },
    ]);
    expect(node["itemListElement"]).toEqual([
      { "@type": "ListItem", position: 1, name: "Home", item: "https://preview.example.com/" },
      { "@type": "ListItem", position: 2, name: "Study guides", item: "https://preview.example.com/guides" },
    ]);
  });
});

describe("the markdown subset feeds the same text", () => {
  test("a parsed paragraph round trips through spansText", () => {
    const blocks = parseGuideMarkdown("A **bold** and a [link](/faq) word.");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind === "p" && blocks[0]!.text).toBe("A bold and a link word.");
  });
});
