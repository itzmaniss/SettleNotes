import { describe, expect, test } from "bun:test";

import {
  parseInline,
  parseLegalMarkdown,
  safeLegalHref,
  spansText,
  type LegalBlock,
  type LegalParagraphBlock,
  type LegalSpan,
} from "../../lib/legal/markdown";

function kinds(blocks: LegalBlock[]): string[] {
  return blocks.map((block) => block.kind);
}

// Only paragraph shaped blocks (h1, h2, p) carry spans and text; lists do
// not, so tests narrow through this instead of casting blindly.
function para(blocks: LegalBlock[], at: number): LegalParagraphBlock {
  const block = blocks[at];
  if (!block || block.kind === "ul") throw new Error(`block ${at} is not a paragraph`);
  return block;
}

function flatText(spans: LegalSpan[]): string {
  let out = "";
  for (const span of spans) {
    out += span.kind === "link" ? flatText(span.spans) : span.text;
  }
  return out;
}

describe("safeLegalHref", () => {
  test("allows relative, https and mailto targets", () => {
    expect(safeLegalHref("/privacy")).toEqual({ href: "/privacy", external: false });
    expect(safeLegalHref("https://settle.example.com/x")).toEqual({
      href: "https://settle.example.com/x",
      external: true,
    });
    expect(safeLegalHref("mailto:legal-sentinel@example.com")).toEqual({
      href: "mailto:legal-sentinel@example.com",
      external: false,
    });
  });

  test("refuses everything else", () => {
    for (const target of [
      "http://settle.example.com",
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
      "//evil.test/path",
      "ftp://files.test",
      "settle.example.com",
    ]) {
      expect(safeLegalHref(target)).toBeNull();
    }
  });
});

describe("parseLegalMarkdown", () => {
  test("parses h1, h2, paragraphs and lists into blocks", () => {
    const blocks = parseLegalMarkdown(
      "# Title\n\nIntro line.\n\n## Section\n\n- one\n- two\n\nAfter the list.",
    );
    expect(kinds(blocks)).toEqual(["h1", "p", "h2", "ul", "p"]);
    const list = blocks[3];
    expect(list?.kind === "ul" && list.items.map((item) => item.text)).toEqual(["one", "two"]);
  });

  test("a deeper level heading is just paragraph text", () => {
    const blocks = parseLegalMarkdown("# One\n## Two\n### Three");
    expect(kinds(blocks)).toEqual(["h1", "h2", "p"]);
    expect(para(blocks, 2).text).toBe("### Three");
  });

  test("bold spans", () => {
    const blocks = parseLegalMarkdown("This is **Settle** speaking.");
    expect(para(blocks, 0).spans).toEqual([
      { kind: "text", text: "This is " },
      { kind: "bold", text: "Settle" },
      { kind: "text", text: " speaking." },
    ]);
  });

  test("relative, https and mailto links keep their target and flags", () => {
    const blocks = parseLegalMarkdown(
      "See the [Privacy Notice](/privacy) and [Meta terms](https://dev.meta.ai/legal) now.",
    );
    const spans = para(blocks, 0).spans;
    const link1 = spans[1];
    expect(link1?.kind === "link" && link1.href).toBe("/privacy");
    expect(link1?.kind === "link" && link1.external).toBe(false);
    expect(link1?.kind === "link" && link1.rel).toBeNull();
    const link2 = spans[3];
    expect(link2?.kind === "link" && link2.href).toBe("https://dev.meta.ai/legal");
    expect(link2?.kind === "link" && link2.external).toBe(true);
    expect(link2?.kind === "link" && link2.rel).toBe("noopener noreferrer");
  });

  test("a bare email becomes a mailto link", () => {
    const blocks = parseLegalMarkdown("Write to legal-sentinel@example.com for help.");
    const link = para(blocks, 0).spans[1];
    expect(link?.kind).toBe("link");
    expect(link?.kind === "link" && link.href).toBe("mailto:legal-sentinel@example.com");
    expect(link?.kind === "link" && link.external).toBe(false);
    expect(link?.kind === "link" && link.text).toBe("legal-sentinel@example.com");
  });

  test("bold inside a link label stays inside the link", () => {
    const blocks = parseLegalMarkdown("Read [**Terms** and more](/terms) now.");
    const link = para(blocks, 0).spans[1];
    expect(link?.kind).toBe("link");
    expect(link?.kind === "link" && flatText(link.spans)).toBe("Terms and more");
    const inner = link?.kind === "link" ? link.spans[0] : undefined;
    expect(inner?.kind === "bold" && inner.text).toBe("Terms");
  });

  test("counsel markers become marker spans", () => {
    const blocks = parseLegalMarkdown("Before launch. [[COUNSEL: confirm the cap.]]");
    expect(para(blocks, 0).spans).toEqual([
      { kind: "text", text: "Before launch. " },
      { kind: "marker", text: "[[COUNSEL: confirm the cap.]]" },
    ]);
  });

  test("javascript, data, http and protocol relative targets never become links", () => {
    // Every span must be plain text or bold; no link span, no echoed href.
    function linksIn(spans: LegalSpan[]): LegalSpan[] {
      const out: LegalSpan[] = [];
      for (const span of spans) {
        if (span.kind === "link") out.push(span, ...linksIn(span.spans));
      }
      return out;
    }
    for (const target of [
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
      "http://settle.example.com",
      "//evil.test/path",
    ]) {
      const blocks = parseLegalMarkdown(`Click [here](${target}) today.`);
      expect(kinds(blocks)).toEqual(["p"]);
      expect(linksIn(para(blocks, 0).spans)).toEqual([]);
      expect(JSON.stringify(blocks)).not.toContain(`"${target}"`);
    }
    // Without parentheses the refused target is dropped, the label survives.
    const dropped = parseLegalMarkdown("Click [here](http://settle.example.com) today.");
    expect(linksIn(para(dropped, 0).spans)).toEqual([]);
    expect(para(dropped, 0).text).toBe("Click here today.");
  });

  test("raw HTML is kept as plain text, never a span of its own kind", () => {
    const blocks = parseLegalMarkdown("<script>alert(1)</script> and <b>bold</b>.");
    expect(blocks).toHaveLength(1);
    const block = para(blocks, 0);
    for (const span of block.spans) {
      expect(span.kind).toBe("text");
    }
    expect(block.text).toBe("<script>alert(1)</script> and <b>bold</b>.");
  });

  test("spansText joins back to the visible text of the line", () => {
    const blocks = parseLegalMarkdown("A **b**, [l](/x), a@b.co and [[COUNSEL: m]] end.");
    expect(para(blocks, 0).text).toBe("A b, l, a@b.co and [[COUNSEL: m]] end.");
    expect(spansText(parseInline("x **y** z"))).toBe("x y z");
  });

  test("empty input yields no blocks", () => {
    expect(parseLegalMarkdown("")).toEqual([]);
  });
});
