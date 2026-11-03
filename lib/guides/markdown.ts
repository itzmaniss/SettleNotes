// The guide body renderer, extending the legal subset with ordered lists.
// Reuses parseInline, spansText and safeLegalHref from lib/legal/markdown.ts
// unchanged, so links get exactly the same refusal rules as the legal pages
// and there is no second link sanitizer to keep in sync. Supported blocks:
// h2 headings, paragraphs, "- " bullet lists, "1. " numbered lists. Inline:
// **bold** and [label](href) links; everything else is plain text that React
// escapes on render.
import { parseInline, spansText, type LegalSpan } from "@/lib/legal/markdown";

export type GuideSpan = LegalSpan;

export type GuideParagraphBlock = {
  kind: "h2" | "p";
  spans: GuideSpan[];
  text: string;
};

export type GuideListItem = { spans: GuideSpan[]; text: string };

export type GuideListBlock = { kind: "ul" | "ol"; items: GuideListItem[] };

export type GuideBlock = GuideParagraphBlock | GuideListBlock;

const ORDERED_ITEM_RE = /^\d+\. /;

// The call to action every guide and the FAQ end with. The loader removes the
// matching paragraph from the blocks and sets cta to true, so the page can
// render the real BotButton instead of a plain link to /#start.
export const CTA_LABEL = "Open the Settle bot on Telegram";
export const CTA_HREF = "/#start";

// One alternation walks each line: h2, ordered item, bullet item. A "# " line
// is not in the subset (the article has one h1 from the header), so it falls
// through to a paragraph like any other text.
function parseBlockLine(line: string): "h2" | "ol" | "ul" | "p" {
  if (line.startsWith("## ")) return "h2";
  if (ORDERED_ITEM_RE.test(line)) return "ol";
  if (line.startsWith("- ")) return "ul";
  return "p";
}

export function parseGuideMarkdown(text: string): GuideBlock[] {
  const blocks: GuideBlock[] = [];
  let list: GuideListBlock | null = null;

  const closeList = () => {
    list = null;
  };

  const pushParagraph = (kind: "h2" | "p", line: string) => {
    closeList();
    const spans = parseInline(line);
    blocks.push({ kind, spans, text: spansText(spans) });
  };

  for (const line of text.split("\n")) {
    // Blank lines end a list and never become empty paragraphs.
    if (line.trim().length === 0) {
      closeList();
      continue;
    }
    const style = parseBlockLine(line);
    if (style === "h2") {
      pushParagraph("h2", line.slice(3));
    } else if (style === "p") {
      pushParagraph("p", line);
    } else {
      const kind = style;
      // A list continues while items of the same kind follow; the other kind
      // or a paragraph starts a fresh block, so a ul never swallows an ol.
      if (list === null || list.kind !== kind) {
        list = { kind, items: [] };
        blocks.push(list);
      }
      const item = kind === "ul" ? line.slice(2) : line.replace(ORDERED_ITEM_RE, "");
      const spans = parseInline(item);
      list.items.push({ spans, text: spansText(spans) });
    }
  }
  return blocks;
}

// True when the block is exactly the CTA paragraph: one span, a link to
// /#start carrying the expected label. Anything else (extra words around the
// link, a different target) is body text and renders as such.
export function isCtaBlock(block: GuideBlock | undefined): boolean {
  if (block === undefined || block.kind !== "p") return false;
  if (block.spans.length !== 1) return false;
  const only = block.spans[0];
  return only.kind === "link" && only.href === CTA_HREF && only.text === CTA_LABEL;
}

// Link spans of a block tree, innermost first come last: used by the tests to
// check every internal link target.
export function linksOfBlocks(blocks: GuideBlock[]): Array<{ text: string; href: string }> {
  function linksOfSpans(spans: GuideSpan[]): Array<{ text: string; href: string }> {
    const out: Array<{ text: string; href: string }> = [];
    for (const span of spans) {
      if (span.kind === "link") {
        out.push({ text: span.text, href: span.href });
        out.push(...linksOfSpans(span.spans));
      }
    }
    return out;
  }
  const out: Array<{ text: string; href: string }> = [];
  for (const block of blocks) {
    if (block.kind === "ul" || block.kind === "ol") {
      for (const item of block.items) out.push(...linksOfSpans(item.spans));
    } else if (block.kind === "h2" || block.kind === "p") {
      out.push(...linksOfSpans(block.spans));
    }
  }
  return out;
}
