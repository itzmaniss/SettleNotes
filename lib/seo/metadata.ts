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

export const LANDING_TITLE = "Settle: your group chat, sorted";
export const LANDING_DESCRIPTION =
  "Forward your group chat, PDFs and math photos to the Settle Telegram bot. Settle turns deadlines into one task list and does the first step. Free to start.";

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
