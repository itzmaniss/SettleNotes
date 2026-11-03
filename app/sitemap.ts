import type { MetadataRoute } from "next";

import { LEGAL_KEYS, loadLegalDocument } from "@/lib/legal/content";
import { buildSitemap, type LegalSitemapInput } from "@/lib/seo/sitemap";
import { siteUrl } from "@/lib/seo/site";

// Which legal pages belong in the sitemap depends on the environment (their
// blanks show as markers), so the list must be built per request, never at
// build time.
export const dynamic = "force-dynamic";

export default function sitemap(): MetadataRoute.Sitemap {
  const legal: LegalSitemapInput[] = LEGAL_KEYS.map((key) => {
    try {
      return { path: `/${key}`, markers: loadLegalDocument(key).markers };
    } catch {
      // A failed read drops the page instead of listing something unverified.
      return { path: `/${key}`, markers: null };
    }
  });
  return buildSitemap(siteUrl(process.env.APP_BASE_URL), legal);
}
