import { LANDING_DESCRIPTION } from "./metadata";
import { SITE_NAME } from "./site";

// The landing page structured data, built pure so the page and the tests share
// one shape. Only what the code can back: an organisation, the website, and
// the app with its free plan. No ratings, no reviews, no Pro offer, because
// Pro is not on sale and a made up number would be a fake claim.
export function buildLandingJsonld(origin: URL): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        name: SITE_NAME,
        url: origin.toString(),
        logo: new URL("/brand/settle-icon-512.png", origin).toString(),
      },
      {
        "@type": "WebSite",
        name: SITE_NAME,
        url: origin.toString(),
      },
      {
        "@type": "SoftwareApplication",
        name: SITE_NAME,
        applicationCategory: "EducationalApplication",
        operatingSystem: "Telegram",
        description: LANDING_DESCRIPTION,
        offers: {
          "@type": "Offer",
          price: "0",
          priceCurrency: "SGD",
        },
      },
    ],
  };
}

// The script body for the JSON-LD tag. Every "<" becomes the \u003c escape, so
// no string in the data can close the script tag early, and the text stays
// valid JSON: parsing it returns the original value.
export function toJsonLdScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
