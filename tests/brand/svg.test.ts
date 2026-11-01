import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const MARK = readFileSync(join(ROOT, "public/brand/settle-mark.svg"), "utf8");
const FAVICON = readFileSync(join(ROOT, "app/icon.svg"), "utf8");

const HEX = /#[0-9A-Fa-f]{6}/g;
const EM_EN_DASH = /[\u2013\u2014]/;

// Every text file this card created, checked for stray em or en dashes.
const NEW_TEXT_FILES = [
  "public/brand/settle-mark.svg",
  "app/icon.svg",
  "components/settle/logo.tsx",
  "components/settle/index.ts",
  "scripts/build-brand.ts",
  ...readdirSync(join(ROOT, "tests/brand")).map((f) => `tests/brand/${f}`),
];

function colours(svg: string): string[] {
  return [...new Set((svg.match(HEX) ?? []).map((c) => c.toUpperCase()))].sort();
}

// Light XML-ish parse: tags balance, one svg root, comments ignored.
function parseCheck(svg: string, label: string) {
  const trimmed = svg.trim();
  expect(trimmed.startsWith("<svg"), `${label} starts with svg`).toBe(true);
  expect(trimmed.endsWith("</svg>"), `${label} ends with svg`).toBe(true);
  const stack: string[] = [];
  for (const tag of trimmed.match(/<\/?[a-zA-Z][^>]*>/g) ?? []) {
    const name = tag.match(/^<\/?([a-zA-Z]+)/)?.[1] ?? "";
    if (tag.startsWith("</")) {
      expect(stack.pop(), `${label} closing ${name}`).toBe(name);
    } else if (!tag.endsWith("/>")) {
      stack.push(name);
    }
  }
  expect(stack, `${label} balanced`).toEqual([]);
}

describe("brand SVG sources", () => {
  test("parse as XML-ish text", () => {
    parseCheck(MARK, "mark");
    parseCheck(FAVICON, "favicon");
  });

  test("mark uses exactly lime, ink and lilac", () => {
    expect(colours(MARK)).toEqual(["#12161F", "#B78CF2", "#C1F354"]);
  });

  test("favicon variant uses exactly lime and ink (no spark)", () => {
    expect(colours(FAVICON)).toEqual(["#12161F", "#C1F354"]);
    expect(FAVICON).not.toContain("#B78CF2");
  });

  test("no text, script, style, image, filter, gradient, href or url()", () => {
    const forbidden = [
      "<text",
      "<script",
      "<style",
      "<image",
      "<filter",
      "gradient",
      "href",
      "url(",
    ];
    for (const needle of forbidden) {
      expect(MARK.toLowerCase()).not.toContain(needle);
      expect(FAVICON.toLowerCase()).not.toContain(needle);
    }
  });

  test("viewBox is 0 0 512 512", () => {
    expect(MARK).toContain('viewBox="0 0 512 512"');
    expect(FAVICON).toContain('viewBox="0 0 512 512"');
  });

  test("no width or height attributes on the mark svg", () => {
    expect(MARK).not.toMatch(/<svg[^>]*\swidth=/);
    expect(MARK).not.toMatch(/<svg[^>]*\sheight=/);
  });

  test("files stay under 4 KB", () => {
    for (const rel of ["public/brand/settle-mark.svg", "app/icon.svg"]) {
      const size = statSync(join(ROOT, rel)).size;
      expect(size, rel).toBeLessThan(4096);
    }
  });

  test("no em or en dash in any new file", () => {
    for (const rel of NEW_TEXT_FILES) {
      const text = readFileSync(join(ROOT, rel), "utf8");
      expect(text.match(EM_EN_DASH) ?? [], rel).toEqual([]);
    }
  });
});
