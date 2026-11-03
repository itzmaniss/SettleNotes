import type { MetadataRoute } from "next";

import { TERMS_VERSION } from "@/lib/legal/version";

// One injected result per legal page. markers null means the document failed
// to load; a failure drops the page from the sitemap instead of listing
// something a reader could not actually open.
export type LegalSitemapInput = {
  path: string;
  markers: string[] | null;
};

const LEGAL_CHANGE_FREQUENCY = "monthly" as const;
const LEGAL_PRIORITY = 0.5;

// The sitemap: the landing page always, then each legal page only while its
// document loads clean. Pure: callers inject the load results.
export function buildSitemap(
  origin: URL,
  legal: LegalSitemapInput[],
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
  return entries;
}
