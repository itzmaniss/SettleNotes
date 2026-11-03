// Pure SEO helpers: no fs, no env reads, no server-only import. Callers pass
// the raw APP_BASE_URL string (the same lazy value the other server code
// reads) and this module turns it into the one canonical origin every tag on
// the site shares, or the production fallback when the value is useless.

export const SITE_NAME = "Settle";
export const SITE_TAGLINE = "Your group chat, sorted.";
export const DEFAULT_DESCRIPTION =
  "Forward your group chat, PDFs and math photos to a Telegram bot. Settle turns them into one task list and starts each task for you.";

export const OG_IMAGE_PATH = "/opengraph-image.png";
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;
export const OG_IMAGE_ALT =
  "The Settle wordmark beside the lime speech bubble mark, with the tagline Your group chat, sorted.";

const FALLBACK_ORIGIN = "https://settlenotes.com";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

// The canonical origin: scheme and host of APP_BASE_URL with any path, query,
// auth and trailing slash stripped. Missing, blank, localhost or unreadable
// values fall back to the production origin, so a prerender build with no
// environment still emits the right address for settlenotes.com.
export function siteUrl(raw: string | undefined): URL {
  let parsed: URL;
  try {
    parsed = new URL((raw ?? "").trim());
  } catch {
    return new URL(FALLBACK_ORIGIN);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return new URL(FALLBACK_ORIGIN);
  }
  if (LOCAL_HOSTS.has(parsed.hostname.toLowerCase())) {
    return new URL(FALLBACK_ORIGIN);
  }
  return new URL(parsed.origin);
}
