import type { MetadataRoute } from "next";

import { buildRobots } from "@/lib/seo/robots";
import { siteUrl } from "@/lib/seo/site";

// Raw env read (never lib/env): this route is prerendered at build time where
// the full environment does not exist, and siteUrl falls back to the
// production origin, which is the origin search engines see.
export default function robots(): MetadataRoute.Robots {
  return buildRobots(siteUrl(process.env.APP_BASE_URL));
}
