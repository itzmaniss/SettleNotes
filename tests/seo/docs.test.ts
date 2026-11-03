import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const doc = readFileSync(join(ROOT, "docs", "SEO.md"), "utf8");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");

describe("docs/SEO.md", () => {
  test("the README documentation table links it", () => {
    expect(readme).toContain("[docs/SEO.md](docs/SEO.md)");
  });

  test("covers the owner steps, the checkers and the legal rule", () => {
    for (const snippet of [
      "Google Search Console",
      "TXT",
      "https://settlenotes.com/sitemap.xml",
      "Bing Webmaster Tools",
      "DuckDuckGo",
      "Rich Results Test",
      "Sharing Debugger",
      "noindex",
      "opengraph-image.png",
      "robots.txt",
      "APP_BASE_URL",
    ]) {
      expect(doc).toContain(snippet);
    }
  });

  test("no em or en dashes anywhere", () => {
    expect(doc).not.toMatch(/[\u2013\u2014]/);
  });
});
