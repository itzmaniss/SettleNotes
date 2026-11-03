import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LANDING_DESCRIPTION,
  LANDING_TITLE,
  landingMetadata,
  rootMetadata,
  rootViewport,
} from "@/lib/seo/metadata";

const ROOT = join(import.meta.dir, "..", "..");
const DASH = /[\u2013\u2014]/;

// Structural views of Next's metadata unions: the builders always fill the
// object variants, the tests only read those fields.
type OgMeta = {
  type?: string;
  siteName?: string;
  locale?: string;
  url?: string | URL;
  title?: string;
  description?: string;
  images?: Array<string | { url: string; width?: number; height?: number; alt?: string }>;
};

type TwMeta = {
  card?: string;
  title?: string;
  description?: string;
  images?: string[];
};

function ogImages(meta: OgMeta): Array<{ url: string; width?: number; height?: number; alt?: string }> {
  return (meta.images ?? []).map((image) =>
    typeof image === "string" ? { url: image } : image,
  );
}

describe("root metadata", () => {
  const meta = rootMetadata(undefined);
  const og = meta.openGraph as OgMeta;
  const twitter = meta.twitter as TwMeta;

  test("metadataBase pinned to the canonical origin", () => {
    expect(meta.metadataBase).toBeInstanceOf(URL);
    expect((meta.metadataBase as URL).toString()).toBe("https://settlenotes.com/");
  });

  test("keeps the title default and template", () => {
    expect(meta.title).toEqual({ default: "Settle", template: "%s | Settle" });
  });

  test("application name and the honest description", () => {
    expect(meta.applicationName).toBe("Settle");
    expect(meta.description).toBeTruthy();
    expect(meta.description).not.toMatch(DASH);
  });

  test("robots default is index and follow", () => {
    expect(meta.robots).toEqual({ index: true, follow: true });
  });

  test("format detection off", () => {
    expect(meta.formatDetection).toEqual({
      telephone: false,
      email: false,
      address: false,
      date: false,
    });
  });

  test("open graph: website card, en_SG, share image resolves absolute", () => {
    expect(og.type).toBe("website");
    expect(og.siteName).toBe("Settle");
    expect(og.locale).toBe("en_SG");
    const image = ogImages(og)[0]!;
    expect(new URL(image.url, meta.metadataBase as URL).toString()).toBe(
      "https://settlenotes.com/opengraph-image.png",
    );
    expect(image.width).toBe(1200);
    expect(image.height).toBe(630);
    expect(image.alt).toBeTruthy();
    expect(image.alt).not.toMatch(DASH);
  });

  test("twitter card: summary_large_image with title, description and the image", () => {
    expect(twitter.card).toBe("summary_large_image");
    expect(twitter.title).toBeTruthy();
    expect(twitter.description).toBeTruthy();
    const image = twitter.images![0]!;
    expect(new URL(image, meta.metadataBase as URL).toString()).toBe(
      "https://settlenotes.com/opengraph-image.png",
    );
  });

  test("no icons key here: Next picks up the app convention files", () => {
    expect(meta.icons).toBeUndefined();
  });

  test("viewport pins the ink theme color", () => {
    expect(rootViewport.themeColor).toBe("#12161F");
  });

  test("the layout wires these tested builders, never its own object", () => {
    const source = readFileSync(join(ROOT, "app", "layout.tsx"), "utf8");
    expect(source).toContain("rootMetadata(process.env.APP_BASE_URL)");
    expect(source).toContain("export const viewport: Viewport = rootViewport");
  });
});

describe("landing metadata", () => {
  const meta = landingMetadata(undefined);
  const og = meta.openGraph as OgMeta;
  const twitter = meta.twitter as TwMeta;

  test("title stays the plain absolute title", () => {
    expect(meta.title).toEqual({ absolute: LANDING_TITLE });
    expect(LANDING_TITLE).toBe("Settle: your group chat, sorted");
  });

  test("the landing page carries the canonical", () => {
    expect(meta.alternates).toEqual({ canonical: "/" });
  });

  test("description names what it does, under 160 characters, no dashes", () => {
    expect(LANDING_DESCRIPTION.length).toBeGreaterThan(140);
    expect(LANDING_DESCRIPTION.length).toBeLessThan(160);
    expect(LANDING_DESCRIPTION).toContain("Telegram bot");
    expect(LANDING_DESCRIPTION).toContain("Free to start.");
    expect(LANDING_DESCRIPTION).not.toMatch(DASH);
  });

  test("full open graph object, because pages replace instead of merge", () => {
    expect(og.type).toBe("website");
    expect(og.siteName).toBe("Settle");
    expect(og.locale).toBe("en_SG");
    expect(og.title).toBe(LANDING_TITLE);
    expect(og.description).toBe(LANDING_DESCRIPTION);
    // Relative page url against the root origin resolves to the landing page.
    expect(new URL(og.url as string, "https://settlenotes.com/").toString()).toBe(
      "https://settlenotes.com/",
    );
    const image = ogImages(og)[0]!;
    expect(image.url).toBe("/opengraph-image.png");
    expect(image.width).toBe(1200);
    expect(image.height).toBe(630);
    expect(image.alt).toBeTruthy();
  });

  test("twitter card matches the landing copy", () => {
    expect(twitter.card).toBe("summary_large_image");
    expect(twitter.title).toBe(LANDING_TITLE);
    expect(twitter.description).toBe(LANDING_DESCRIPTION);
    expect(twitter.images![0]).toBe("/opengraph-image.png");
  });
});
