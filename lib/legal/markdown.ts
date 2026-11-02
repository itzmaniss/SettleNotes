// A tiny, safe markdown renderer for the legal pages, written by hand on
// purpose: no dependency can grow a feature that turns a legal document into
// an execution surface. Supported constructs: h1, h2, p, ul (lines starting
// with "- "), **bold**, [label](href) links, bare email addresses as mailto
// links, and [[...]] counsel markers as a distinct span. Everything else in a
// line is plain text, and React escapes it on render.

export type LegalSpan =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | {
      kind: "link";
      text: string;
      spans: LegalSpan[];
      href: string;
      external: boolean;
      // External https targets carry this; relative and mailto targets are null.
      rel: string | null;
    }
  | { kind: "marker"; text: string };

export type LegalParagraphBlock = {
  kind: "h1" | "h2" | "p";
  spans: LegalSpan[];
  text: string;
};

export type LegalListItem = { spans: LegalSpan[]; text: string };

export type LegalListBlock = { kind: "ul"; items: LegalListItem[] };

export type LegalBlock = LegalParagraphBlock | LegalListBlock;

// Only these targets ever become anchors. Anything else (javascript:, data:,
// http:, ftp:, or whatever shows up next) renders as plain text and the
// target string is dropped entirely, never echoed into an attribute.
// Refused on top of that: any target carrying a backslash, a space, a tab, a
// newline or any other control character (below 0x20, or 0x7f DEL). A
// backslash is fatal because browsers treat it as a slash, so /\evil.test
// would escape the site exactly like the protocol relative //evil.test.
const BAD_TARGET_RE = /[\u0000-\u001f\u007f\\ ]/;

export function safeLegalHref(href: string): { href: string; external: boolean } | null {
  if (BAD_TARGET_RE.test(href)) return null;
  if (href.startsWith("https://")) return { href, external: true };
  if (href.startsWith("mailto:")) return { href, external: false };
  // A relative path starts with exactly one slash: the second character must
  // be neither another slash (protocol relative) nor a backslash.
  if (href.startsWith("/") && href[1] !== "/" && href[1] !== "\\") return { href, external: false };
  return null;
}

// One alternation walks each line once: marker, link, bold, bare email. The
// bold group captures the inner text only, so group numbers stay fixed.
const INLINE_RE =
  /(\[\[[^\][\n]+\]\])|(\[[^\][\n]+\]\([^()\s]+\))|\*\*([^*\n]+)\*\*|([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;

const LINK_PARTS_RE = /^\[([^\][\n]+)\]\(([^()\s]+)\)$/;
const BOLD_PARTS_RE = /\*\*([^*\n]+)\*\*/g;

// Plain text run between the matches the regex found.
function textSpan(text: string): LegalSpan | null {
  return text.length > 0 ? { kind: "text", text } : null;
}

function parseEmail(email: string): LegalSpan {
  const href = `mailto:${email}`;
  return {
    kind: "link",
    text: email,
    spans: [{ kind: "text", text: email }],
    href,
    external: false,
    rel: null,
  };
}

// Link labels get bold only: links never nest and markers never hide inside
// a label, so `[**word** rest](href)` works and nothing else can.
function parseLabelSpans(label: string): LegalSpan[] {
  const spans: LegalSpan[] = [];
  let cursor = 0;
  for (const match of label.matchAll(BOLD_PARTS_RE)) {
    const at = match.index ?? 0;
    const plain = textSpan(label.slice(cursor, at));
    if (plain) spans.push(plain);
    spans.push({ kind: "bold", text: match[1] });
    cursor = at + match[0].length;
  }
  const tail = textSpan(label.slice(cursor));
  if (tail) spans.push(tail);
  return spans.length > 0 ? spans : [{ kind: "text", text: label }];
}

export function parseInline(text: string): LegalSpan[] {
  const spans: LegalSpan[] = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const at = match.index ?? 0;
    const plain = textSpan(text.slice(cursor, at));
    if (plain) spans.push(plain);
    if (match[1] !== undefined) {
      spans.push({ kind: "marker", text: match[1] });
    } else if (match[2] !== undefined) {
      const parts = LINK_PARTS_RE.exec(match[2]);
      if (parts === null) {
        spans.push({ kind: "text", text: match[2] });
      } else {
        const safe = safeLegalHref(parts[2]);
        if (safe === null) {
          // Refused target: keep the label as plain words, drop the target.
          spans.push({ kind: "text", text: parts[1] });
        } else {
          spans.push({
            kind: "link",
            text: parts[1],
            spans: parseLabelSpans(parts[1]),
            href: safe.href,
            external: safe.external,
            rel: safe.external ? "noopener noreferrer" : null,
          });
        }
      }
    } else if (match[3] !== undefined) {
      spans.push({ kind: "bold", text: match[3] });
    } else if (match[4] !== undefined) {
      spans.push(parseEmail(match[4]));
    }
    cursor = at + match[0].length;
  }
  const tail = textSpan(text.slice(cursor));
  if (tail) spans.push(tail);
  return spans;
}

export function spansText(spans: LegalSpan[]): string {
  return spans.map((span) => span.text).join("");
}

export function parseLegalMarkdown(text: string): LegalBlock[] {
  const blocks: LegalBlock[] = [];
  let list: LegalListBlock | null = null;

  const pushParagraph = (kind: "h1" | "h2" | "p", line: string) => {
    list = null;
    const spans = parseInline(line);
    blocks.push({ kind, spans, text: spansText(spans) });
  };

  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      pushParagraph("h2", line.slice(3));
    } else if (line.startsWith("# ")) {
      pushParagraph("h1", line.slice(2));
    } else if (line.startsWith("- ")) {
      if (list === null) {
        list = { kind: "ul", items: [] };
        blocks.push(list);
      }
      const spans = parseInline(line.slice(2));
      list.items.push({ spans, text: spansText(spans) });
    } else if (line.trim().length === 0) {
      list = null;
    } else {
      pushParagraph("p", line);
    }
  }
  return blocks;
}
