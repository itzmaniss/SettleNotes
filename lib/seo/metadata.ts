import type { Metadata, Viewport } from "next";

import {
  DEFAULT_DESCRIPTION,
  OG_IMAGE_ALT,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_PATH,
  OG_IMAGE_WIDTH,
  SITE_NAME,
  SITE_TAGLINE,
  siteUrl,
} from "./site";

export const LANDING_TITLE = "SettleNotes: your group chat, sorted";
export const LANDING_DESCRIPTION =
  "Forward group chats, PDFs and math photos to the SettleNotes Telegram bot. Get one task list with a useful first step ready for each task. Free to start.";

export const GUIDES_INDEX_TITLE = "Study guides";
export const GUIDES_INDEX_DESCRIPTION =
  "Guides for Singapore students: track deadlines from a group chat, check your maths working, turn slides into flashcards and briefs into checklists.";
export const GUIDES_INDEX_PATH = "/guides";
export const FAQ_PATH = "/faq";
export const FAQ_H1 = "Questions and answers";

const INK = "#12161F";

// The site wide card defaults. The image path stays relative on purpose: with
// metadataBase set, Next resolves it into an absolute address in the rendered
// tags, and the same object keeps working behind any origin.
function openGraphBase(origin: URL): Metadata["openGraph"] {
  return {
    type: "website",
    siteName: SITE_NAME,
    url: origin,
    locale: "en_SG",
    images: [
      {
        url: OG_IMAGE_PATH,
        width: OG_IMAGE_WIDTH,
        height: OG_IMAGE_HEIGHT,
        alt: OG_IMAGE_ALT,
      },
    ],
  };
}

function twitterBase(): Metadata["twitter"] {
  return {
    card: "summary_large_image",
    title: SITE_TAGLINE,
    description: DEFAULT_DESCRIPTION,
    images: [OG_IMAGE_PATH],
  };
}

// Root layout metadata every page inherits. The origin comes from the raw
// APP_BASE_URL the caller read; prerender builds pass undefined and get the
// production fallback, which keeps the build working with no environment.
export function rootMetadata(rawAppBaseUrl: string | undefined): Metadata {
  const origin = siteUrl(rawAppBaseUrl);
  return {
    metadataBase: origin,
    title: { default: SITE_NAME, template: `%s | ${SITE_NAME}` },
    description: DEFAULT_DESCRIPTION,
    applicationName: SITE_NAME,
    openGraph: openGraphBase(origin),
    twitter: twitterBase(),
    robots: { index: true, follow: true },
    formatDetection: { telephone: false, email: false, address: false, date: false },
  };
}

export const rootViewport: Viewport = {
  themeColor: INK,
};

// The landing page carries the full card set itself: a page level openGraph
// replaces the layout one instead of merging, so the page must spell out every
// field it wants to keep.
export function landingMetadata(rawAppBaseUrl: string | undefined): Metadata {
  const origin = siteUrl(rawAppBaseUrl);
  return {
    title: { absolute: LANDING_TITLE },
    description: LANDING_DESCRIPTION,
    alternates: { canonical: "/" },
    openGraph: {
      ...openGraphBase(origin),
      url: "/",
      title: LANDING_TITLE,
      description: LANDING_DESCRIPTION,
    },
    twitter: {
      ...twitterBase(),
      title: LANDING_TITLE,
      description: LANDING_DESCRIPTION,
    },
  };
}

// A content page carries its own title and description from the markdown
// header, the shared share image, and explicit index robots: the guides and
// the FAQ have no legal markers, so they are always indexable.
export function guidesIndexMetadata(rawAppBaseUrl: string | undefined): Metadata {
  const origin = siteUrl(rawAppBaseUrl);
  return {
    title: GUIDES_INDEX_TITLE,
    description: GUIDES_INDEX_DESCRIPTION,
    alternates: { canonical: GUIDES_INDEX_PATH },
    robots: { index: true, follow: true },
    openGraph: {
      ...openGraphBase(origin),
      url: GUIDES_INDEX_PATH,
      title: GUIDES_INDEX_TITLE,
      description: GUIDES_INDEX_DESCRIPTION,
    },
    twitter: {
      ...twitterBase(),
      title: GUIDES_INDEX_TITLE,
      description: GUIDES_INDEX_DESCRIPTION,
    },
  };
}

// A guide article is an open graph article: the updated date from the file is
// both the published and the modified time, because the file says when the
// page was last true, not when a row in a database changed.
export function guidePageMetadata(
  rawAppBaseUrl: string | undefined,
  guide: { title: string; description: string; updated: string; slug: string },
): Metadata {
  const origin = siteUrl(rawAppBaseUrl);
  const path = `/guides/${guide.slug}`;
  return {
    title: guide.title,
    description: guide.description,
    alternates: { canonical: path },
    robots: { index: true, follow: true },
    openGraph: {
      ...openGraphBase(origin),
      type: "article",
      url: path,
      title: guide.title,
      description: guide.description,
      publishedTime: guide.updated,
      modifiedTime: guide.updated,
    },
    twitter: {
      ...twitterBase(),
      title: guide.title,
      description: guide.description,
    },
  };
}

// The FAQ page is a website card, not an article: it is a list of answers,
// not a dated piece.
export function faqPageMetadata(
  rawAppBaseUrl: string | undefined,
  faq: { title: string; description: string },
): Metadata {
  const origin = siteUrl(rawAppBaseUrl);
  return {
    title: faq.title,
    description: faq.description,
    alternates: { canonical: FAQ_PATH },
    robots: { index: true, follow: true },
    openGraph: {
      ...openGraphBase(origin),
      url: FAQ_PATH,
      title: faq.title,
      description: faq.description,
    },
    twitter: {
      ...twitterBase(),
      title: faq.title,
      description: faq.description,
    },
  };
}
