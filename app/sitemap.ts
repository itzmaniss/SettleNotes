import type { MetadataRoute } from "next";

import { ALL_GUIDE_SLUGS, FAQ_SLUG, loadGuide } from "@/lib/guides/content";
import { LEGAL_KEYS, loadLegalDocument } from "@/lib/legal/content";
import { buildSitemap, type ContentSitemapInput, type LegalSitemapInput } from "@/lib/seo/sitemap";
import { siteUrl } from "@/lib/seo/site";

// Which legal pages belong in the sitemap depends on the environment (their
// blanks show as markers), so the list must be built per request, never at
// build time. The content pages have no markers, so they are always listed
// while their files load; a failed load drops only that entry.
export const dynamic = "force-dynamic";

function contentEntry(slug: string): ContentSitemapInput {
  const path = slug === FAQ_SLUG ? "/faq" : `/guides/${slug}`;
  try {
    return { path, updated: loadGuide(slug).updated };
  } catch {
    // A failed read drops the page instead of listing something unverified.
    return { path, updated: null };
  }
}

export default function sitemap(): MetadataRoute.Sitemap {
  const legal: LegalSitemapInput[] = LEGAL_KEYS.map((key) => {
    try {
      return { path: `/${key}`, markers: loadLegalDocument(key).markers };
    } catch {
      // A failed read drops the page instead of listing something unverified.
      return { path: `/${key}`, markers: null };
    }
  });
  const content: ContentSitemapInput[] = ALL_GUIDE_SLUGS.map(contentEntry);
  return buildSitemap(siteUrl(process.env.APP_BASE_URL), legal, content);
}
