// Loads the guide and FAQ pages: reads content/guides/<slug>.md, parses the
// key: value header, fills the number tokens from lib/guides/facts.ts, parses
// the body with lib/guides/markdown.ts, and strips the trailing call to
// action paragraph so the page can render the real bot button. Pure helpers
// take injected source and facts, so the tests never touch fs; the only fs
// read happens in readGuideSource at request or build time.
import { readFileSync } from "node:fs";
import path from "node:path";

import { GUIDE_FACTS, type GuideFacts } from "./facts";
import {
  CTA_HREF,
  isCtaBlock,
  parseGuideMarkdown,
  type GuideBlock,
} from "./markdown";

// Fixed order for the guides index, the sitemap and the landing section. The
// FAQ is a page of its own and never appears in this list.
export const GUIDE_SLUGS = [
  "track-deadlines-from-a-group-chat",
  "check-your-maths-working",
  "turn-lecture-slides-into-flashcards",
  "assignment-brief-checklist",
  "spaced-review-for-weak-spots",
] as const;

export type GuideSlug = (typeof GUIDE_SLUGS)[number];

export const FAQ_SLUG = "faq";

// Every slug loadGuide accepts. The path is built only after this check, so
// traversal attempts like ../terms never reach fs.
export const ALL_GUIDE_SLUGS: readonly string[] = [...GUIDE_SLUGS, FAQ_SLUG];

export type GuideKind = "guide" | "faq";

export type GuideDoc = {
  slug: string;
  kind: GuideKind;
  title: string;
  description: string;
  // YYYY-MM-DD straight from the header.
  updated: string;
  // Body blocks with the trailing CTA paragraph already removed.
  blocks: GuideBlock[];
  // Always true: loadGuide refuses a body that does not end with the CTA.
  cta: boolean;
};

export type GuideSummary = {
  slug: string;
  title: string;
  description: string;
  updated: string;
};

export class GuideLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuideLoadError";
  }
}

const TITLE_MIN = 20;
const TITLE_MAX = 60;
const DESCRIPTION_MIN = 110;
const DESCRIPTION_MAX = 160;
const UPDATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const HEADER_KEYS = new Set(["title", "description", "updated"]);

// Splits the key: value header from the body at the first --- line and
// validates every rule the tests pin: exactly the three keys, title 20 to 60
// characters, description 110 to 160, updated a real calendar date.
export function parseGuideHeader(source: string): {
  title: string;
  description: string;
  updated: string;
  body: string;
} {
  const lines = source.split("\n");
  const separator = lines.findIndex((line) => line.trim() === "---");
  if (separator === -1) {
    throw new GuideLoadError("no header separator line found");
  }
  const fields = new Map<string, string>();
  for (const line of lines.slice(0, separator)) {
    const match = /^([A-Za-z]+): (.*)$/.exec(line);
    if (match === null) {
      throw new GuideLoadError("guide header line is not key: value");
    }
    const key = match[1];
    if (!HEADER_KEYS.has(key)) {
      throw new GuideLoadError(`unknown guide header key "${key}"`);
    }
    if (fields.has(key)) {
      throw new GuideLoadError(`duplicate guide header key "${key}"`);
    }
    fields.set(key, match[2].trim());
  }
  for (const key of HEADER_KEYS) {
    if (!fields.has(key)) {
      throw new GuideLoadError(`guide header is missing "${key}"`);
    }
  }
  const title = fields.get("title") ?? "";
  const description = fields.get("description") ?? "";
  const updated = fields.get("updated") ?? "";
  if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
    throw new GuideLoadError(`guide title must be ${TITLE_MIN} to ${TITLE_MAX} characters`);
  }
  if (description.length < DESCRIPTION_MIN || description.length > DESCRIPTION_MAX) {
    throw new GuideLoadError(
      `guide description must be ${DESCRIPTION_MIN} to ${DESCRIPTION_MAX} characters`,
    );
  }
  if (!UPDATE_RE.test(updated) || !isValidDate(updated)) {
    throw new GuideLoadError("guide updated must be a real YYYY-MM-DD date");
  }
  const body = lines.slice(separator + 1).join("\n").trim();
  if (body.length === 0) {
    throw new GuideLoadError("guide body is empty");
  }
  return { title, description, updated, body };
}

