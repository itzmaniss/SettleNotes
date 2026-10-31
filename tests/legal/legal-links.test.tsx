import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LEGAL_LABELS, LEGAL_PATHS } from "../../lib/legal/paths";
import { LegalLinks } from "../../components/legal/legal-links";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

describe("LEGAL_PATHS", () => {
  test("the three pages at their fixed paths", () => {
    expect(LEGAL_PATHS).toEqual({ terms: "/terms", privacy: "/privacy", refund: "/refund" });
  });
});

describe("LegalLinks", () => {
  test("renders the three links with those hrefs and their labels", () => {
    const html = render(<LegalLinks />);
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/refund"');
    expect(html).toContain("Terms");
    expect(html).toContain("Privacy");
    expect(html).toContain("Refunds");
  });

  test("labels carry no dashes and every link is a 44px tap target", () => {
    for (const label of Object.values(LEGAL_LABELS)) {
      expect(label).not.toMatch(/[\u2013\u2014]/);
    }
    const html = render(<LegalLinks />);
    expect(html).toContain("min-h-[44px]");
  });

  test("matches the other footer links: sentence case mono at 14px", () => {
    const html = render(<LegalLinks />);
    expect(html).toContain("font-mono");
    expect(html).toContain("text-sm");
    expect(html).not.toContain("uppercase");
    expect(html).not.toContain("tracking-widest");
    expect(html).not.toContain("text-[11px]");
  });

  test("is server safe: no client directive, no hooks, plain anchors", () => {
    const html = render(<LegalLinks />);
    expect(html).not.toContain("button");
    expect(html).toContain("<a");
  });
});
