// Pure origin resolution for every absolute redirect. Behind a proxy (Caddy in
// front of the standalone Next server) request.url carries the container's
// internal host, e.g. http://0.0.0.0:3000, so redirects built from it would
// send people to a dead address. The configured public origin always wins; the
// request URL is only a fallback for local dev where APP_BASE_URL is unset.
// No server-only, no env imports: the edge middleware imports this too.

export function publicOrigin(
  appBaseUrl: string | undefined,
  fallbackRequestUrl: string,
): string {
  if (typeof appBaseUrl === "string" && appBaseUrl.trim().length > 0) {
    try {
      return new URL(appBaseUrl.trim()).origin;
    } catch {
      // Garbage APP_BASE_URL falls through to the request URL below.
    }
  }
  try {
    return new URL(fallbackRequestUrl).origin;
  } catch {
    // Both unparseable: hand back the raw string so the caller's URL
    // constructor produces the same failure it would have anyway.
    return fallbackRequestUrl;
  }
}
