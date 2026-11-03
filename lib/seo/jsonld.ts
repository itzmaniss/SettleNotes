import {
  FAQ_H1,
  FAQ_PATH,
  GUIDES_INDEX_PATH,
  GUIDES_INDEX_TITLE,
  LANDING_DESCRIPTION,
} from "./metadata";
import { SITE_NAME } from "./site";

// The landing page structured data, built pure so the page and the tests share
// one shape. Only what the code can back: an organisation, the website, and
// the app with its free plan. No ratings, no reviews, no Pro offer, because
// Pro is not on sale and a made up number would be a fake claim.
export function buildLandingJsonld(origin: URL): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        name: SITE_NAME,
        url: origin.toString(),
        logo: new URL("/brand/settle-icon-512.png", origin).toString(),
      },
      {
        "@type": "WebSite",
        name: SITE_NAME,
        url: origin.toString(),
      },
      {
        "@type": "SoftwareApplication",
        name: SITE_NAME,
        applicationCategory: "EducationalApplication",
        operatingSystem: "Telegram",
        description: LANDING_DESCRIPTION,
        offers: {
          "@type": "Offer",
          price: "0",
          priceCurrency: "SGD",
        },
      },
    ],
  };
}

// The script body for the JSON-LD tag. Every "<" becomes the \u003c escape, so
// no string in the data can close the script tag early, and the text stays
// valid JSON: parsing it returns the original value.
export function toJsonLdScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

// The organisation node behind the article author and publisher: the same
// name, address and logo the landing graph states, nothing invented.
function organizationNode(origin: URL): Record<string, unknown> {
  return {
    "@type": "Organization",
    name: SITE_NAME,
    url: origin.toString(),
    logo: new URL("/brand/settle-icon-512.png", origin).toString(),
  };
}

export type BreadcrumbEntry = { name: string; path: string };

// One BreadcrumbList node. Every entry carries its absolute address, so the
// trail works no matter which page a crawler enters from.
export function buildBreadcrumbJsonld(origin: URL, items: BreadcrumbEntry[]): Record<string, unknown> {
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, at) => ({
      "@type": "ListItem",
      position: at + 1,
      name: item.name,
      item: new URL(item.path, origin).toString(),
    })),
  };
}

const HOME_BREADCRUMB: BreadcrumbEntry = { name: "Home", path: "/" };

export type GuideJsonldInput = {
  title: string;
  description: string;
  // YYYY-MM-DD from the guide header; both article dates carry it.
  updated: string;
  slug: string;
};

// A guide article: exactly what the page shows plus the updated date, with
// Settle as author and publisher and the article address as mainEntityOfPage.
// No dates invented, no ratings, no review counts.
export function buildGuideJsonld(origin: URL, guide: GuideJsonldInput): Record<string, unknown> {
  const path = `/guides/${guide.slug}`;
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Article",
        headline: guide.title,
        description: guide.description,
        datePublished: guide.updated,
        dateModified: guide.updated,
        author: organizationNode(origin),
        publisher: organizationNode(origin),
        mainEntityOfPage: { "@type": "WebPage", "@id": new URL(path, origin).toString() },
      },
      buildBreadcrumbJsonld(origin, [
        HOME_BREADCRUMB,
        { name: GUIDES_INDEX_TITLE, path: GUIDES_INDEX_PATH },
        { name: guide.title, path },
      ]),
    ],
  };
}

export type FaqJsonldItem = { question: string; answer: string };

// The FAQ page: every question and answer is exactly the visible text, plain
// words with links reduced to their labels, which is what the page passes in.
export function buildFaqJsonld(origin: URL, items: FaqJsonldItem[]): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "FAQPage",
        mainEntity: items.map((item) => ({
          "@type": "Question",
          name: item.question,
          acceptedAnswer: { "@type": "Answer", text: item.answer },
        })),
      },
      buildBreadcrumbJsonld(origin, [
        HOME_BREADCRUMB,
        { name: FAQ_H1, path: FAQ_PATH },
      ]),
    ],
  };
}

// The guides index is a list page: its trail only.
export function buildGuidesIndexJsonld(origin: URL): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@graph": [
      buildBreadcrumbJsonld(origin, [
        HOME_BREADCRUMB,
        { name: GUIDES_INDEX_TITLE, path: GUIDES_INDEX_PATH },
      ]),
    ],
  };
}
