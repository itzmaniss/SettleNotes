import { describe, expect, test } from "bun:test";

import { parseInline } from "@/lib/legal/markdown";
import {
  CTA_HREF,
  CTA_LABEL,
  isCtaBlock,
  linksOfBlocks,
  parseGuideMarkdown,
} from "@/lib/guides/markdown";

function kinds(blocks: ReturnType<typeof parseGuideMarkdown>): string[] {
  return blocks.map((block) => block.kind);
}

function paraText(blocks: ReturnType<typeof parseGuideMarkdown>, at: number): string {
  const block = blocks[at];
  if (block === undefined) throw new Error(`no block ${at}`);
  if (block.kind === "h2" || block.kind === "p") return block.text;
  throw new Error(`block ${at} is not a paragraph`);
}

describe("parseGuideMarkdown", () => {
  test("h2, paragraphs, bullet and numbered lists land as separate blocks", () => {
    const blocks = parseGuideMarkdown(
      "## A heading\n\nIntro line.\n\n- one\n- two\n\n1. first\n2. second\n3. third\n\nClosing line.",
    );
    expect(kinds(blocks)).toEqual(["h2", "p", "ul", "ol", "p"]);
    const ul = blocks[2];
    const ol = blocks[3];
    if (ul.kind !== "ul" || ol.kind !== "ol") throw new Error("wrong block kinds");
    expect(ul.items.map((item) => item.text)).toEqual(["one", "two"]);
    expect(ol.items.map((item) => item.text)).toEqual(["first", "second", "third"]);
  });

  test("adjacent lists of different kinds do not merge", () => {
    const blocks = parseGuideMarkdown("- bullet\n1. numbered\n");
    expect(kinds(blocks)).toEqual(["ul", "ol"]);
  });

  test("blank lines close a list, so each run is its own block", () => {
    const blocks = parseGuideMarkdown("- one\n\n- two\n");
    expect(kinds(blocks)).toEqual(["ul", "ul"]);
    const lists = blocks.filter((block) => block.kind === "ul");
    expect(lists[0]?.kind === "ul" && lists[0]!.items.map((item) => item.text)).toEqual(["one"]);
    expect(lists[1]?.kind === "ul" && lists[1]!.items.map((item) => item.text)).toEqual(["two"]);
  });

  test("bold stays bold, plain text stays plain", () => {
    const blocks = parseGuideMarkdown("This is **Settle** speaking.");
    expect(paraText(blocks, 0)).toBe("This is Settle speaking.");
    const spans = blocks[0].kind === "p" ? blocks[0].spans : [];
    expect(spans[1]).toEqual({ kind: "bold", text: "Settle" });
  });

  test("safe relative and https links become link spans with the legal flags", () => {
    const blocks = parseGuideMarkdown("Read [the FAQ](/faq) and [Meta terms](https://dev.example.com/legal).");
    const links = linksOfBlocks(blocks);
    expect(links.map((link) => link.href)).toEqual(["/faq", "https://dev.example.com/legal"]);
    const spans = blocks[0].kind === "p" ? blocks[0].spans : [];
    const first = spans[1];
    expect(first?.kind === "link" && first.external).toBe(false);
    expect(first?.kind === "link" && first.rel).toBeNull();
    const second = spans[3];
    expect(second?.kind === "link" && second.external).toBe(true);
    expect(second?.kind === "link" && second.rel).toBe("noopener noreferrer");
  });

  test("hostile targets are dropped and the label survives as words", () => {
    // Targets without parentheses or spaces parse as links and then get
    // refused, so only the label text survives.
    for (const target of ["data:text/html,<b>x</b>", "http://settle.example.com", "//evil.test/path", "/\\evil.com"]) {
      const blocks = parseGuideMarkdown(`Click [here](${target}) today.`);
      expect(linksOfBlocks(blocks)).toEqual([]);
      expect(paraText(blocks, 0)).toBe("Click here today.");
      expect(JSON.stringify(blocks)).not.toContain(target);
    }
  });

  test("a target with parentheses never parses as a link at all", () => {
    // javascript:alert(1) cannot fit the link syntax, so the raw words stay as
    // plain text, which React escapes on render. Either way nothing becomes an
    // anchor and no href attribute ever carries the target.
    const line = "Click [here](javascript:alert(1)) today.";
    const blocks = parseGuideMarkdown(line);
    expect(linksOfBlocks(blocks)).toEqual([]);
    expect(paraText(blocks, 0)).toBe(line);
    expect(JSON.stringify(blocks)).not.toContain('"kind":"link"');
  });

  test("the refusal rules come from parseInline unchanged, proven on a hostile target", () => {
    const line = "Click [here](javascript:alert(1)) today.";
    const block = parseGuideMarkdown(line)[0];
    if (block === undefined || block.kind !== "p") throw new Error("expected a paragraph");
    expect(block.spans).toEqual(parseInline(line));
    expect(linksOfBlocks([block])).toEqual([]);
  });

  test("a h1 line is not in the subset and falls through to escaped paragraph text", () => {
    const blocks = parseGuideMarkdown("# Not a heading here");
    expect(kinds(blocks)).toEqual(["p"]);
    expect(paraText(blocks, 0)).toBe("# Not a heading here");
  });

  test("isCtaBlock accepts exactly the trailing call to action", () => {
    expect(isCtaBlock(parseGuideMarkdown(`[${CTA_LABEL}](${CTA_HREF})`)[0])).toBe(true);
    expect(isCtaBlock(parseGuideMarkdown(`[Wrong label](${CTA_HREF})`)[0])).toBe(false);
    expect(isCtaBlock(parseGuideMarkdown(`[${CTA_LABEL}](/elsewhere)`)[0])).toBe(false);
    expect(isCtaBlock(parseGuideMarkdown(`Before. [${CTA_LABEL}](${CTA_HREF})`)[0])).toBe(false);
    expect(isCtaBlock(parseGuideMarkdown("Plain words.")[0])).toBe(false);
    expect(isCtaBlock(undefined)).toBe(false);
  });
});
