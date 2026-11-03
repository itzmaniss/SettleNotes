import { describe, expect, test } from "bun:test";

import {
  FAQ_PATH,
  GUIDES_INDEX_DESCRIPTION,
  GUIDES_INDEX_PATH,
  GUIDES_INDEX_TITLE,
  faqPageMetadata,
  guidePageMetadata,
  guidesIndexMetadata,
} from "@/lib/seo/metadata";
import { OG_IMAGE_ALT, OG_IMAGE_HEIGHT, OG_IMAGE_PATH, OG_IMAGE_WIDTH } from "@/lib/seo/site";
import { loadGuide } from "@/lib/guides/content";

const DASH = /[\u2013\u2014]/;

type OgMeta = {
  type?: string;
  siteName?: string;
  locale?: string;
  url?: string | URL;
  title?: string;
  description?: string;
  publishedTime?: string;
  modifiedTime?: string;
  images?: Array<string | { url: string; width?: number; height?: number; alt?: string }>;
};

type TwMeta = {
  card?: string;
  title?: string;
  description?: string;
  images?: string[];
};

const guide = loadGuide("check-your-maths-working");
const faq = loadGuide("faq");

describe("guides index metadata", () => {
  const meta = guidesIndexMetadata(undefined);
  const og = meta.openGraph as OgMeta;
  const twitter = meta.twitter as TwMeta;

  test("title, description and canonical", () => {
    expect(meta.title).toBe(GUIDES_INDEX_TITLE);
    expect(meta.description).toBe(GUIDES_INDEX_DESCRIPTION);
    expect(GUIDES_INDEX_DESCRIPTION.length).toBeGreaterThanOrEqual(110);
    expect(GUIDES_INDEX_DESCRIPTION.length).toBeLessThanOrEqual(160);
    expect(GUIDES_INDEX_DESCRIPTION).not.toMatch(DASH);
    expect(meta.alternates).toEqual({ canonical: GUIDES_INDEX_PATH });
  });

  test("indexable, website card, shared image", () => {
    expect(meta.robots).toEqual({ index: true, follow: true });
    expect(og.type).toBe("website");
    expect(og.locale).toBe("en_SG");
    expect(og.url).toBe(GUIDES_INDEX_PATH);
    const image = (og.images ?? [])[0] as { url: string };
    expect(image.url).toBe(OG_IMAGE_PATH);
    expect(twitter.card).toBe("summary_large_image");
    expect(twitter.images![0]).toBe(OG_IMAGE_PATH);
    expect(twitter.title).toBe(GUIDES_INDEX_TITLE);
  });
});

describe("guide article metadata", () => {
  const meta = guidePageMetadata(undefined, guide);
  const og = meta.openGraph as OgMeta;
  const twitter = meta.twitter as TwMeta;

  test("title and description come from the file, canonical /guides/<slug>", () => {
    expect(meta.title).toBe(guide.title);
    expect(meta.description).toBe(guide.description);
    expect(meta.alternates).toEqual({ canonical: `/guides/${guide.slug}` });
  });

  test("article card with both times from updated, indexable", () => {
    expect(meta.robots).toEqual({ index: true, follow: true });
    expect(og.type).toBe("article");
    expect(og.url).toBe(`/guides/${guide.slug}`);
    expect(og.publishedTime).toBe(guide.updated);
    expect(og.modifiedTime).toBe(guide.updated);
    expect(og.title).toBe(guide.title);
    expect(og.description).toBe(guide.description);
  });

  test("same og image and twitter card as the site", () => {
    const image = (og.images ?? [])[0] as { url: string; width?: number; height?: number; alt?: string };
    expect(image.url).toBe(OG_IMAGE_PATH);
    expect(image.width).toBe(OG_IMAGE_WIDTH);
    expect(image.height).toBe(OG_IMAGE_HEIGHT);
    expect(image.alt).toBe(OG_IMAGE_ALT);
    expect(twitter.card).toBe("summary_large_image");
    expect(twitter.title).toBe(guide.title);
    expect(twitter.description).toBe(guide.description);
    expect(twitter.images![0]).toBe(OG_IMAGE_PATH);
  });
});

describe("faq metadata", () => {
  const meta = faqPageMetadata(undefined, faq);
  const og = meta.openGraph as OgMeta;

  test("title and description from the file, canonical /faq, indexable website card", () => {
    expect(meta.title).toBe(faq.title);
    expect(meta.description).toBe(faq.description);
    expect(meta.alternates).toEqual({ canonical: FAQ_PATH });
    expect(meta.robots).toEqual({ index: true, follow: true });
    expect(og.type).toBe("website");
    expect(og.url).toBe(FAQ_PATH);
    expect(og.title).toBe(faq.title);
    expect(og.description).toBe(faq.description);
  });
});
