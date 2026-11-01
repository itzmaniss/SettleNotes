import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { Logo } from "@/components/settle/logo";
import { Nav } from "@/components/marketing/nav";
import { Footer } from "@/components/marketing/footer";

const ROOT = join(import.meta.dir, "..", "..");
const MARK_SVG = readFileSync(join(ROOT, "public/brand/settle-mark.svg"), "utf8");

function attrs(markup: string, attribute: string): string[] {
  return [...markup.matchAll(new RegExp(`${attribute}="([^"]+)"`, "g"))].map(
    (m) => m[1]
  );
}

describe("Logo component", () => {
  test("mark is decorative: aria-hidden, not focusable, no wordmark", () => {
    const html = renderToStaticMarkup(<Logo />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('focusable="false"');
    expect(html).not.toContain(">Settle<");
  });

  test("wordmark renders the live text Settle only when asked", () => {
    const html = renderToStaticMarkup(<Logo wordmark />);
    expect(html).toContain(">Settle<");
    expect(html).toContain("font-display");
    expect(renderToStaticMarkup(<Logo size={20} wordmark={false} />)).not.toContain(
      ">Settle<"
    );
  });

  test("inline paths equal the paths in settle-mark.svg", () => {
    const html = renderToStaticMarkup(<Logo />);
    expect(attrs(html, "d")).toEqual(attrs(MARK_SVG, "d"));
    expect(attrs(html, "points")).toEqual(attrs(MARK_SVG, "points"));
  });

  test("size prop drives width and height", () => {
    expect(renderToStaticMarkup(<Logo size={32} />)).toContain('width="32"');
  });
});

describe("mark appears before the brand text", () => {
  test("nav renders the mark at 26px before settle", () => {
    const html = renderToStaticMarkup(<Nav />);
    expect(html).toContain("<svg");
    expect(html).toContain('width="26"');
    expect(html.indexOf("<svg")).toBeLessThan(html.indexOf("settle"));
  });

  test("footer renders the mark at 20px before settle", () => {
    const html = renderToStaticMarkup(<Footer />);
    expect(html).toContain("<svg");
    expect(html).toContain('width="20"');
    expect(html.indexOf("<svg")).toBeLessThan(html.indexOf("settle"));
  });
});
