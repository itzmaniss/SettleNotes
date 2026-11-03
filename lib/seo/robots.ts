import type { Metadata, MetadataRoute } from "next";

// robots.txt, built pure so the route file stays a one line call. The private
// areas are the ones a search engine never needs: the dashboard, the API and
// webhook routes, the auth handoff, the consent step and the login page.
export function buildRobots(origin: URL): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/dashboard", "/api/", "/auth/", "/accept", "/login"],
      },
    ],
    sitemap: new URL("/sitemap.xml", origin).toString(),
    host: origin.origin,
  };
}

// The legal pages flip to noindex the moment a filled document still carries
// a marker: a counsel question, a missing setting or an unknown token. The
// route pages feed findMarkers results in here per request, so the flag never
// goes stale.
export function legalRobots(markers: string[]): Metadata["robots"] {
  if (markers.length > 0) return { index: false, follow: true };
  return { index: true, follow: true };
}