// 2026-02-30 fails because the round trip through Date lands on March.
function isValidDate(value: string): boolean {
  const parsed = new Date(value + "T00:00:00Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// Replaces every {{name}} with its value from the facts table. An unknown
// name, an empty value or anything left over throws: a raw {{ never reaches
// a page.
function fillGuideTokens(source: string, facts: GuideFacts): string {
  const filled = source.replace(/\{\{([a-z_]+)\}\}/g, (_whole, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(facts, name)) {
      throw new GuideLoadError(`guide token "${name}" has no value`);
    }
    const value = facts[name as keyof GuideFacts];
    return value;
  });
  if (filled.includes("{{")) {
    throw new GuideLoadError("a guide token was left unfilled");
  }
  return filled;
}

// The kind follows the slug: the FAQ page is its own document, everything
// else is a guide article.
function kindOf(slug: string): GuideKind {
  return slug === FAQ_SLUG ? "faq" : "guide";
}

function assemble(slug: string, source: string, facts: GuideFacts): GuideDoc {
  const { title, description, updated, body } = parseGuideHeader(source);
  const filled = fillGuideTokens(body, facts);
  const blocks = parseGuideMarkdown(filled);
  if (!isCtaBlock(blocks.at(-1))) {
    throw new GuideLoadError(`guide body does not end with the call to action link to ${CTA_HREF}`);
  }
  return {
    slug,
    kind: kindOf(slug),
    title,
    description,
    updated,
    blocks: blocks.slice(0, -1),
    cta: true,
  };
}

export function readGuideSource(slug: string): string {
  return readFileSync(path.join(process.cwd(), "content", "guides", slug + ".md"), "utf8");
}

// Loads one document. The whitelist is checked before any path is built, so
// traversal input throws instead of reading a file outside content/guides.
export function loadGuide(
  slug: string,
  deps?: { source?: string; facts?: GuideFacts },
): GuideDoc {
  if (!(ALL_GUIDE_SLUGS as readonly string[]).includes(slug)) {
    throw new GuideLoadError(`unknown guide slug "${slug}"`);
  }
  const source = deps?.source ?? readGuideSource(slug);
  return assemble(slug, source, deps?.facts ?? GUIDE_FACTS);
}

// The five guides in the fixed order. Strict: a broken file fails the guides
// index and the test run instead of shipping a half page.
export function listGuides(deps?: { facts?: GuideFacts }): GuideDoc[] {
  return GUIDE_SLUGS.map((slug) => loadGuide(slug, deps));
}

// Summaries for the landing section: a file that fails to load drops only
// itself, so the landing page can never break because of one guide.
export function listGuideSummaries(deps?: { facts?: GuideFacts }): GuideSummary[] {
  const out: GuideSummary[] = [];
  for (const slug of GUIDE_SLUGS) {
    try {
      const doc = loadGuide(slug, deps);
      out.push({ slug: doc.slug, title: doc.title, description: doc.description, updated: doc.updated });
    } catch {
      // Dropped on purpose; the sitemap rule applies here too.
    }
  }
  return out;
}

// The FAQ question and answer pairs, exactly as a reader sees them: the h2
// text and the visible text of that answer's paragraphs and list items joined
// with spaces. Links are already reduced to their labels by spansText.
export function faqItemsOf(doc: GuideDoc): Array<{ question: string; answer: string }> {
  const items: Array<{ question: string; answer: string }> = [];
  let question: string | null = null;
  let answer: string[] = [];
  const flush = () => {
    if (question !== null && answer.length > 0) {
      items.push({ question, answer: answer.join(" ") });
    }
    question = null;
    answer = [];
  };
  for (const block of doc.blocks) {
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
  return items;
}
