import type { MetadataRoute } from "next";

import { TERMS_VERSION } from "@/lib/legal/version";

// One injected result per legal page. markers null means the document failed
// to load; a failure drops the page from the sitemap instead of listing
// something a reader could not actually open.
export type LegalSitemapInput = {
  path: string;
  markers: string[] | null;
};

// One injected result per content page (a guide article or the FAQ). updated
// is the YYYY-MM-DD date from the file header; null means the file failed to
// load and drops only that entry. The guides have no legal markers, so unlike
// the legal pages there is no marker check here.
export type ContentSitemapInput = {
  path: string;
  updated: string | null;
};

const LEGAL_CHANGE_FREQUENCY = "monthly" as const;
const LEGAL_PRIORITY = 0.5;

const GUIDES_INDEX_CHANGE_FREQUENCY = "weekly" as const;
const GUIDES_INDEX_PRIORITY = 0.8;
const CONTENT_CHANGE_FREQUENCY = "monthly" as const;
const CONTENT_PRIORITY = 0.7;

// The sitemap: the landing page always, then each legal page only while its
// document loads clean, then the guides index and every content page whose
// file loads, each stamped with its own updated date. Pure: callers inject the
// load results.
export function buildSitemap(
  origin: URL,
  legal: LegalSitemapInput[],
  content: ContentSitemapInput[] = [],
): MetadataRoute.Sitemap {
  const entries: MetadataRoute.Sitemap = [
    {
      url: new URL("/", origin).toString(),
      changeFrequency: "weekly",
      priority: 1,
    },
  ];
  const lastModified = new Date(TERMS_VERSION);
  for (const doc of legal) {
    if (doc.markers === null) continue;
    if (doc.markers.length > 0) continue;
    entries.push({
      url: new URL(doc.path, origin).toString(),
      lastModified,
      changeFrequency: LEGAL_CHANGE_FREQUENCY,
      priority: LEGAL_PRIORITY,
    });
  }
  entries.push({
    url: new URL("/guides", origin).toString(),
    changeFrequency: GUIDES_INDEX_CHANGE_FREQUENCY,
    priority: GUIDES_INDEX_PRIORITY,
  });
  for (const page of content) {
    if (page.updated === null) continue;
    entries.push({
      url: new URL(page.path, origin).toString(),
      lastModified: new Date(page.updated),
      changeFrequency: CONTENT_CHANGE_FREQUENCY,
      priority: CONTENT_PRIORITY,
    });
  }
  return entries;
}
